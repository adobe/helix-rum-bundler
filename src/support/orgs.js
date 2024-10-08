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

import { HelixStorage } from './storage.js';

/**
 * @param {UniversalContext} ctx
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function doesOrgExist(ctx, id) {
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
export async function getDomainOrgkeyMap(ctx, domain) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const buf = await usersBucket.get(`/domains/${domain}/.orgkeys.json`);
  if (!buf) {
    return {};
  }
  return JSON.parse(new TextDecoder('utf8').decode(buf));
}

/**
 * Get orgkey for org
 *
 * @param {UniversalContext} ctx
 * @param {string} org
 * @returns {Promise<string|null>}
 */
export async function retrieveOrgkey(ctx, org) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const buf = await usersBucket.get(`/orgs/${org}/.orgkey`);
  if (!buf) {
    return null;
  }
  return new TextDecoder('utf8').decode(buf);
}

/**
 * Store orgkey for org
 *
 * @param {UniversalContext} ctx
 * @param {string} org
 * @param {string} orgkey
 */
export async function storeOrgkey(ctx, org, orgkey) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  await usersBucket.put(`/orgs/${org}/.orgkey`, orgkey, 'text/plain');
}

/**
 * @param {UniversalContext} ctx
 * @param {string} org
 * @returns {Promise<OrgData | null>}
 */
export async function retrieveOrg(ctx, org) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const data = await usersBucket.get(`/orgs/${org}/org.json`);
  if (!data) {
    return null;
  }

  return JSON.parse(new TextDecoder('utf8').decode(data));
}

/**
 * @param {UniversalContext} ctx
 * @param {string} org
 * @param {OrgData} data
 * @returns {Promise<void>}
 */
export async function storeOrg(ctx, org, data) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  await usersBucket.put(`/orgs/${org}/org.json`, JSON.stringify(data), 'application/json');
}

/**
 * @param {UniversalContext} ctx
 * @param {string} org
 * @returns {Promise<void>}
 */
export async function deleteOrg(ctx, org) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  await usersBucket.remove([`/orgs/${org}/org.json`, `/orgs/${org}/.orgkey`]);
}

/**
 * Store domain-orgkey map
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @param {Record<string, string>} map
 */
export async function storeDomainOrgkeyMap(ctx, domain, map) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  await usersBucket.put(`/domains/${domain}/.orgkeys.json`, JSON.stringify(map), 'application/json');
}
