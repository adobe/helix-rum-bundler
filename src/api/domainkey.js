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
import { PathInfo } from '../support/PathInfo.js';
import { HelixStorage } from '../support/storage.js';
import { errorWithResponse, getFetch } from '../util.js';

/**
 * @param {{
*  domain: string;
*  domainkey: string;
* }} param0
* @returns {string}
*/
const runQueryURL = ({
  domain,
  domainkey,
}) => 'https://helix-pages.anywhere.run/helix-services/run-query@v3/rotate-domainkeys?'
+ `url=${domain}&newkey=${domainkey}&note=rumbundler`;

/**
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
function assertAuthorized(req, ctx) {
  // TODO: use admin auth, for now just restrict access to a super user key
  if (!ctx.env.TMP_SUPERUSER_API_KEY) {
    throw errorWithResponse(401, 'no known key to compare', 'TMP_SUPERUSER_API_KEY variable not set');
  }
  const key = req.headers.get('authorization')?.slice(7); // bearer
  if (key !== ctx.env.TMP_SUPERUSER_API_KEY) {
    throw errorWithResponse(403, 'invalid auth');
  }
}

/**
 * update domainkey for domain in storage & runquery
 * assume caller is authorized
 * @param {UniversalContext} ctx
 * @param {string} domain
 */
async function rotateDomainKey(ctx, domain) {
  // generate uuid (uppercase)
  // replace domain key in storage
  // TODO: purge cache of old keys
  const domainkey = crypto.randomUUID().toUpperCase();

  // update storage
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  await bundleBucket.put(`/${domain}/.domainkey`, domainkey, 'text/plain');

  // update runquery
  const fetch = getFetch(ctx);
  const resp = await fetch(runQueryURL({ domain, domainkey }), {
    headers: {
      authorization: `Bearer ${ctx.env.RUNQUERY_ROTATION_KEY}`,
    },
  });
  if (!resp.ok) {
    ctx.log.warn(`failed to rotate domainkey for ${domain}: ${resp.status}`);
  }

  return new Response(JSON.stringify({ domainkey }), {
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * get domainkey for domain
 * assume caller is authorized
 * @param {UniversalContext} ctx
 * @param {string} domain
 */
async function fetchDomainKey(ctx, domain) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  const buf = await bundleBucket.get(`/${domain}/.domainkey`);
  if (!buf) {
    return new Response('not found', { status: 404 });
  }
  const domainkey = new TextDecoder('utf8').decode(buf);
  return new Response(JSON.stringify({ domainkey }), {
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * remove domainkey
 * the associated domain will become publically accessible
 * @param {UniversalContext} ctx
 * @param {string} domain
 */
async function removeDomainKey(ctx, domain) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  await bundleBucket.remove(`/${domain}/.domainkey`);

  return new Response('', { status: 201 });
}

/**
 * Handle /domainkey route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  assertAuthorized(req, ctx);

  const { domain } = new PathInfo(ctx.pathInfo.suffix);
  if (req.method === 'POST') {
    return rotateDomainKey(ctx, domain);
  } else if (req.method === 'GET') {
    return fetchDomainKey(ctx, domain);
  } else if (req.method === 'DELETE') {
    return removeDomainKey(ctx, domain);
  }
  return new Response('method not allowed', { status: 405 });
}
