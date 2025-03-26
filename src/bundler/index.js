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
import { HelixStorage } from '../support/storage.js';
import Manifest from './Manifest.js';
import BundleGroup from './BundleGroup.js';
import {
  errorWithResponse, getEnvVar, yesterday,
} from '../support/util.js';
import { loop } from '../support/loop.js';
import { isNewDomain, setDomainKey } from '../support/domains.js';
import VIRTUAL_DOMAIN_RULES from './virtual.js';

/**
 * @typedef {Record<string, {
 *  events: RawRUMEvent[];
 *  info: BundleInfo;
 * }>} RawEventMap
 */

const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_CONCURRENCY_LIMIT = 4;
const DEFAULT_DURATION_LIMIT = 9 * 60 * 1000;
const KNOWN_VIRTUAL_DOMAINS = VIRTUAL_DOMAIN_RULES.reduce((acc, rule) => {
  if (rule.domain) {
    acc[rule.domain] = true;
  }
  return acc;
}, {});

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
  await logBucket.put('.lock', '', 'text/plain', undefined, { 'x-invocation-id': ctx.invocation?.id }, undefined);
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
 * Add events to bundle groups and manifests.
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
          /** @type {SessionData|undefined} */
          let session;
          /** @type {Manifest|undefined} */
          let sessionManifest;
          if (manifest.has(sId)) {
            session = manifest.get(sId);
            sessionManifest = manifest;
          } else if (yManifest?.has(sId)) {
            session = yManifest.get(sId);
            sessionManifest = yManifest;
          }

          const group = await BundleGroup.fromContext(
            ctx,
            domain,
            sessionManifest?.year ?? year,
            sessionManifest?.month ?? month,
            sessionManifest?.day ?? day,
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
 * @param {boolean} [isVirtual=false]
 */
export async function importEventsByKey(ctx, rawEventMap, isVirtual = false) {
  const { log, attributes: { stats } } = ctx;
  const concurrency = getEnvVar(ctx, 'CONCURRENCY_LIMIT', DEFAULT_CONCURRENCY_LIMIT, 'integer');
  const entries = Object.entries(rawEventMap);
  let totalEvents = 0;

  /**
   * To avoid repeatedly saving the same manifest/bundle files,
   * first we group the key/events pairs by domain, and process
   * each domain as a group. Then persist the touched manifests/bundles
   * of the domain after processing its keys.
   */

  /**
   * NOTE: for imports it's possible to exceed memory limits since all events
   * will be on the same domain. Possibly need to create a limit and push to new
   * groups once that limit is met, like `domain-{n}`.
   *
   * @type {Record<string, [string, {
   *  events: RawRUMEvent[];
   *  info: BundleInfo;
   * }][]>}
   */
  const groupMap = entries.reduce((acc, [key, val]) => {
    const { info, events } = val;
    totalEvents += events.length;
    if (!acc[info.domain]) {
      acc[info.domain] = [];
    }
    acc[info.domain].push([key, val]);
    return acc;
  }, {});
  const groups = Object.values(groupMap);

  stats[`totalEvents${isVirtual ? 'Virtual' : ''}`] = totalEvents;
  stats[`importGroupsCount${isVirtual ? 'Virtual' : ''}`] = groups.length;
  stats[`rawKeys${isVirtual ? 'Virtual' : ''}`] = entries.length;

  log.info(`processing groups: ${groups.length}`);

  await processQueue(groups, async (group) => {
    /** @type {Set<{store: () => Promise<any>}>} */
    const toSave = new Set();

    await processQueue(
      group,
      async ([key, { events, info }]) => {
        log.debug(`processing ${events.length} events to file ${key}`);
        const {
          domain, year, month, day, hour,
        } = info;

        /**
         * Sort events further by session ID, same ids get put into a single EventGroup.
         * NOTE: session ID is different than Event ID:
         *  sessionID == `{event_id}[--{domain}]--{event_url_path}`
         * This leads to sessions with fewer collisions, since sessions are roughly unique per URL.
         */
        /** @type {Record<string, RawRUMEvent[]>} */
        const eventsBySessionId = {};
        events.forEach((event) => {
          // if bundle is virtual, include the domain in the session ID
          // since the events being sorted into this key may have different domains
          const evUrl = new URL(event.url);
          const sessionId = `${event.id}${isVirtual ? `--${evUrl.hostname}` : ''}--${evUrl.pathname}`;
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

        toSave.add(manifest);
        if (yManifest) {
          toSave.add(yManifest);
        }
        touchedBundles.forEach((b) => toSave.add(b));
        log.debug(`toSave now contains ${toSave.size} items`);
      },
      concurrency,
    );

    // save touched manifests and bundles
    await processQueue([...toSave], async (bundle) => {
      try {
        await bundle.store();
      } catch (e) {
        log.warn('failed to store bundle: ', e);
      }
    }, concurrency);
  }, concurrency);
}

/**
 * Get virtual destinations for event, if any.
 *
 * @param {RawRUMEvent} event
 * @param {BundleInfo} info
 * @param {UniversalContext['log'] | Console} log
 * @returns {VirtualDestination[]}
 */
export function getVirtualDestinations(event, info, log) {
  return VIRTUAL_DOMAIN_RULES
    .filter((rule) => {
      try {
        return rule.test(event, info);
      } catch {
        return false;
      }
    })
    .reduce((acc, rule) => {
      try {
        const dest = rule.destination(event, info);
        acc.push(dest);
      } catch (e) {
        log.error('failed to get virtual destination: ', e);
      }
      return acc;
    }, []);
}

/**
 * Sort raw event into map (storageKey => rawEvent[])
 * Also do some initial sanitization, like removing qps from event urls
 *
 * @param {RawRUMEvent[]} rawEvents
 * @param {UniversalContext['log'] | Console} log
 * @returns {{
 *   rawEventMap: RawEventMap;
 *   virtualMap: RawEventMap;
 *   domains: string[]
 * }}
 */
export function sortRawEvents(rawEvents, log) {
  /** @type {RawEventMap} */
  const rawEventMap = {};
  /** @type {RawEventMap} */
  const virtualMap = {};
  /** @type {Set<string>} */
  const domains = new Set();

  // const now = new Date();
  // const dayMs = 1000 * 60 * 60 * 24;

  rawEvents.forEach((pevent) => {
    if (!pevent.url) {
      log.info('ignoring event with invalid data (missing url)');
      return;
    }
    if (typeof pevent.url !== 'string') {
      log.warn('ignoring event with invalid url (non-string): ', typeof pevent.url, pevent.id);
      return;
    }
    if (pevent.url.length > 2048) {
      log.info('ignoring event with invalid url (too long)');
      return;
    }
    if (pevent.url.startsWith('/')) {
      log.info('ignoring event with invalid url (absolute path): ', pevent.url, pevent.id);
      return;
    }

    const event = {
      ...pevent,
    };

    /** @type {URL} */
    let url;
    try {
      url = new URL(event.url);
    } catch {
      log.info('ignoring event with invalid url (non-url): ', event.url, event.id);
      return;
    }

    try {
      if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
        log.info('ignoring event with invalid url (no tld): ', event.url, event.id);
        return;
      }
      if (url.host.includes('..')) {
        log.info('ignoring event with invalid domain (relative): ', event.url, event.id);
        return;
      }
      const date = new Date(event.time);

      // const msDif = Math.abs(Number(date) - Number(now));
      // if (msDif > dayMs) {
      //   log.warn(`date in event differs significantly from current date: (${dayMs}ms)`,
      // JSON.stringify(event, undefined, 2));
      // }

      const domain = url.host;
      domains.add(domain);

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

      const virtualDests = getVirtualDestinations(event, {
        domain, year, month, day, hour,
      }, log);
      virtualDests.forEach((vd) => {
        const { key: vkey, info, event: vevent } = vd;
        if (!virtualMap[vkey]) {
          virtualMap[vkey] = { events: [], info };
        }
        virtualMap[vkey].events.push(vevent || event);
        if (!KNOWN_VIRTUAL_DOMAINS[info.domain]) {
          domains.add(info.domain);
        }
      });
    } catch (e) {
      log.warn('failed to sort raw event: ', e.message, event.url);
    }
  });

  return {
    rawEventMap,
    virtualMap,
    domains: [...domains],
  };
}

/**
 * Process RUM event files into bundles
 * @param {UniversalContext} ctx
 * @returns {Promise<boolean>} whether all files are processed
 */
async function doBundling(ctx) {
  performance.mark('start:total');
  const { log, attributes: { stats } } = ctx;
  const { logBucket } = HelixStorage.fromContext(ctx);
  const concurrency = getEnvVar(ctx, 'CONCURRENCY', DEFAULT_CONCURRENCY_LIMIT, 'integer');
  const batchLimit = getEnvVar(ctx, 'BATCH_LIMIT', DEFAULT_BATCH_LIMIT, 'integer');

  // list files in log bucket
  performance.mark('start:get-logs');
  const { objects, isTruncated } = await logBucket.list('raw/', { limit: batchLimit });
  /* c8 ignore next */
  log.info(`processing ${objects.length} RUM log files (${isTruncated ? 'more to process' : 'last batch'})`);

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
  performance.mark('end:get-logs');

  // each file is line-delimited JSON objects of events
  performance.mark('start:parse-logs');
  const rawEvents = files
    .filter((e) => !!e)
    .reduce((events, txt) => {
      const lines = txt.split('\n');
      lines.forEach((line) => {
        try {
          const event = JSON.parse(line);
          if (event) {
            events.push(event);
          }
        } catch { /* invalid, ignored */ }
      });
      return events;
    }, []);
  performance.mark('end:parse-logs');
  stats.rawEvents = rawEvents.length;
  stats.logFiles = objects.length;

  log.info(`processing ${rawEvents.length} RUM events from ${objects.length} files`);
  if (rawEvents.length === 0) {
    return !isTruncated;
  }

  performance.mark('start:sort-events');
  const { rawEventMap, virtualMap, domains } = sortRawEvents(rawEvents, log);
  performance.mark('end:sort-events');
  stats.domains = domains.length;

  // find all new domains, generate domainkeys for them
  performance.mark('start:create-keys');
  const newDomains = [];
  await processQueue(
    domains,
    async (domain) => {
      if (await isNewDomain(ctx, domain)) {
        log.info(`new domain identified: ${domain}`);
        newDomains.push(domain);
        await setDomainKey(ctx, domain, undefined, false);
      }
    },
    concurrency,
  );
  performance.mark('end:create-keys');
  stats.newDomains = newDomains.length;

  // log.debug(`processing ${Object.keys(rawEventMap).length} bundle keys`);
  performance.mark('start:import-events');
  performance.mark('start:import-virtual');
  await Promise.all([
    importEventsByKey(ctx, rawEventMap).finally(() => performance.mark('end:import-events')),
    importEventsByKey(ctx, virtualMap, true).finally(() => performance.mark('end:import-virtual')),
  ]);

  // move all events into processed folder
  performance.mark('start:move-logs');
  const toRemove = [];
  await processQueue(
    objects,
    async ({ key }) => {
      toRemove.push(key);
      await logBucket.copy(key, key.replace('raw/', 'processed/'));
    },
    concurrency,
  );
  await logBucket.remove(toRemove);
  performance.mark('end:move-logs');

  performance.mark('end:total');
  return !isTruncated;
}

/**
 * Process RUM event files into bundles
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function bundleRUM(ctx) {
  ctx.attributes.start = ctx.attributes.start || new Date();
  const limit = getEnvVar(ctx, 'BUNDLER_DURATION_LIMIT', DEFAULT_DURATION_LIMIT, 'integer');

  const processor = loop(doBundling, ctx, { limit });

  await lockOrThrow(ctx);
  try {
    await processor(ctx);
  } finally {
    await unlock(ctx);
  }
  return new Response('rum bundled', { status: 200 });
}
