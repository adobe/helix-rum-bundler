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
/// <reference path="./types.d.ts" />
// @ts-check

import { Response } from '@adobe/fetch';
import processQueue from '@adobe/helix-shared-process-queue';
import { HelixStorage } from './support/storage.js';
import Manifest from './Manifest.js';
import BundleGroup from './BundleGroup.js';
import {
  errorWithResponse, getEnvVar, timeout, yesterday,
} from './util.js';

/**
 * @typedef {Record<string, {
 *  events: RawRUMEvent[];
 *  info: BundleInfo;
 * }>} RawEventMap
 */

const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_CONCURRENCY_LIMIT = 4;

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
 *
 * @param {UniversalContext} ctx
 * @param {Record<string, RawRUMEvent[]>} eventsBySessionId {sessionID => [event]}
 * @param {Manifest} manifest
 * @param {Manifest} [yManifest]
 * @param {BundleInfo} info
 * @return {Promise<BundleGroup[]>} touched bundle groups
 */
async function addEventsToBundle(ctx, info, eventsBySessionId, manifest, yManifest) {
  const { log } = ctx;
  const {
    domain, year, month, day, hour,
  } = info;

  // keep track of (possibly) touched bundle groups
  const groups = new Set();

  await Promise.all(
    Object.entries(eventsBySessionId)
      .map(async ([sId, events]) => {
        // log.debug(`processing ${events.length} events to bundle ${sId}`);

        try {
          // if event exists in a session within last 24h, add it to that session
          let session;
          if (manifest.has(sId)) {
          // log.debug('storing event in existing manifest (same day)');
            session = manifest.get(sId);
          } else if (yManifest?.has(sId)) {
          // log.debug('storing event in existing manifest (previous day)');
            session = yManifest.get(sId);
          }

          const group = await BundleGroup.fromContext(
            ctx,
            domain,
            year,
            month,
            day,
            session ? session.hour : hour,
          );
          groups.add(group);

          events.forEach((e) => group.push(sId, e));
          // if no session existing, add it
          if (!session) {
          // add to current day's manifest
            manifest.add(sId, hour);
          }
        } catch (e) {
          log.error('error adding event to bundlegroup: ', e);
        }
      }),
  );
  return [...groups];
}

/**
 * Import a set of RUM events into bundles & manifests.
 *
 * @param {UniversalContext} ctx
 * @param {RawEventMap} rawEventMap
 */
export async function importEventsByKey(ctx, rawEventMap) {
  const { log } = ctx;
  const concurrency = getEnvVar(ctx, 'CONCURRENCY_LIMIT', DEFAULT_CONCURRENCY_LIMIT, 'integer');

  await processQueue(
    Object.entries(rawEventMap),
    async ([key, { events, info }]) => {
      log.debug(`processing ${events.length} events to file ${key}`);
      const {
        domain, year, month, day, hour,
      } = info;

      /**
       * Sort events further by session ID, same ids get put into a single EventGroup.
       * NOTE: session ID is different than Event ID: sessionID == `{event_id}--{event_url_path}`
       * This leads to sessions with fewer collisions, since sessions are roughly unique per URL.
       */
      /** @type {Record<string, RawRUMEvent[]>} */
      const eventsBySessionId = {};
      events.forEach((event) => {
        const sessionId = `${event.id}--${new URL(event.url).pathname}`;
        if (!eventsBySessionId[sessionId]) {
          eventsBySessionId[sessionId] = [];
        }
        eventsBySessionId[sessionId].push(event);
      });

      // get this day's manifest & yesterday's manifest, if needed
      const manifest = await Manifest.fromContext(ctx, domain, year, month, day);
      const yManifest = hour < 23
        ? await Manifest.fromContext(ctx, domain, ...yesterday(year, month, day))
        : undefined;

      const touchedBundles = await addEventsToBundle(
        ctx,
        info,
        eventsBySessionId,
        manifest,
        yManifest,
      );

      // save touched manifests and bundles
      await Promise.allSettled([
        manifest.store(),
        yManifest?.store(),
        ...touchedBundles.map((b) => b.store()),
      ]);
    },
    concurrency,
  );
}

/**
 * Sort raw event into map (storageKey => rawEvent[])
 * Also do some initial sanitization, like removing qps from event urls
 *
 * @param {RawRUMEvent[]} rawEvents
 * @param {UniversalContext['log'] | Console} log
 * @returns {RawEventMap}
 */
export function sortRawEvents(rawEvents, log) {
  /** @type {Record<string, {events: RawRUMEvent[]; info: BundleInfo}>} */
  const rawEventMap = {};

  rawEvents.forEach((pevent) => {
    if (pevent.url.startsWith('/')) {
      log.info('ignoring event with invalid url (absolute path): ', pevent);
      return;
    }

    const event = {
      ...pevent,
    };
    try {
      const date = new Date(event.time);
      const url = new URL(event.url);
      const domain = url.host;

      // remove query/search params
      url.search = '';
      url.hash = '';
      event.url = url.toString();

      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      const hour = date.getUTCHours();

      const key = `/${domain}/${year}/${month}/${day}/${hour}.json`;
      if (!rawEventMap[key]) {
        const info = {
          domain, year, month, day, hour,
        };
        rawEventMap[key] = { events: [], info };
      }
      rawEventMap[key].events.push(event);
    } catch (e) {
      log.warn('invalid url: ', event.url, event.id);
    }
  });

  return rawEventMap;
}

/**
 * Process RUM event files into bundles
 * @param {UniversalContext} ctx
 * @returns {Promise<boolean>} whether all files are processed
 */
async function doBundling(ctx) {
  const { log } = ctx;
  const { logBucket } = HelixStorage.fromContext(ctx);
  const concurrency = getEnvVar(ctx, 'CONCURRENCY', DEFAULT_CONCURRENCY_LIMIT, 'integer');
  const batchLimit = getEnvVar(ctx, 'BATCH_LIMIT', DEFAULT_BATCH_LIMIT, 'integer');

  // list files in log bucket
  const { objects, isTruncated } = await logBucket.list('raw/', { limit: batchLimit });
  log.debug(`processing ${objects.length} RUM log files (${isTruncated ? 'more to process' : 'last batch'})`);

  const files = await processQueue(
    objects.filter((o) => !!o.contentType),
    async ({ key }) => {
      const buf = await logBucket.get(key);
      if (!buf) {
        return '';
      }
      const txt = new TextDecoder('utf8').decode(buf);
      return txt;
    },
    concurrency,
  );

  // each file is line-delimited JSON objects of events
  const rawEvents = files
    .filter((e) => !!e)
    .reduce((events, txt) => {
      const lines = txt.split('\n');
      lines.forEach((line) => {
        try {
          // @ts-ignore
          events.push(JSON.parse(line));
        } catch { /* invalid, ignored */ }
      });
      return events;
    }, []);
  log.info(`processing ${rawEvents.length} RUM events from ${objects.length} files`);
  if (rawEvents.length === 0) {
    return !isTruncated;
  }

  const rawEventMap = sortRawEvents(rawEvents, log);

  log.debug(`processing ${Object.keys(rawEventMap).length} bundle keys`);
  await importEventsByKey(ctx, rawEventMap);

  // move all events into processed folder
  await processQueue(
    objects,
    async ({ key }) => {
      // log.debug(`moving ${key} to ${key.replace('raw/', 'processed/')}`);
      await logBucket.move(key, key.replace('raw/', 'processed/'));
    },
    concurrency,
  );

  return !isTruncated;
}

/**
 * Process RUM event files into bundles
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function bundleRUM(ctx) {
  const { env: { BUNDLER_DURATION_LIMIT } } = ctx;
  const limit = parseInt(BUNDLER_DURATION_LIMIT || String(9 * 60 * 1000), 10);

  const processor = timeout(doBundling, { limit });

  await lockOrThrow(ctx);
  try {
    await processor(ctx);
  } finally {
    await unlock(ctx);
  }
  return new Response('rum bundled', { status: 200 });
}