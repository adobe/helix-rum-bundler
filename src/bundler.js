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

const BATCH_LIMIT = 2;
const CONCURRENCY_LIMIT = 10;

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
 * Process RUM event files into bundles
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export async function bundleRUM(ctx) {
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
    return new Response('no new events');
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
      await Promise.all([
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

  return new Response('rum bundled');
}
