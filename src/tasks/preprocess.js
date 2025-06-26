/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * Reads events from the Cloudflare log bucket and writes them to the Fastly/AWS bucket format.
 */

import { Response } from '@adobe/fetch';
import processQueue from '@adobe/helix-shared-process-queue';
import { HelixStorage } from '../support/storage.js';
import { errorWithResponse, getEnvVar } from '../support/util.js';
import { loop } from '../support/loop.js';
import { fetchTopDomains } from '../support/domains.js';

const LOCK_FILE = 'raw/.lock';
const REST_DOMAIN = 'rest';
const NUM_TOP_DOMAINS = 20;
const DEFAULT_BATCH_LIMIT = 1000;
const DEFAULT_CONCURRENCY_LIMIT = 10;
const DEFAULT_DURATION_LIMIT = 9 * 60 * 1000;
// approx the same size as a fastly-sourced log file (~1-2MB)
const DEFAULT_LOG_FILE_SIZE_TARGET = 30 * 1024 * 1024; // 30MB

let TOP_DOMAINS;
/**
 * @param {UniversalContext} ctx
 * @returns {Promise<string[]>}
 */
const getTopDomains = async (ctx) => {
  if (TOP_DOMAINS) {
    return TOP_DOMAINS;
  }
  TOP_DOMAINS = await fetchTopDomains(ctx, NUM_TOP_DOMAINS);
  return TOP_DOMAINS;
};

/**
 * Lock the log/raw folder to prevent concurrent processing.
 * If `raw/.lock` file already exists, throw 409 response.
 *
 * @param {UniversalContext} ctx
 * @returns {Promise<void>}
 */
async function lockOrThrow(ctx) {
  const { logBucket } = HelixStorage.fromContext(ctx);
  const head = await logBucket.head(LOCK_FILE);
  if (head) {
    throw errorWithResponse(409, 'processing in progress', `processing started at ${head.LastModified}`);
  }
  await logBucket.put(LOCK_FILE, '', 'text/plain', undefined, { 'x-invocation-id': ctx.invocation?.id }, undefined);
}

/**
 * Remove lock file
 * @param {UniversalContext} ctx
 * @returns {Promise<void>}
 */
async function unlock(ctx) {
  const { logBucket } = HelixStorage.fromContext(ctx);
  await logBucket.remove(LOCK_FILE);
}

function parseDomain(event) {
  try {
    const { hostname } = new URL(event.url);
    if (hostname.includes('..')) {
      return null;
    }
    if (!hostname.includes('.') && hostname !== 'localhost') {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

/**
 * @param {UniversalContext} ctx
 * @returns {Promise<boolean>}
 */
async function doProcessing(ctx) {
  performance.mark('start:total');
  const now = new Date().toISOString();
  const { log, attributes: { stats } } = ctx;
  const { logBucket } = HelixStorage.fromContext(ctx);
  const concurrency = getEnvVar(ctx, 'CONCURRENCY', DEFAULT_CONCURRENCY_LIMIT, 'integer');
  const batchLimit = getEnvVar(ctx, 'BATCH_LIMIT', DEFAULT_BATCH_LIMIT, 'integer');
  const fileSizeLimit = getEnvVar(ctx, 'LOG_SIZE_TARGET', DEFAULT_LOG_FILE_SIZE_TARGET, 'integer');

  // list files in log bucket
  const { objects, isTruncated } = await logBucket.list('raw/', { limit: batchLimit });
  /* c8 ignore next */
  log.info(`processing ${objects.length} cloudflare log files (${isTruncated ? 'more to process' : 'last batch'})`);

  let discardedFiles = 0;
  let discardedEvents = 0;
  let rawEvents = 0;
  let totalEvents = 0;

  // collect events into top domains and rest
  const topDomains = await getTopDomains(ctx);
  const domainEventMap = new Map(
    [...topDomains, REST_DOMAIN].map((d) => [d, { events: [], estimatedSize: 0 }]),
  );

  // collect events into top domains and rest
  await processQueue(
    objects.filter((o) => !!o.contentType),
    async ({ key }) => {
      const buf = await logBucket.get(key);
      if (!buf) {
        discardedFiles += 1;
        return;
      }
      const txt = new TextDecoder('utf8').decode(buf);
      if (!txt) {
        discardedFiles += 1;
        return;
      }

      // parse all events, drop invalid
      const lines = txt.split('\n');
      rawEvents += lines.length;
      let validEvents = 0;
      lines.forEach((line) => {
        try {
          const event = JSON.parse(line);
          // get domain
          const domain = parseDomain(event.url);
          if (!domain) {
            discardedEvents += 1;
            return;
          }
          if (domainEventMap.has(domain)) {
            domainEventMap.get(domain).events.push(event);
          } else {
            domainEventMap.get(REST_DOMAIN).events.push(event);
            domainEventMap.get(domain).estimatedSize += line.length; // use rough 1byte/char
          }
          validEvents += 1;
        } catch {
          discardedEvents += 1;
        }
      });

      totalEvents += validEvents;
      await logBucket.remove(key);

      // if any domain has more than fileSizeLimit, write to sorted folder
      await Promise.all([...domainEventMap.entries()].map(
        async ([domain, record]) => {
          if (record.estimatedSize > fileSizeLimit) {
            await logBucket.put(`sorted/${domain}/${now}-${crypto.randomUUID()}`, record.events.map((e) => JSON.stringify(e)).join('\n'));
            // eslint-disable-next-line no-param-reassign
            record.events = [];
            // eslint-disable-next-line no-param-reassign
            record.estimatedSize = 0;
          }
        },
      ));
    },
    concurrency,
  );

  // we may still have events leftover, store them if needed
  await Promise.all([...domainEventMap.entries()].map(
    async ([domain, record]) => {
      if (record.events.length) {
        await logBucket.put(`sorted/${domain}/${now}-${crypto.randomUUID()}`, record.events.map((e) => JSON.stringify(e)).join('\n'));
        // eslint-disable-next-line no-param-reassign
        record.events = [];
        // eslint-disable-next-line no-param-reassign
        record.estimatedSize = 0;
      }
    },
  ));

  stats.discardedEvents = discardedEvents;
  stats.discardedFiles = discardedFiles;
  stats.rawEvents = rawEvents;
  stats.totalEvents = totalEvents;
  stats.logFiles = objects.length;

  performance.mark('end:total');
  return !isTruncated;
}

/**
 * Sort events into domain-specific folders for each of the top 10 and a "rest" folder
 *
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function preprocessEvents(ctx) {
  ctx.attributes.start = ctx.attributes.start || new Date();
  const limit = getEnvVar(ctx, 'PREPROCESSOR_LIMIT', DEFAULT_DURATION_LIMIT, 'integer');

  const processor = loop(doProcessing, ctx, { limit });

  await lockOrThrow(ctx);
  try {
    await processor(ctx);
  } finally {
    await unlock(ctx);
  }
  return new Response('events processed', { status: 200 });
}
