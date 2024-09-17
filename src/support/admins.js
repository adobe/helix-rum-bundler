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
 * Fetch list of admins
 *
 * @param {UniversalContext} ctx
 * @param {string} [start]
 * @param {number|string} [plimit]
 * @returns {Promise<{items:string[]; pagination:Pagination; links:Links; }>}
 */
export async function listAdmins(ctx, start, plimit) {
  let limit = plimit && typeof plimit === 'string' ? parseInt(plimit, 10) : plimit;
  limit = typeof limit === 'number' && limit > 0 ? limit : 1000;
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const { folders, next } = await usersBucket.listFolders('', { start, limit });
  return {
    items: folders.map((d) => (d.endsWith('/') ? d.slice(0, -1) : d)),
    pagination: {
      start,
      limit,
      next,
    },
    links: {
      next: next ? `${ctx.env.CDN_ENDPOINT}/admins?start=${encodeURIComponent(next)}&limit=${limit}` : undefined,
    },
  };
}

/**
 * @param {UniversalContext} ctx
 * @param {string} admin
 * @returns {Promise<AdminData | null>}
 */
export async function retrieveAdmin(ctx, admin) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const data = await usersBucket.get(`/admins/${admin}/admin.json`);
  if (!data) {
    return null;
  }

  return JSON.parse(new TextDecoder('utf8').decode(data));
}

/**
 * Get adminkey for admin
 *
 * @param {UniversalContext} ctx
 * @param {string} org
 * @returns {Promise<string|null>}
 */
export async function retrieveAdminkey(ctx, org) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const buf = await usersBucket.get(`/admins/${org}/.adminkey`);
  if (!buf) {
    return null;
  }
  return new TextDecoder('utf8').decode(buf);
}

/**
 * @param {UniversalContext} ctx
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function doesAdminExist(ctx, id) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const admin = await usersBucket.head(`/admins/${id}/admin.json`);
  return !!admin;
}

/**
 * Store adminkey for admin
 *
 * @param {UniversalContext} ctx
 * @param {string} admin
 * @param {string} adminkey
 */
export async function storeAdminkey(ctx, admin, adminkey) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  await usersBucket.put(`/admins/${admin}/.adminkey`, adminkey, 'text/plain');
}

/**
 * @param {UniversalContext} ctx
 * @param {string} admin
 * @param {AdminData} data
 * @returns {Promise<void>}
 */
export async function storeAdmin(ctx, admin, data) {
  const { usersBucket } = HelixStorage.fromContext(ctx);
  await usersBucket.put(`/admins/${admin}/admin.json`, JSON.stringify(data), 'application/json');
}
