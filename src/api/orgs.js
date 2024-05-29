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
import { HelixStorage } from '../support/storage.js';
import { errorWithResponse } from '../support/util.js';
import { assertSuperuserAuthorized } from '../support/authorization.js';

/**
 * @param {UniversalContext} ctx
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function doesOrgExist(ctx, id) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const org = await usersBucket.head(`/orgs/${id}/org.json`);
  return !!org;
}

/**
 * Get domain-orgkey map
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @returns {Promise<Record<string, string>>}
 */
async function getDomainOrgkeyMap(ctx, domain) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const buf = await usersBucket.get(`/domains/${domain}/.orgkeys.json`);
  if (!buf) {
    return {};
  }
  return JSON.parse(new TextDecoder('utf8').decode(buf));
}

/**
 * Store domain-orgkey map
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @param {Record<string, string>} map
 */
async function storeDomainOrgkeyMap(ctx, domain, map) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  await usersBucket.put(`/domains/${domain}/.orgkeys.json`, JSON.stringify(map), 'application/json');
}

/**
 * Sets { [org]: [orgkey] } in `{usersbucket}/domains/{domain}/.orgkeys.json`
 *
 * @param {UniversalContext} ctx
 * @param {string[]} domains
 * @param {string} org
 * @param {string} orgkey
 */
async function addOrgkeyToDomains(ctx, domains, org, orgkey) {
  await Promise.allSettled(
    domains.map(async (domain) => {
      try {
        const orgkeyMap = await getDomainOrgkeyMap(ctx, domain);
        orgkeyMap[org] = orgkey;
        await storeDomainOrgkeyMap(ctx, domain, orgkeyMap);
      } catch (e) {
        ctx.log.error(`failed to add orgkey to domain '${domain}'`, e);
      }
    }),
  );
}

/**
 * Create new org
 *
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function createOrg(req, ctx) {
  assertSuperuserAuthorized(req, ctx);

  const { id, domains = [] } = ctx.data;
  if (typeof id !== 'string') {
    throw errorWithResponse(400, 'invalid id');
  }
  if (!Array.isArray(domains) || domains.find((d) => typeof d !== 'string')) {
    throw errorWithResponse(400, 'invalid domains');
  }
  if (await doesOrgExist(ctx, id)) {
    throw errorWithResponse(409, 'org already exists');
  }

  const orgkey = crypto.randomUUID().toUpperCase();
  const { usersBucket } = HelixStorage.fromContext(ctx);
  await Promise.all([
    usersBucket.put(`/orgs/${id}/.orgkey`, orgkey, 'text/plain'),
    usersBucket.put(`/orgs/${id}/org.json`, JSON.stringify({ domains }), 'application/json'),
    addOrgkeyToDomains(ctx, domains, id, orgkey),
  ]);

  return new Response(JSON.stringify({ orgkey }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function listOrgs(req, ctx) {
  assertSuperuserAuthorized(req, ctx);

  const { usersBucket } = HelixStorage.fromContext(ctx);
  const orgs = (await usersBucket.listFolders('orgs/')).map((o) => o.replace('orgs/', '').slice(0, -1));
  return new Response(JSON.stringify({ orgs }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * Handle /orgs route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  if (req.method === 'POST') {
    return createOrg(req, ctx);
  } else if (req.method === 'GET') {
    return listOrgs(req, ctx);
  }
  return new Response('method not allowed', { status: 405 });
}
