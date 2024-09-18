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
import { assertSuperuserAuthorized } from '../support/authorization.js';
import {
  doesAdminExist,
  listAdmins,
  retrieveAdmin,
  retrieveAdminkey,
  storeAdmin,
  storeAdminkey,
  deleteAdmin,
} from '../support/admins.js';
import { errorWithResponse } from '../support/util.js';

const ACTIONS = {
  read: true,
  write: true,
  delete: true,
};

const SCOPES = {
  orgs: true,
  domainkeys: true,
};

/**
 * @param {any} permissions
 * @throws {Error&{response:RResponse}}
 * @returns {asserts permissions is string[]}
 */
function assertValidPermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.find((d) => typeof d !== 'string')) {
    throw errorWithResponse(400, 'invalid domains');
  }

  permissions.forEach((perm) => {
    const [scope, action] = perm.split(':');
    if (!SCOPES[scope] || !ACTIONS[action]) {
      throw errorWithResponse(400, `invalid permission: ${perm}`);
    }
  });
}

/**
 * Get list of admin ids.
 *
 * @param {UniversalContext} ctx
 */
async function getAdmins(ctx) {
  const { limit, start } = ctx.data;
  const data = await listAdmins(ctx, start, limit);
  return new Response(JSON.stringify(data), { status: 200 });
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function getAdmin(ctx, info) {
  const { admin: id } = info;
  const admin = await retrieveAdmin(ctx, id);
  if (!admin) {
    return new Response('', { status: 404 });
  }
  return new Response(JSON.stringify(admin), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function getAdminkey(ctx, info) {
  const { admin: id } = info;

  const adminkey = await retrieveAdminkey(ctx, id);
  if (!adminkey) {
    return new Response('', { status: 404 });
  }

  return new Response(JSON.stringify({ adminkey: `admin:${id}:${adminkey}` }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * Create new admin
 *
 * @param {UniversalContext} ctx
 */
async function createAdmin(ctx) {
  const { id, permissions = [] } = ctx.data;
  if (typeof id !== 'string') {
    throw errorWithResponse(400, 'invalid id');
  }
  assertValidPermissions(permissions);

  if (await doesAdminExist(ctx, id)) {
    throw errorWithResponse(409, 'admin already exists');
  }

  const adminkey = crypto.randomUUID().toUpperCase();
  await Promise.all([
    storeAdminkey(ctx, id, adminkey),
    storeAdmin(ctx, id, { permissions }),
  ]);

  return new Response(JSON.stringify({ adminkey: `admin:${id}:${adminkey}` }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function updateAdmin(ctx, info) {
  const { admin: id } = info;
  const { permissions = [] } = ctx.data;
  assertValidPermissions(permissions);

  const admin = await retrieveAdmin(ctx, id);
  if (!admin) {
    return new Response('', { status: 404 });
  }

  const adminkey = await retrieveAdminkey(ctx, id);
  if (!adminkey) {
    ctx.log.warn(`adminkey not defined for admin ${id}`);
    throw errorWithResponse(400, 'adminkey not defined');
  }

  const newPerms = [];
  const existing = new Set(admin.permissions);
  permissions.forEach((perm) => {
    if (!existing.has(perm)) {
      newPerms.push(perm);
    }
  });
  if (!newPerms.length) {
    return new Response(JSON.stringify(admin), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  }

  admin.permissions = [...existing, ...newPerms];
  await storeAdmin(ctx, id, admin);
  return new Response(JSON.stringify(admin), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * @param {UniversalContext} ctx
 * @param {string} adminId
 * @param {string} adminkey
 */
// eslint-disable-next-line no-underscore-dangle
async function _setAdminkey(ctx, adminId, adminkey) {
  await storeAdminkey(ctx, adminId, adminkey);
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function rotateAdminkey(ctx, info) {
  const { admin: id } = info;

  const admin = await retrieveAdmin(ctx, id);
  if (!admin) {
    return new Response('', { status: 404 });
  }

  const adminkey = crypto.randomUUID().toUpperCase();
  await _setAdminkey(ctx, id, adminkey);

  return new Response(JSON.stringify({ adminkey: `admin:${id}:${adminkey}` }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function setAdminkey(ctx, info) {
  const { adminkey } = ctx.data;
  const { admin: id } = info;

  if (!adminkey || typeof adminkey !== 'string') {
    throw errorWithResponse(400, 'invalid adminkey');
  }
  if (!adminkey.startsWith(`admin:${id}:`)) {
    throw errorWithResponse(400, 'invalid adminkey, expecting admin:<id>:<key>');
  }

  const admin = await retrieveAdmin(ctx, id);
  if (!admin) {
    return new Response('', { status: 404 });
  }

  const key = adminkey.substring(`admin:${id}:`.length);
  await _setAdminkey(ctx, id, key);

  return new Response('', { status: 204 });
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function removePermissionFromAdmin(ctx, info) {
  const { admin: id, permission } = info;
  if (!permission) {
    return new Response('', { status: 404 });
  }

  const admin = await retrieveAdmin(ctx, id);
  if (!admin) {
    return new Response('', { status: 404 });
  }

  const newPerms = admin.permissions.filter((p) => p !== permission);
  if (newPerms.length === admin.permissions.length) {
    return new Response(JSON.stringify(admin), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  }

  admin.permissions = newPerms;
  await storeAdmin(ctx, id, admin);
  return new Response(JSON.stringify(admin), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function removeAdmin(ctx, info) {
  const { admin: id } = info;
  const admin = await retrieveAdmin(ctx, id);
  if (!admin) {
    return new Response('', { status: 404 });
  }

  await deleteAdmin(ctx, id);

  return new Response('', { status: 204 });
}

/**
 * Handle /admins route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  const info = new PathInfo(ctx.pathInfo.suffix);
  assertSuperuserAuthorized(req, ctx);

  if (req.method === 'GET') {
    if (!info.subroute) {
      if (!info.admin) {
        return getAdmins(ctx);
      } else {
        return getAdmin(ctx, info);
      }
    } else if (info.subroute === 'key') {
      return getAdminkey(ctx, info);
    }
  } else if (req.method === 'POST') {
    if (!info.subroute) {
      if (!info.admin) {
        return createAdmin(ctx);
      }
      return updateAdmin(ctx, info);
    } else if (info.subroute === 'key') {
      return rotateAdminkey(ctx, info);
    }
  } else if (req.method === 'PUT') {
    if (info.subroute === 'key') {
      return setAdminkey(ctx, info);
    }
  } else if (req.method === 'DELETE') {
    if (info.subroute === 'permissions') {
      return removePermissionFromAdmin(ctx, info);
    } else if (!info.subroute && info.admin) {
      return removeAdmin(ctx, info);
    }
  }
  return new Response('method not allowed', { status: 405 });
}
