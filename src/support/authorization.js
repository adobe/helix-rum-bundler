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

import { getDomainOrgkeyMap } from './orgs.js';
import { HelixStorage } from './storage.js';
import { errorWithResponse } from './util.js';

/**
 * Fetch orgkey for org
 *
 * @param {UniversalContext} ctx
 * @param {string} org
 * @returns {Promise<string|null>}
 */
async function fetchOrgKey(ctx, org) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const buf = await usersBucket.get(`/orgs/${org}/.orgkey`);
  if (!buf) {
    return null;
  }
  return new TextDecoder('utf8').decode(buf);
}

/**
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
export function assertSuperuserAuthorized(req, ctx) {
  if (!ctx.env.TMP_SUPERUSER_API_KEY) {
    throw errorWithResponse(401, 'no known key to compare', 'TMP_SUPERUSER_API_KEY variable not set');
  }
  const key = req.headers.get('authorization')?.slice(7); // bearer
  if (key !== ctx.env.TMP_SUPERUSER_API_KEY) {
    throw errorWithResponse(403, 'invalid auth');
  }
}

/**
 * Asserts that the bearer token is either superuser or org admin.
 * Used for authorizing modifications to orgs that org admins are permitted.
 *
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @param {string} org
 */
export async function assertOrgAdminAuthorized(req, ctx, org) {
  try {
    assertSuperuserAuthorized(req, ctx);
  } catch (e) {
    const actual = req.headers.get('authorization')?.slice(7); // bearer
    if (!actual) {
      throw e;
    }
    const expected = await fetchOrgKey(ctx, org);
    if (!expected) {
      throw errorWithResponse(403, 'no known orgkey to compare', 'orgkey not set');
    }

    if (actual !== expected) {
      throw e;
    }
  }
}

/**
 * Asserts that the bearer token is allowed to CRUD the domainkey for the domain.
 *
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @param {string} domain
 */
export async function assertAuthorizedForDomain(req, ctx, domain) {
  try {
    assertSuperuserAuthorized(req, ctx);
  } catch (e) {
    const actual = req.headers.get('authorization')?.slice(7); // bearer
    if (!actual) {
      throw e;
    }
    const allowedKeys = Object.values(await getDomainOrgkeyMap(ctx, domain));
    if (!allowedKeys.includes(actual)) {
      throw e;
    }
  }
}
