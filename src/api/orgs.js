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
import {
  doesOrgExist, getOrgkey, getDomainOrgkeyMap, storeDomainOrgkeyMap,
  storeOrg,
  getOrg,
} from '../support/orgs.js';
import { PathInfo } from '../support/PathInfo.js';

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
        /* c8 ignore next 3 */
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
    storeOrg(ctx, id, { domains }),
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
  const folders = await usersBucket.listFolders('orgs/');
  const orgs = folders.map((o) => o.replace('orgs/', '').slice(0, -1));
  return new Response(JSON.stringify({ orgs }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function updateOrg(req, ctx, info) {
  assertSuperuserAuthorized(req, ctx);

  const { org: id } = info;
  const { domains = [] } = ctx.data;

  if (!Array.isArray(domains) || domains.find((d) => typeof d !== 'string')) {
    throw errorWithResponse(400, 'invalid domains');
  }

  const org = await getOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }

  const orgkey = await getOrgkey(ctx, id);
  if (!orgkey) {
    ctx.log.warn(`orgkey not defined for org ${id}`);
    throw errorWithResponse(400, 'orgkey not defined');
  }

  const newDomains = [];
  const existing = new Set(org.domains);
  domains.forEach((domain) => {
    if (!existing.has(domain)) {
      newDomains.push(domain);
    }
  });
  org.domains = [...existing, ...newDomains];
  await Promise.all([
    storeOrg(ctx, id, org),
    addOrgkeyToDomains(ctx, newDomains, id, orgkey),
  ]);
  return new Response(JSON.stringify(org), {
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
    const info = PathInfo.fromContext(ctx);
    if (info.org) {
      return updateOrg(req, ctx, info);
    }
    return createOrg(req, ctx);
  } else if (req.method === 'GET') {
    return listOrgs(req, ctx);
  }
  return new Response('method not allowed', { status: 405 });
}
