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
import {
  calculateDownsample,
  compressBody,
  errorWithResponse,
  getEnvVar,
  getFetch,
  sortKey,
} from '../support/util.js';
import { HelixStorage } from '../support/storage.js';
import { PathInfo } from '../support/PathInfo.js';
import { fetchDomainKey } from '../support/domains.js';

const FANOUT_CONCURRENCY_LIMIT = 15;

const DEFAULT_HOURLY_FILE_MAX_SIZE = 30 * 1024 * 1024; // 30mb

/**
 * Estimated maximum number events in daily/monthly aggregate responses.
 *
 * - roughly 130B/event uncompressed
 * - final payload size depends on bundle density
 * - gzip gives ~90% reduction
 */
const MAX_EVENTS = {
  hourly: 300_000, // ~4mb compressed => 96mb/day (try to avoid downsampling when possible)
  daily: 7_500, // ~50kb compressed => 1.5mb/mo
  monthly: 100_000, // ~700kb compressed => 7.5mb/yr
};

/**
 * Perform downsampling on the given bundles
 *
 * @param {UniversalContext} ctx
 * @param {RUMBundle[]} bundles
 * @param {'hourly'|'daily'|'monthly'} timespan
 * @param {number} [fraction=1.0]
 * @returns {RUMBundle[]}
 */
export function downsample(ctx, bundles, timespan, fraction = 1.0) {
  const { log } = ctx;
  const maxEvents = MAX_EVENTS[timespan] * fraction;
  const totalBundles = bundles.length;
  let totalEvents = 0;

  /** @type {[key: number, bundle: RUMBundle][]} */
  const keyBundlePairs = bundles.map((b) => {
    totalEvents += b.events.length;
    return [sortKey(b), b];
  });

  const { reductionFactor, weightFactor } = calculateDownsample(totalEvents, maxEvents);
  if (reductionFactor <= 0) {
    return bundles;
  }

  const selected = keyBundlePairs
    // sort by key
    .sort(([a], [b]) => a - b)
    // take top N bundles, determined by reductionFactor
    .slice(0, Math.round(keyBundlePairs.length * (1 - reductionFactor)))
    // apply weight factor
    .map(([, b]) => ({
      ...b,
      weight: b.weight * weightFactor,
    }))
    // sort by time
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  log.info(`reduced ${totalBundles} bundles to ${selected.length} using maxEvents=${maxEvents} `
    + `totalEvents=${totalEvents} reductionFactor=${reductionFactor} weightFactor=${weightFactor}`);

  return selected;
}

/**
 * Check domainkey authorization
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @returns {Promise<void>}
 * @throws {ErrorWithResponse} if unauthorized
 */
export async function assertAuthorized(ctx, domain) {
  let actual = ctx.data?.domainkey || '';
  // if there's an admin ident, remove it
  const spl = actual.split('-');
  if (spl.length === 6) {
    actual = spl.slice(0, 5).join('-');
  }

  const expected = await fetchDomainKey(ctx, domain);
  if (!expected) {
    // empty means no auth
    if (expected === null) {
      // but missing should be treated as revoked until the key is set
      // don't blindly set the domainkey here, since clients could be requesting
      // a domain that does not have any events. We should ignore those.
      ctx.log.info(`missing domainkey for ${domain}`);
      throw errorWithResponse(401, 'domainkey not set');
    }
    return;
  }

  // value of `revoked` means the domainkey has been revoked and never served
  if (expected === 'revoked') {
    throw errorWithResponse(401, 'domainkey revoked');
  }

  if (actual !== expected) {
    throw errorWithResponse(403, 'invalid domainkey param');
  }
}

/**
 * fetches aggrate file for the given path, if it exists
 * returns null if not found
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @returns {Promise<{rumBundles: RUMBundle[]} | null>}
 */
export async function fetchAggregate(ctx, path) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const key = `${path}/aggregate.json`;
  const buf = await bundleBucket.get(key);
  if (!buf) {
    return null;
  }
  try {
    const txt = new TextDecoder('utf8').decode(buf);
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @param {string} data
 * @param {number} ttl in ms
 */
export async function storeAggregate(ctx, path, data, ttl) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  const prefix = path.toString();
  const key = `${prefix}/aggregate.json`;
  const expiration = new Date(Date.now() + ttl);
  ctx.log.info(`storing aggregate for ${prefix} until ${expiration.toISOString()}`);
  await bundleBucket.put(key, data, 'application/json', expiration);
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @param {boolean} [forceAll=false] - if true, return all bundles
 * @returns {Promise<{ isAggregate: boolean; data: {rumBundles: RUMBundle[]} }>}
 */
export async function fetchHourly(ctx, path, forceAll = false) {
  const fileSizeLimit = getEnvVar(ctx, 'HOURLY_FILE_MAX_SIZE', DEFAULT_HOURLY_FILE_MAX_SIZE, 'integer');

  // eslint-disable-next-line no-param-reassign
  forceAll = forceAll || [true, 'true'].includes(ctx.data?.forceAll);
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const key = `${path}.json`;
  const buf = await bundleBucket.get(key);
  if (!buf) {
    return { data: { rumBundles: [] }, isAggregate: true };
  }
  const txt = new TextDecoder('utf8').decode(buf);
  // only attempt downsampling if the file is large enough
  if (txt.length < fileSizeLimit || forceAll) {
    const json = JSON.parse(txt);

    // convert to array of bundles, change weight < 1 to 1
    const bundles = Object.values(json.bundles)
      .map((b) => (b.weight < 1 ? { ...b, weight: 1 } : b));
    // always mark as aggregate to avoid storing non-aggregates
    return { data: { rumBundles: bundles }, isAggregate: true };
  }

  const aggregate = await fetchAggregate(ctx, path);
  if (aggregate) {
    return { data: aggregate, isAggregate: true };
  }

  const json = JSON.parse(txt);
  // convert to array of bundles, change weight < 1 to 1
  const bundles = Object.values(json.bundles)
    .map((b) => (b.weight < 1 ? { ...b, weight: 1 } : b));

  const selected = downsample(ctx, bundles, 'hourly');
  // treat forcedAll as aggregate so it doesn't get stored
  return { data: { rumBundles: selected }, isAggregate: forceAll };
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @returns {Promise<{ isAggregate: boolean; data: {rumBundles: RUMBundle[]} }>}
 */
async function fetchDaily(ctx, path) {
  const aggregate = await fetchAggregate(ctx, path);
  if (aggregate) {
    return { data: aggregate, isAggregate: true };
  }

  // use all hours, just handle 404s
  const hours = [...Array(24).keys()];

  /** @type {RUMBundle[]} */
  const bundles = [];
  await processQueue(
    hours,
    async (hour) => {
      const hpath = path.clone(undefined, undefined, undefined, undefined, hour);
      const { data } = await fetchHourly(ctx, hpath, true);
      bundles.push(...data.rumBundles);
    },
    FANOUT_CONCURRENCY_LIMIT,
  );

  const forceAll = [true, 'true'].includes(ctx.data?.forceAll);
  const selected = forceAll ? bundles : downsample(ctx, bundles, 'daily');

  // treat forcedAll as aggregate so it doesn't get stored
  return { data: { rumBundles: selected }, isAggregate: forceAll };
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @returns {Promise<{ isAggregate: boolean; data: {rumBundles: RUMBundle[]} }>}
 */
async function fetchMonthly(ctx, path) {
  const aggregate = await fetchAggregate(ctx, path);
  if (aggregate) {
    return { data: aggregate, isAggregate: true };
  }

  // @ts-ignore
  const days = [...Array(new Date(path.year, path.month, 0).getDate()).keys()].map((d) => d + 1);

  const fetch = getFetch(ctx);
  const urlBase = `${ctx.env.CDN_ENDPOINT}/bundles/${path.domain}/${path.year}/${path.month}`;
  /** @type {RUMBundle[]} */
  const bundles = [];
  await processQueue(
    days,
    async (day) => {
      // fetch from the CDN so that it caches the result
      const resp = await fetch(`${urlBase}/${day}?domainkey=${ctx.data.domainkey}`);
      /** @type {{rumBundles: RUMBundle[]}} */
      let data;
      if (resp.ok) {
        // @ts-ignore
        data = await resp.json();
      } else {
        data = { rumBundles: [] };
      }
      bundles.push(...data.rumBundles);

      return data;
    },
    FANOUT_CONCURRENCY_LIMIT,
  );

  const selected = downsample(ctx, bundles, 'monthly');

  return { data: { rumBundles: selected }, isAggregate: false };
}

/**
 * get TTL of the response in `seconds`
 * @param {PathInfo} path
 * @returns {number}
 */
export function getTTL(path) {
  const now = new Date(); // must be first for tests
  // requested date is the latest possible second in the requested day/hour bundles
  const requested = new Date(
    path.year,
    typeof path.month === 'number' ? (path.month - 1) : 11,
    typeof path.day === 'number' ? path.day : 31,
    typeof path.hour === 'number' ? path.hour : 23,
    59,
    59,
  );
  let ttl = 10 * 60; // 10min
  const diff = Number(now) - Number(requested);
  if (typeof path.hour === 'number') {
    // hourly bundles expire every 10min until the hour elapses
    // then within 3 hours they should be stable forever
    if (diff > (3 * 60 * 60 * 1000)) {
      ttl = 31536000;
    }
  } else if (typeof path.day === 'number') {
    // daily bundles expire every hour until the day elapses in UTC
    // then within 6 hour they should be stable forever
    ttl = 60 * 60; // 1 hour
    if (diff > (24 * 60 * 60 * 1000) + (6 * 60 * 60 * 1000)) {
      ttl = 31536000;
    }
  } else if (typeof path.month === 'number') {
    // monthly bundles expire every 6h until the month elapses
    // then within 12 hour they are stable forever
    ttl = 6 * 60 * 60; // 6 hours
    // same threshold as daily, since monthly resource date is the last second of the month
    if (diff > (24 * 60 * 60 * 1000) + (12 * 60 * 60 * 1000)) {
      ttl = 31536000;
    }
  }
  return ttl;
}

/**
 * Handle /bundles route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  const info = PathInfo.fromContext(ctx);
  await assertAuthorized(ctx, info.domain);

  let data;
  let isAggregate;
  if (typeof info.day !== 'number') {
    ({ data, isAggregate } = await fetchMonthly(ctx, info));
  } else if (typeof info.hour !== 'number') {
    ({ data, isAggregate } = await fetchDaily(ctx, info));
  } else {
    ({ data, isAggregate } = await fetchHourly(ctx, info));
  }
  if (!data) {
    return new Response('Not found', { status: 404 });
  }

  const str = JSON.stringify(data);
  const ttl = getTTL(info);
  if (!isAggregate) {
    await storeAggregate(ctx, info, str, ttl * 1000);
  }

  return compressBody(
    ctx,
    req,
    str,
    {
      // public cache is fine, the domainkey can be cached and is included as cache key
      'cache-control': `public, max-age=${ttl}`,
      'surrogate-key': info.surrogateKeys.join(' '),
    },
  );
}
