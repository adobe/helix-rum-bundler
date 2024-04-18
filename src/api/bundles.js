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
/// <reference path="../types.d.ts" />
// @ts-check

import { Response } from '@adobe/fetch';
import {
  calculateDownsample, compressBody, errorWithResponse, getFetch,
} from '../util.js';
import { HelixStorage } from '../support/storage.js';
import { PathInfo } from '../support/PathInfo.js';

/**
 * rough maximum number events in daily/monthly aggregate responses
 */
const MAX_EVENTS = 25000;

/**
 * Check domainkey authorization
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @returns {Promise<void>}
 * @throws {ErrorWithResponse} if unauthorized
 */
export async function assertAuthorized(ctx, domain) {
  const key = ctx.data?.domainkey;
  if (!key) {
    throw errorWithResponse(401, 'missing domainkey param');
  }

  const { bundleBucket } = HelixStorage.fromContext(ctx);
  const buf = await bundleBucket.get(`/${domain}/.domainkey`);
  if (!buf) {
    // missing means no auth
    return;
  }

  const domainkey = new TextDecoder('utf8').decode(buf);
  if (key !== domainkey) {
    throw errorWithResponse(403, 'invalid domainkey param');
  }
}

/**
 * parse request path
 * throw some x-error response for invalid path 404s for easier debugging
 * @param {string} path
 * @returns {PathInfo}
 * @throws {ErrorWithResponse} if path is invalid
 */
export function parsePath(path) {
  if (!path) {
    throw errorWithResponse(404, 'invalid path');
  }

  try {
    return new PathInfo(path);
  /* c8 ignore next 3 */
  } catch {
    throw errorWithResponse(404, 'invalid path');
  }
}

/**
 * fetches aggrate file for the given path, if it exists
 * returns null if not found
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 */
async function fetchAggregate(ctx, path) {
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
async function storeAggregate(ctx, path, data, ttl) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  const prefix = path.toString();
  const key = `${prefix}/aggregate.json`;
  const expiration = new Date(Date.now() + ttl);
  ctx.log.debug(`storing aggregate for ${prefix} until ${expiration.toISOString()}`);
  await bundleBucket.put(key, data, 'application/json', expiration);
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} path
 * @returns {Promise<{ rumBundles: RUMBundle[] }>}
 */
async function fetchHourly(ctx, path) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const key = `${path}.json`;
  const buf = await bundleBucket.get(key);
  if (!buf) {
    return { rumBundles: [] };
  }
  const txt = new TextDecoder('utf8').decode(buf);
  const json = JSON.parse(txt);

  // convert to array of bundles
  return { rumBundles: Object.values(json.bundles) };
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

  // fetch all bundles
  let totalEvents = 0;
  let totalBundles = 0;

  const hourlyBundles = await Promise.allSettled(
    hours.map(async (hour) => {
      const hpath = path.clone(undefined, undefined, undefined, hour);
      const data = await fetchHourly(ctx, hpath);
      totalBundles += data.rumBundles.length;
      totalEvents += data.rumBundles.reduce((acc, b) => acc + b.events.length, 0);

      return data;
    }),
  );
  ctx.log.info(`total events for ${path.domain} on ${path.month}/${path.day}/${path.year}: `, totalEvents);

  // roughly 130B/event uncompressed, final payload size depends on bundle density
  // gzip gives ~90% reduction; shoot for 5MB before compression as maximum
  // 5M/130B ~= 38K events .. round down to 25K for safety

  const forceAll = [true, 'true'].includes(ctx.data?.forceAll);
  const maxEvents = forceAll ? Infinity : MAX_EVENTS;
  const { reductionFactor, weightFactor } = calculateDownsample(totalEvents, maxEvents);

  /** @type {RUMBundle[]} */
  const rumBundles = [];
  hourlyBundles.reduce(
    (acc, curr) => {
      if (curr.status === 'rejected') {
        return acc;
      }
      acc.push(
        ...curr.value.rumBundles
          .filter(() => (reductionFactor > 0 ? Math.random() > reductionFactor : true))
          .map((b) => ({
            ...b,
            weight: b.weight * weightFactor,
          })),
      );
      return acc;
    },
    rumBundles,
  );
  ctx.log.debug(`reduced ${totalBundles} daily bundles to ${rumBundles.length} reductionFactor=${reductionFactor} weightFactor=${weightFactor}`);

  return { data: { rumBundles }, isAggregate: false };
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

  // fetch all bundles
  let totalEvents = 0;
  let totalBundles = 0;

  const fetch = getFetch(ctx);
  const urlBase = `${ctx.env.CDN_ENDPOINT}/bundles/${path.domain}/${path.year}/${path.month}`;
  const dailyBundles = await Promise.allSettled(
    days.map(async (day) => {
      // fetch from the CDN so that it caches the result
      const resp = await fetch(`${urlBase}/${day}?domainkey=${ctx.data.domainkey}`);
      /** @type {any} */
      let data;
      if (resp.ok) {
        data = await resp.json();
      } else {
        data = { rumBundles: [] };
      }
      totalBundles += data.rumBundles.length;
      totalEvents += data.rumBundles.reduce((acc, b) => acc + b.events.length, 0);

      return data;
    }),
  );
  ctx.log.info(`total events for ${path.domain} on ${path.month}/${path.year}: `, totalEvents);

  const { reductionFactor, weightFactor } = calculateDownsample(totalEvents, MAX_EVENTS);

  /** @type {RUMBundle[]} */
  const rumBundles = [];
  dailyBundles.reduce(
    (acc, curr) => {
      if (curr.status === 'rejected') {
        return acc;
      }
      acc.push(
        ...curr.value.rumBundles
          .filter(() => (reductionFactor > 0 ? Math.random() > reductionFactor : true))
          .map((b) => ({
            ...b,
            weight: b.weight * weightFactor,
          })),
      );
      return acc;
    },
    rumBundles,
  );
  ctx.log.debug(`reduced ${totalBundles} monthly bundles to ${rumBundles.length} reductionFactor=${reductionFactor} weightFactor=${weightFactor}`);

  return { data: { rumBundles }, isAggregate: false };
}

/**
 * get TTL of the response in seconds
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
  let ttl = 10 * 60 * 1000; // 10min
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
    ttl = 60 * 60 * 1000; // 1 hour
    if (diff > (24 * 60 * 60 * 1000) + (60 * 60 * 1000)) {
      ttl = 31536000;
    }
  } else if (typeof path.month === 'number') {
    // monthly bundles expire every 12h until the month elapses
    // then within 1 hour they are stable forever
    ttl = 12 * 60 * 60 * 1000; // 12 hours
    // same threshold as daily, since monthly resource date is the last second of the month
    if (diff > (24 * 60 * 60 * 1000) + (60 * 60 * 1000)) {
      ttl = 31536000;
    }
  }
  // public cache is fine, the domainkey can be cached and is included as cache key
  return ttl;
}

/**
 * Handle /bundles route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  const path = parsePath(ctx.pathInfo.suffix);
  await assertAuthorized(ctx, path.domain);

  let data;
  let isAggregate;
  if (typeof path.day !== 'number') {
    ({ data, isAggregate } = await fetchMonthly(ctx, path));
  } else if (typeof path.hour !== 'number') {
    ({ data, isAggregate } = await fetchDaily(ctx, path));
  } else {
    // never store hourly aggregates, so pretend it already is one
    isAggregate = true;
    data = await fetchHourly(ctx, path);
  }
  if (!data) {
    return new Response('Not found', { status: 404 });
  }

  data = JSON.stringify(data);
  const ttl = getTTL(path);
  if (!isAggregate) {
    await storeAggregate(ctx, path, data, ttl * 1000);
  }

  return compressBody(
    ctx,
    req,
    data,
    {
      'cache-control': `public, max-age=${ttl}`,
      'surrogate-key': path.surrogateKeys.join(' '),
    },
  );
}
