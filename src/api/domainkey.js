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
import { PathInfo } from '../support/PathInfo.js';
import { HelixStorage } from '../support/storage.js';
import { errorWithResponse } from '../support/util.js';
import { purgeSurrogateKey } from '../support/cache.js';
import { setDomainKey, fetchDomainKey } from '../support/domains.js';
import { assertAuthorizedForDomain } from '../support/authorization.js';

/**
 * Update domainkey for domain in storage & runquery.
 * Assumes caller is authorized.
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @param {string} domainkey
 */
async function updateDomainKey(ctx, domain, domainkey) {
  await setDomainKey(ctx, domain, domainkey);
  return new Response('', { status: 204 });
}

/**
 * Rotate domainkey for domain in storage & runquery.
 * Assumes caller is authorized.
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 */
async function rotateDomainKey(ctx, domain) {
  const domainkey = await setDomainKey(ctx, domain);
  return new Response(JSON.stringify({ domainkey }), {
    status: 201,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * Get domainkey for domain.
 * Assumes caller is authorized.
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 */
async function getDomainKey(ctx, domain) {
  const domainkey = await fetchDomainKey(ctx, domain);
  if (domainkey === null) {
    return new Response('not found', { status: 404 });
  }

  if (domainkey === 'revoked') {
    return new Response('not found', {
      status: 404,
      headers: { 'x-error': 'revoked' },
    });
  }

  return new Response(JSON.stringify({ domainkey }), {
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * Remove domainkey for domain.
 * The domain will become publicly accessible.
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 */
async function removeDomainKey(ctx, domain) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  await bundleBucket.put(`/${domain}/.domainkey`, '', 'text/plain', undefined, undefined, false);

  // purge cache
  await purgeSurrogateKey(ctx, domain);

  return new Response('', { status: 204 });
}

/**
 * Handle /domainkey route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  const { domain } = new PathInfo(ctx.pathInfo.suffix);

  if (req.method === 'GET') {
    await assertAuthorizedForDomain(req, ctx, domain, ['domainkeys:read']);
    return getDomainKey(ctx, domain);
  } else {
    await assertAuthorizedForDomain(req, ctx, domain, ['domainkeys:write']);
    if (req.method === 'POST') {
      return rotateDomainKey(ctx, domain);
    } else if (req.method === 'DELETE') {
      return removeDomainKey(ctx, domain);
    } else if (req.method === 'PUT') {
      const { domainkey } = ctx.data;
      if (typeof domainkey !== 'string') {
        throw errorWithResponse(400, 'invalid domainkey');
      }
      return updateDomainKey(ctx, domain, domainkey);
    }
  }
  return new Response('method not allowed', { status: 405 });
}
