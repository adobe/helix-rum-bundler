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
import { errorWithResponse } from './util.js';
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
  if (!path || !path.endsWith('.json')) {
    throw errorWithResponse(404, 'invalid path (wrong extension)');
  }

  const segments = path.split('/').slice(1);
  // minimum path `/domain/year.json`
  if (segments.length < 2) {
    throw errorWithResponse(404, 'invalid path (short)');
  }
  // maximum path `/domain/year/month/day/hour.json`
  if (segments.length > 5) {
    throw errorWithResponse(404, 'invalid path (long)');
  }

  const [domain, pyear, pmonth, pday, phour] = segments;
  /** @type {ParsedPath} */
  const parsed = {
    domain,
    toString() {
      const parts = ['', this.domain, this.year, this.month, this.day, this.hour];
      return parts.filter((p) => p !== undefined).join('/');
    },
  };

  try {
    parsed.year = parseInt(pyear, 10);
    if (pmonth) {
      parsed.month = parseInt(pmonth, 10);
    }
    if (pday) {
      parsed.day = parseInt(pday, 10);
    }
    if (phour) {
      parsed.hour = parseInt(phour.slice(0, -'.json'.length), 10);
    }
  } catch {
    throw errorWithResponse(404, 'invalid path');
  }
  return parsed;
}

/**
 * @param {ParsedPath} path
 * @param {UniversalContext} ctx
 * @returns {Promise<any>}
 */
async function fetchHourly(path, ctx) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const key = `${path}.json`;
  // ctx.log.debug('fetching bundle key: ', `${path}.json`);
  const buf = await bundleBucket.get(key);
  if (!buf) {
    return undefined;
  }
  const txt = new TextDecoder('utf8').decode(buf);
  const json = JSON.parse(txt);

  // convert to array of bundles
  return { rumBundles: Object.values(json.groups) };
}

/**
 * Respond to HTTP request
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
// eslint-disable-next-line no-unused-vars
export async function handleRequest(req, ctx) {
  assertAuthorization(req, ctx);

  const parsed = parsePath(ctx.pathInfo.suffix);

  // TODO: handle other request levels, but for now just support hourly
  if (typeof parsed.hour !== 'number') {
    return new Response('Not found', { status: 404 });
  }
  const data = await fetchHourly(parsed, ctx);
  if (!data) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
