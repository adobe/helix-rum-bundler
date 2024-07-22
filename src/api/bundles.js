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
import {
  calculateDownsample, compressBody, errorWithResponse, fingerprintValue, getFetch,
} from '../support/util.js';
import { HelixStorage } from '../support/storage.js';
import { PathInfo } from '../support/PathInfo.js';
import { fetchDomainKey } from '../support/domains.js';

/**
 * Estimated maximum number events in daily/monthly aggregate responses.
 *
 * - roughly 130B/event uncompressed
 * - final payload size depends on bundle density
 * - gzip gives ~90% reduction
 *
 * 5k events ~= 650KB uncompressed
 */
export const MAX_EVENTS = {
  daily: 5_000,
  monthly: 20_000,
};

/**
 * Optional variant parameter to return different aggregation types.
 * Variants not in this object are ignored.
 */
const VARIANTS = {
  /**
   * cwv biased
   */
  cwv: true,
};

/**
 * @param {UniversalContext} ctx
 * @returns {string|undefined}
 */
function getVariant(ctx) {
  return VARIANTS[ctx.data?.variant] ? ctx.data.variant : undefined;
}

/**
 * @param {UniversalContext} ctx
 * @returns {string}
 */
function getAggregateFilename(ctx) {
  const variant = getVariant(ctx);
  return `aggregate${variant ? `-${variant}` : ''}.json`;
}

/**
 *
 * @param {UniversalContext} ctx
 * @param {RUMBundle[]} bundles
 * @param {number} [reductionFactor]
 * @param {number} [weightFactor]
 * @returns {RUMBundle[]}
 */
function downsampleBundles(ctx, bundles, reductionFactor = 0, weightFactor = 1) {
  if (!reductionFactor || reductionFactor <= 0) {
    return bundles;
  }

  const variant = getVariant(ctx);
  return bundles.reduce((col, b) => {
    if (fingerprintValue(b) > reductionFactor) {
      col.push({
        ...b,
        weight: b.weight * weightFactor,
      });
    } else if (variant === 'cwv') {
      // dont change the weights of bundles that have cwv but should be excluded by downsample
      if (b.events.find((e) => e.checkpoint.startsWith('cwv-'))) {
        col.push(b);
      }
    }
    return col;
  }, []);
}

/**
 * Check domainkey authorization
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @returns {Promise<void>}
 * @throws {ErrorWithResponse} if unauthorized
 */
export async function assertAuthorized(ctx, domain) {
  const actual = ctx.data?.domainkey || '';

  const expected = await fetchDomainKey(ctx, domain);
  if (!expected) {
    // empty means no auth
    if (expected === null) {
      // but missing should be treated as revoked until the key is set
      // don't blindly set the domainkey here, since clients could be requesting
      // a domain that does not have any events. We should ignore those.
      ctx.log.warn(`missing domainkey for ${domain}`);
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

  const key = `${path}/${getAggregateFilename(ctx)}`;
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
  const key = `${prefix}/${getAggregateFilename(ctx)}`;
  const expiration = new Date(Date.now() + ttl);
  ctx.log.info(`storing aggregate for ${prefix} until ${expiration.toISOString()}`);
  await bundleBucket.put(key, data, 'application/json', expiration);
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @returns {Promise<{ rumBundles: RUMBundle[] }>}
 */
export async function fetchHourly(ctx, path) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const key = `${path}.json`;
  const buf = await bundleBucket.get(key);
  if (!buf) {
    return { rumBundles: [] };
  }
  const txt = new TextDecoder('utf8').decode(buf);
  const json = JSON.parse(txt);

  // convert to array of bundles, change weight < 1 to 1
  const rumBundles = Object.values(json.bundles)
    .map((b) => (b.weight < 1 ? { ...b, weight: 1 } : b));
  return { rumBundles };
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @returns {Promise<{ isAggregate: boolean; data: {rumBundles: RUMBundle[]} }>}
 */
async function fetchDaily(ctx, path) {
  const { log } = ctx;
  const aggregate = await fetchAggregate(ctx, path);
  if (aggregate) {
    return { data: aggregate, isAggregate: true };
  }

  // use all hours, just handle 404s
  const hours = [...Array(24).keys()];

  // fetch all bundles
  let totalEvents = 0;
  let totalBundles = 0;

  const hourlyBundles = await Promise.allSettled(
    hours.map(async (hour) => {
      const hpath = path.clone(undefined, undefined, undefined, undefined, hour);
      const data = await fetchHourly(ctx, hpath);
      totalBundles += data.rumBundles.length;
      totalEvents += data.rumBundles.reduce((acc, b) => acc + b.events.length, 0);

      return data;
    }),
  );
  log.info(`total events for ${path.domain} on ${path.month}/${path.day}/${path.year}: `, totalEvents);

  const forceAll = [true, 'true'].includes(ctx.data?.forceAll);
  const maxEvents = forceAll ? Infinity : MAX_EVENTS.daily;
  const { reductionFactor, weightFactor } = calculateDownsample(totalEvents, maxEvents);

  /** @type {RUMBundle[]} */
  const rumBundles = [];
  hourlyBundles.reduce(
    (acc, curr) => {
      if (curr.status === 'rejected') {
        return acc;
      }
      acc.push(
        ...downsampleBundles(
          ctx,
          curr.value.rumBundles,
          reductionFactor,
          weightFactor,
        ),
      );
      return acc;
    },
    rumBundles,
  );
  log.info(`reduced ${totalBundles} daily bundles to ${rumBundles.length} reductionFactor=${reductionFactor} weightFactor=${weightFactor}`);

  // treat forcedAll as aggregate so it doesn't get stored
  return { data: { rumBundles }, isAggregate: forceAll };
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @returns {Promise<{ isAggregate: boolean; data: {rumBundles: RUMBundle[]} }>}
 */
async function fetchMonthly(ctx, path) {
  const { log } = ctx;
  const aggregate = await fetchAggregate(ctx, path);
  if (aggregate) {
    return { data: aggregate, isAggregate: true };
  }

  // @ts-ignore
  const days = [...Array(new Date(path.year, path.month, 0).getDate()).keys()].map((d) => d + 1);

  // fetch all bundles
  let totalEvents = 0;
  let totalBundles = 0;

  const fetch = getFetch(ctx);
  const variant = getVariant(ctx);
  const urlBase = `${ctx.env.CDN_ENDPOINT}/bundles/${path.domain}/${path.year}/${path.month}`;
  const dailyBundles = await Promise.allSettled(
    days.map(async (day) => {
      // fetch from the CDN so that it caches the result
      const resp = await fetch(`${urlBase}/${day}?domainkey=${ctx.data.domainkey}${variant ? `&variant=${variant}` : ''}`);
      /** @type {{rumBundles: RUMBundle[]}} */
      let data;
      if (resp.ok) {
        // @ts-ignore
        data = await resp.json();
      } else {
        data = { rumBundles: [] };
      }
      totalBundles += data.rumBundles.length;
      totalEvents += data.rumBundles.reduce((acc, b) => acc + b.events.length, 0);

      return data;
    }),
  );
  log.info(`total events for ${path.domain} on ${path.month}/${path.year}: `, totalEvents);

  const { reductionFactor, weightFactor } = calculateDownsample(totalEvents, MAX_EVENTS.monthly);

  /** @type {RUMBundle[]} */
  const rumBundles = [];
  dailyBundles.reduce(
    (acc, curr) => {
      if (curr.status === 'rejected') {
        return acc;
      }
      acc.push(
        ...downsampleBundles(
          ctx,
          curr.value.rumBundles,
          reductionFactor,
          weightFactor,
        ),
      );
      return acc;
    },
    rumBundles,
  );
  log.info(`reduced ${totalBundles} monthly bundles to ${rumBundles.length} reductionFactor=${reductionFactor} weightFactor=${weightFactor}`);

  return { data: { rumBundles }, isAggregate: false };
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
    // then within 10mins they should be stable forever
    if (diff > (10 * 60 * 1000)) {
      ttl = 31536000;
    }
  } else if (typeof path.day === 'number') {
    // daily bundles expire every hour until the day elapses in UTC
    // then within 1 hour they should be stable forever
    ttl = 60 * 60; // 1 hour
    if (diff > (24 * 60 * 60 * 1000) + (60 * 60 * 1000)) {
      ttl = 31536000;
    }
  } else if (typeof path.month === 'number') {
    // monthly bundles expire every 12h until the month elapses
    // then within 1 hour they are stable forever
    ttl = 12 * 60 * 60; // 12 hours
    // same threshold as daily, since monthly resource date is the last second of the month
    if (diff > (24 * 60 * 60 * 1000) + (60 * 60 * 1000)) {
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
    // never store hourly aggregates, so pretend it already is one
    isAggregate = true;
    data = await fetchHourly(ctx, info);
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
