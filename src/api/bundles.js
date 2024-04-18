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
 * @param {PathInfo} path
 * @param {UniversalContext} ctx
 * @returns {Promise<{ rumBundles: RUMBundle[] }>}
 */
async function fetchHourly(path, ctx) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const key = `${path}.json`;
  // ctx.log.debug('fetching bundle key: ', `${path}.json`);
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
 * @param {PathInfo} path
 * @param {UniversalContext} ctx
 * @returns {Promise<any>}
 */
async function fetchDaily(path, ctx) {
  // use all hours, just handle 404s
  const hours = [...Array(24).keys()];

  // fetch all bundles
  let totalEvents = 0;
  let totalBundles = 0;

  const hourlyBundles = await Promise.allSettled(
    hours.map(async (hour) => {
      const hpath = path.clone(undefined, undefined, undefined, hour);
      const data = await fetchHourly(hpath, ctx);
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

  return { rumBundles };
}

/**
 * @param {PathInfo} path
 * @param {UniversalContext} ctx
 * @returns {Promise<any>}
 */
async function fetchMonthly(path, ctx) {
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

  return { rumBundles };
}

/**
 * @param {PathInfo} path
 * @returns {string}
 */
export function getCacheControl(path) {
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
  return `public, max-age=${ttl}`;
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
  if (typeof path.day !== 'number') {
    data = await fetchMonthly(path, ctx);
  } else if (typeof path.hour !== 'number') {
    data = await fetchDaily(path, ctx);
  } else {
    data = await fetchHourly(path, ctx);
  }
  if (!data) {
    return new Response('Not found', { status: 404 });
  }

  return compressBody(
    ctx,
    req,
    JSON.stringify(data),
    {
      'cache-control': getCacheControl(path),
      'surrogate-key': path.surrogateKeys.join(' '),
    },
  );
}
