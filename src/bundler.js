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

import { Response } from '@adobe/fetch';
import processQueue from '@adobe/helix-shared-process-queue';
import { HelixStorage } from './support/storage.js';
import Manifest from './Manifest.js';
import Bundle from './Bundle.js';
import { errorWithResponse } from './util.js';

const BATCH_LIMIT = 10;
const CONCURRENCY_LIMIT = 4;
const PROCESS_ALL = false; // whether to continue processing event log files until directory empty

/**
 * Get yesterday's date
 * @param {number} year
 * @param {number} month
 * @param {number} date
 * @returns {[number: year, number: month, number: date]}
 */
export const yesterday = (year, month, date) => {
  if (date > 1) {
    return [year, month, date - 1];
  }
  if (month > 1) {
    return [year, month - 1, new Date(year, month - 1, 0).getDate()];
  }
  return [year - 1, 12, 31];
};

/**
 * Lock the log bucket to prevent concurrent bundling.
 * If `.lock` file already exists, throw 409 response.
 *
 * @param {UniversalContext} ctx
 * @returns {Promise<void>}
 */
async function lockOrThrow(ctx) {
  const { logBucket } = HelixStorage.fromContext(ctx);
  const head = await logBucket.head('.lock');
  if (head) {
    throw errorWithResponse(409, 'bundling in progress', `bundling started at ${head.LastModified}`);
  }
  await logBucket.put('.lock', '', 'text/plain', undefined, undefined);
}

/**
 * Remove lock file
 * @param {UniversalContext} ctx
 * @returns {Promise<void>}
 */
async function unlock(ctx) {
  const { logBucket } = HelixStorage.fromContext(ctx);
  await logBucket.remove('.lock');
}

/**
 * Process RUM event files into bundles
 * @param {UniversalContext} ctx
 * @returns {Promise<boolean>} whether all files are processed
 */
async function doBundling(ctx) {
  const { log } = ctx;
  const { logBucket } = HelixStorage.fromContext(ctx);

  // list files in log bucket
  const { objects, isTruncated } = await logBucket.list('raw/', { limit: BATCH_LIMIT });
  log.debug(`processing ${objects.length} RUM log files (${isTruncated ? 'more to process' : 'last batch'})`);

  const files = await processQueue(
    objects.filter((o) => !!o.contentType),
    async ({ key }) => {
      const buf = await logBucket.get(key);
      const txt = new TextDecoder('utf8').decode(buf);
      return txt;
    },
    CONCURRENCY_LIMIT,
  );

  // each file is line-delimited JSON objects of events
  const rawEvents = files
    .filter((e) => !!e)
    .reduce((events, txt) => {
      const lines = txt.split('\n');
      lines.forEach((line) => {
        try {
          events.push(JSON.parse(line));
        } catch { /* invalid, ignored */ }
      });
      return events;
    }, []);
  log.info(`processing ${rawEvents.length} RUM events from ${objects.length} files`);
  if (rawEvents.length === 0) {
    return !isTruncated;
  }

  // sort raw event into map (storageKey => event[])
  const rawEventMap = {};
  rawEvents.forEach((event) => {
    try {
      const date = new Date(event.time);
      const url = new URL(event.url);
      // ignore events on loopback that snuck in
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return;
      }

      const domain = url.host;
      const key = `/${domain}/${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCHours()}.json`;
      // log.debug(`storing raw event in key ${key}`);
      if (!rawEventMap[key]) {
        // eslint-disable-next-line no-param-reassign
        rawEventMap[key] = [];
      }
      rawEventMap[key].push(event);
    } catch (e) {
      log.warn('invalid url: ', event.url.toString(), event.id);
    }
  });

  log.debug(`processing ${Object.keys(rawEventMap).length} bundle keys`);
  await processQueue(
    Object.entries(rawEventMap),
    async ([key, events]) => {
      log.debug(`processing ${events.length} events to bundle ${key}`);

      const [domain, ...toParse] = key.slice(1, -'.json'.length).split('/');
      const [year, month, date, hour] = toParse.map((s) => parseInt(s, 10));

      // sort events further by id; same ids get put into a single EventGroup
      /** @type {Record<string, RawRUMEvent[]>} */
      const eventsById = {};
      events.forEach((event) => {
        if (!eventsById[event.id]) {
          eventsById[event.id] = [];
        }
        eventsById[event.id].push(event);
      });

      // get this day's manifest & yesterday's manifest, if needed
      const manifest = await Manifest.fromContext(ctx, domain, year, month, date);
      const yManifest = hour < 23
        ? await Manifest.fromContext(ctx, domain, ...yesterday(year, month, date))
        : undefined;

      // keep track of (possibly) touched bundles
      const bundles = new Set();

      await Promise.all(
        Object.entries(eventsById)
          .map(async ([id, eventGroup]) => {
          // if event exists in a session within last 24h, add it to that session
            let session;
            if (manifest.has(id)) {
              // log.debug('storing event in existing manifest (same day)');
              session = manifest.get(id);
            } else if (yManifest?.has(id)) {
              // log.debug('storing event in existing manifest (previous day)');
              session = undefined;
            }

            const bundle = await Bundle.fromContext(
              ctx,
              domain,
              year,
              month,
              date,
              session ? session.hour : hour,
            );
            bundles.add(bundle);

            eventGroup.forEach((e) => bundle.push(e));
            if (!session) {
              // add to current day's manifest
              manifest.add(id, hour);
            }
          }),
      );

      // save touched manifests and bundles
      await Promise.allSettled([
        manifest.store(),
        yManifest?.store(),
        ...[...bundles].map((b) => b.store()),
      ]);
    },
    CONCURRENCY_LIMIT,
  );

  // move all events into processed folder
  await processQueue(
    objects,
    async ({ key }) => {
      // TODO: uncomment to move files
      log.debug(`NOT moving ${key} to ${key.replace('raw/', 'processed/')}`);
      // await logBucket.move(key, key.replace('raw/', 'processed/'));
    },
    CONCURRENCY_LIMIT,
  );

  return !isTruncated;
}

/**
 * Process RUM event files into bundles
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export async function bundleRUM(ctx) {
  await lockOrThrow(ctx);
  try {
    // repeat bundling until none more to process
    // TODO: set a limit on bundling duration
    let done = false;
    while (!done) {
    // eslint-disable-next-line no-await-in-loop
      done = await doBundling(ctx);
      if (!PROCESS_ALL) break;
    }
  } finally {
    await unlock(ctx);
  }
  return new Response('rum bundled', { status: 200 });
}
