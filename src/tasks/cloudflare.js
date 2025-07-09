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

const DEFAULT_BATCH_LIMIT = 1000;
const DEFAULT_CONCURRENCY_LIMIT = 10;
const DEFAULT_DURATION_LIMIT = 9 * 60 * 1000;
// approx the same size as a fastly-sourced log file (~1.5MB)
const DEFAULT_LOG_FILE_SIZE_TARGET = 1.5 * 1024 * 1024;

/**
 * Lock the log bucket to prevent concurrent processing.
 * If `.lock` file already exists, throw 409 response.
 *
 * @param {UniversalContext} ctx
 * @returns {Promise<void>}
 */
async function lockOrThrow(ctx) {
  const { cloudflareLogBucket } = HelixStorage.fromContext(ctx);
  const head = await cloudflareLogBucket.head('.lock');
  if (head) {
    throw errorWithResponse(409, 'processing in progress', `processing started at ${head.LastModified}`);
  }
  await cloudflareLogBucket.put('.lock', '', 'text/plain', undefined, { 'x-invocation-id': ctx.invocation?.id }, undefined);
}

/**
 * Remove lock file
 * @param {UniversalContext} ctx
 * @returns {Promise<void>}
 */
async function unlock(ctx) {
  const { cloudflareLogBucket } = HelixStorage.fromContext(ctx);
  await cloudflareLogBucket.remove('.lock');
}

/**
 * convert cloudflare logging format into rum event
 * @param {UniversalContext} ctx
 * @param {{
 *  ScriptName: string;
 *  Logs: {
 *    Level: string;
 *    Message: string[];
 *    TimestampMs: number;
 *  }[];
 * }} ev
 */
export function adaptCloudflareEvent(ctx, ev) {
  try {
    // the log ordering may change, so find the first message that looks like a JSON string
    const msg = ev.Logs.find(
      ({ Message: [txt] }) => {
        if (!txt.startsWith('{"') || !txt.includes('checkpoint')) {
          return false;
        }
        if (txt.includes('<<<Logpush: message truncated>>>')) {
          ctx.log.info('cloudflare event message truncated');
          return false;
        }
        return true;
      },
    )?.Message[0];

    if (!msg) {
      ctx.log.debug('no JSON message found in cloudflare event');
      return null;
    }

    const parsed = JSON.parse(msg);
    // check that the cloudflare event has all required properties
    if (parsed.url == null || parsed.time == null || parsed.id == null) {
      ctx.log.info('missing required properties in cloudflare event');
      return null;
    }
    return parsed;
  } catch (e) {
    ctx.log.warn('failed to parse cloudflare event JSON');
    return null;
  }
}

/**
 * Make the key sort properly into the list of existing events.
 *
 * Cloudflare keys are in the format of `raw/20240101/20240101T...`
 * we want to move them to `raw/2024-01-01T00...`, where date and hour
 * is enough to be sorted properly.
 * @param {string} key
 * @returns {string}
 */
function getNewKey(key) {
  let newKey = key.split('/').pop();
  newKey = `raw/${newKey.slice(0, 4)}-${newKey.slice(4, 6)}-${newKey.slice(6, 11)}:${newKey.slice(11, 13)}:${newKey.slice(13)}`;
  return newKey;
}

/**
 * @param {UniversalContext} ctx
 * @returns {Promise<boolean>}
 */
async function doProcessing(ctx) {
  performance.mark('start:total');
  const { log, attributes: { stats } } = ctx;
  const { cloudflareLogBucket, logBucket } = HelixStorage.fromContext(ctx);
  const concurrency = getEnvVar(ctx, 'CONCURRENCY', DEFAULT_CONCURRENCY_LIMIT, 'integer');
  const batchLimit = getEnvVar(ctx, 'BATCH_LIMIT', DEFAULT_BATCH_LIMIT, 'integer');
  const fileSizeLimit = getEnvVar(ctx, 'CF_LOG_SIZE_TARGET', DEFAULT_LOG_FILE_SIZE_TARGET, 'integer');

  // list files in log bucket
  const { objects, isTruncated } = await cloudflareLogBucket.list('raw/', { limit: batchLimit });
  /* c8 ignore next */
  log.info(`processing ${objects.length} cloudflare log files (${isTruncated ? 'more to process' : 'last batch'})`);

  let discardedFiles = 0;
  let discardedEvents = 0;
  let rawEvents = 0;
  let totalEvents = 0;

  // collect events until we reach the expected file size
  let events = [];
  let estimatedSize = 0;
  let lastKey = '';
  await processQueue(
    objects.filter((o) => !!o.contentType),
    async ({ key }) => {
      const buf = await cloudflareLogBucket.get(key);
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
      lines.forEach((line) => {
        try {
          const event = adaptCloudflareEvent(ctx, JSON.parse(line));
          if (event) {
            events.push(event);
            estimatedSize += line.length; // use rough 1byte/char
          } else {
            discardedEvents += 1;
          }
        } catch {
          discardedEvents += 1;
        }
      });

      totalEvents += events.length;
      lastKey = key;
      await cloudflareLogBucket.remove(key);

      if (estimatedSize < fileSizeLimit) {
        return;
      }

      // combine events back into single line-delimited file & move to main bucket
      const combined = events.map((e) => JSON.stringify(e)).join('\n');
      estimatedSize = 0;
      events = [];
      await logBucket.put(getNewKey(key), combined);
    },
    concurrency,
  );

  // we may still have events leftover, store them in a single file if needed
  if (events.length) {
    const combined = events.map((e) => JSON.stringify(e)).join('\n');
    await logBucket.put(getNewKey(lastKey), combined);
    events = [];
  }

  stats.discardedEvents = discardedEvents;
  stats.discardedFiles = discardedFiles;
  stats.rawEvents = rawEvents;
  stats.totalEvents = totalEvents;
  stats.logFiles = objects.length;

  performance.mark('end:total');
  return !isTruncated;
}

/**
 * Process events from Cloudflare collector to the Fastly/AWS bucket format.
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function processCloudflareEvents(ctx) {
  ctx.attributes.start = ctx.attributes.start || new Date();
  const limit = getEnvVar(ctx, 'CLOUDFLARE_PROCESSOR_LIMIT', DEFAULT_DURATION_LIMIT, 'integer');

  const processor = loop(doProcessing, ctx, { limit });

  await lockOrThrow(ctx);
  try {
    await processor(ctx);
  } finally {
    await unlock(ctx);
  }
  return new Response('events processed', { status: 200 });
}
