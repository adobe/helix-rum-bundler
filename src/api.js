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
import { compressBody, errorWithResponse } from './util.js';
import { HelixStorage } from './support/storage.js';

/**
 * @typedef {{
 *  domain: string;
 *  year: number;
 *  month?: number;
 *  day?: number;
 *  hour?: number;
 *  toString(): string;
 * }} ParsedPath
 */

/**
 * Check domainkey authorization
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {void}
 * @throws {ErrorWithResponse} if unauthorized
 */
export function assertAuthorization(req, ctx) {
  // TODO: use domainkeys for auth, for now just restrict access to a super user key
  if (!ctx.env.TMP_SUPERUSER_API_KEY) {
    throw errorWithResponse(401, 'no known key to compare', 'TMP_SUPERUSER_API_KEY variable not set');
  }

  const key = req.headers.get('x-api-key') || ctx.data?.domainkey;
  if (!key) {
    throw errorWithResponse(401, 'missing x-api-key');
  }
  if (key !== ctx.env.TMP_SUPERUSER_API_KEY) {
    throw errorWithResponse(403, 'invalid x-api-key');
  }
}

/**
 * parse request path
 * throw some x-error response for invalid path 404s for easier debugging
 * @param {string} path
 * @returns {ParsedPath}
 * @throws {ErrorWithResponse} if path is invalid
 */
export function parsePath(path) {
  if (!path) {
    throw errorWithResponse(404, 'invalid path');
  }
  if (!path.endsWith('.json')) {
    // eslint-disable-next-line no-param-reassign
    path += '.json';
  }

  const segments = path.slice(0, -'.json'.length).split('/').slice(1);
  // minimum path `/domain/year.json`
  if (segments.length < 2) {
    throw errorWithResponse(404, 'invalid path (short)');
  }
  // maximum path `/domain/year/month/day/hour.json`
  if (segments.length > 5) {
    throw errorWithResponse(404, 'invalid path (long)');
  }

  const [domain, pyear, pmonth, pday, phour] = segments;
  try {
    /** @type {ParsedPath} */
    const parsed = {
      domain,
      year: parseInt(pyear, 10),
      toString() {
        const parts = ['', this.domain, this.year, this.month, this.day, this.hour];
        return parts.filter((p) => p !== undefined).join('/');
      },
    };

    if (pmonth) {
      parsed.month = parseInt(pmonth, 10);
    }
    if (pday) {
      parsed.day = parseInt(pday, 10);
    }
    if (phour) {
      parsed.hour = parseInt(phour, 10);
    }
    return parsed;
  /* c8 ignore next 3 */
  } catch {
    throw errorWithResponse(404, 'invalid path');
  }
}

/**
 * @param {ParsedPath} path
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
 * @param {ParsedPath} path
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
      // eslint-disable-next-line no-param-reassign
      path.hour = hour;
      const data = await fetchHourly(path, ctx);
      totalBundles += data.rumBundles.length;
      totalEvents += data.rumBundles.reduce((acc, b) => acc + b.events.length, 0);

      return data;
    }),
  );
  ctx.log.info(`total events for ${path.domain} on ${path.month}/${path.day}/${path.year}: `, totalEvents);

  // roughly 3.5k events fit in 10MB, depending on bundle density
  // TODO: make this deterministic
  // TODO: adjust bundle weight according to event counts
  // TODO: parameterize the maximum events

  // const maxEvents = 1000;
  // const avgEventsPerBundle = totalEvents / totalBundles;
  // const maxBundles = totalBundles * (totalEvents / avgEventsPerBundle);
  const maxBundles = ctx.data.forceAll ? Infinity : 1000;
  const bundleReductionFactor = (totalBundles - maxBundles) / totalBundles;
  const bundleWeightFactor = totalBundles > maxBundles ? 1 / (maxBundles / totalBundles) : 1;

  /** @type {RUMBundle[]} */
  const rumBundles = [];
  hourlyBundles.reduce(
    (acc, curr) => {
      if (curr.status === 'rejected') {
        return acc;
      }
      acc.push(
        ...curr.value.rumBundles
          .filter(() => (bundleReductionFactor < 1 ? Math.random() > bundleReductionFactor : true))
          .map((b) => ({
            ...b,
            weight: b.weight * bundleWeightFactor,
          })),
      );
      return acc;
    },
    rumBundles,
  );
  ctx.log.debug(`reduced ${totalBundles} bundles to ${rumBundles.length} reductionFactor=${bundleReductionFactor} weightFactor=${bundleWeightFactor}`);

  return { rumBundles };
}

/**
 * @param {ParsedPath} path
 * @returns {string}
 */
export function getCacheControl(path) {
  const now = new Date(); // must be first for tests
  // requested date is the latest possible second in the requested day/hour bundles
  const requested = new Date(
    path.year,
    path.month ? (path.month - 1) : 11,
    path.day || 31,
    path.hour || 24,
  );
  let ttl = 10 * 60 * 1000; // 10min
  const diff = Number(now) - Number(requested);
  if (typeof path.hour === 'number') {
    // hourly bundles expire every 10min until the hour elapses
    // then within 10mins they should be stable forever
    if (diff > (60 * 60 * 1000) + (10 * 60 * 1000)) {
      ttl = 31536000;
    }
  } else if (typeof path.day === 'number') {
    // daily bundles expire every hour until the day elapses in UTC
    // then within 1 hour they should be stable forever
    ttl = 60 * 60 * 1000; // 1 hour
    if (diff > (24 * 60 * 60 * 1000) + (60 * 60 * 1000)) {
      ttl = 31536000;
    }
  }
  // public cache is fine, the domainkey can be cached and is included as cache key
  return `public, max-age=${ttl}`;
}

/**
 * Respond to HTTP request
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
// eslint-disable-next-line no-unused-vars
export default async function handleRequest(req, ctx) {
  assertAuthorization(req, ctx);

  const parsed = parsePath(ctx.pathInfo.suffix);

  // TODO: handle other request levels, but for now just support hourly/daily
  if (typeof parsed.day !== 'number') {
    throw errorWithResponse(501, 'not implemented');
  }

  let data;
  if (typeof parsed.hour !== 'number') {
    data = await fetchDaily(parsed, ctx);
  } else {
    data = await fetchHourly(parsed, ctx);
  }
  if (!data) {
    return new Response('Not found', { status: 404 });
  }

  return compressBody(req, JSON.stringify(data), { 'cache-control': getCacheControl(parsed) });
}
