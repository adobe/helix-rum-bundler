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
import processQueue from '@adobe/helix-shared-process-queue';
import { HelixStorage } from '../support/storage.js';
import {
  calculateDownsample, compressBody, errorWithResponse, getFetch,
} from '../support/util.js';
import { assertSuperuserAuthorized, assertOrgAdminAuthorized } from '../support/authorization.js';
import {
  doesOrgExist,
  retrieveOrgkey,
  getDomainOrgkeyMap,
  storeDomainOrgkeyMap,
  storeOrg,
  retrieveOrg,
  storeOrgkey,
  deleteOrg,
} from '../support/orgs.js';
import { PathInfo } from '../support/PathInfo.js';
import {
  MAX_EVENTS,
  fetchAggregate,
  getTTL,
  storeAggregate,
} from './bundles.js';
import { fetchDomainKey } from '../support/domains.js';

const FILE_WRITE_CONCURRENCY = 100;

/**
 * Sets { [org]: [orgkey] } in `{usersbucket}/domains/{domain}/.orgkeys.json`
 *
 * @param {UniversalContext} ctx
 * @param {string[]} domains
 * @param {string} org
 * @param {string} orgkey
 */
async function addOrgkeyToDomains(ctx, domains, org, orgkey) {
  await processQueue(
    [...domains],
    async (domain) => {
      try {
        const orgkeyMap = await getDomainOrgkeyMap(ctx, domain);
        orgkeyMap[org] = orgkey;
        await storeDomainOrgkeyMap(ctx, domain, orgkeyMap);
        /* c8 ignore next 3 */
      } catch (e) {
        ctx.log.error(`failed to add orgkey to domain '${domain}'`, e);
      }
    },
    FILE_WRITE_CONCURRENCY,
  );
}

/**
 * Removes orgkey entry for domains from their orgkeyDomainMap
 *
 * @param {UniversalContext} ctx
 * @param {string[]} domains
 * @param {string} org
 */
async function removeOrgkeyFromDomains(ctx, domains, org) {
  await Promise.allSettled(
    domains.map(async (domain) => {
      try {
        const orgkeyMap = await getDomainOrgkeyMap(ctx, domain);
        /* c8 ignore next 3 */
        if (!orgkeyMap[org]) {
          return;
        }
        delete orgkeyMap[org];
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

  const { id, domains = [], helixOrgs = [] } = ctx.data;
  if (typeof id !== 'string') {
    throw errorWithResponse(400, 'invalid id');
  }
  if (!Array.isArray(domains) || domains.find((d) => typeof d !== 'string')) {
    throw errorWithResponse(400, 'invalid domains');
  }
  if (!Array.isArray(helixOrgs) || helixOrgs.find((d) => typeof d !== 'string')) {
    throw errorWithResponse(400, 'invalid helixOrgs');
  }
  if (await doesOrgExist(ctx, id)) {
    throw errorWithResponse(409, 'org already exists');
  }

  const orgkey = crypto.randomUUID().toUpperCase();
  await Promise.all([
    storeOrgkey(ctx, id, orgkey),
    storeOrg(ctx, id, { domains, helixOrgs }),
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
  const { folders, ...rest } = await usersBucket.listFolders('orgs/');
  const orgs = folders.map((o) => o.replace('orgs/', '').slice(0, -1));
  return new Response(JSON.stringify({ orgs, ...rest }), {
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
async function getOrg(req, ctx, info) {
  const { org: id } = info;
  await assertOrgAdminAuthorized(req, ctx, id);
  const org = await retrieveOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }
  return new Response(JSON.stringify(org), {
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
async function getOrgkey(req, ctx, info) {
  const { org: id } = info;
  await assertOrgAdminAuthorized(req, ctx, id);

  const orgkey = await retrieveOrgkey(ctx, id);
  if (!orgkey) {
    return new Response('', { status: 404 });
  }

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
 * @param {PathInfo} info
 */
async function updateOrg(req, ctx, info) {
  assertSuperuserAuthorized(req, ctx);

  const { org: id } = info;
  const { domains = [], helixOrgs = [] } = ctx.data;

  if (!Array.isArray(domains) || domains.find((d) => typeof d !== 'string')) {
    throw errorWithResponse(400, 'invalid domains');
  }

  if (!Array.isArray(helixOrgs) || helixOrgs.find((d) => typeof d !== 'string')) {
    throw errorWithResponse(400, 'invalid helixOrgs');
  }

  const org = await retrieveOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }

  const orgkey = await retrieveOrgkey(ctx, id);
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
  org.helixOrgs = [...new Set([...(org.helixOrgs ?? []), ...helixOrgs])];
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
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function removeHelixOrgFromOrg(req, ctx, info) {
  assertSuperuserAuthorized(req, ctx);

  const { org: id, helixorg } = info;
  if (!helixorg) {
    return new Response('', { status: 404 });
  }

  const org = await retrieveOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }

  const newHelixOrgs = org.helixOrgs.filter((d) => d !== helixorg);
  if (newHelixOrgs.length === org.helixOrgs.length) {
    return new Response('', { status: 200 });
  }

  org.helixOrgs = newHelixOrgs;
  await storeOrg(ctx, id, org);
  return new Response(JSON.stringify(org), {
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
async function removeDomainFromOrg(req, ctx, info) {
  assertSuperuserAuthorized(req, ctx);

  const { org: id, domain } = info;
  if (!domain) {
    return new Response('', { status: 404 });
  }

  const org = await retrieveOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }

  const newDomains = org.domains.filter((d) => d !== domain);
  if (newDomains.length === org.domains.length) {
    return new Response(JSON.stringify(org), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  }

  org.domains = newDomains;
  await Promise.all([
    storeOrg(ctx, id, org),
    removeOrgkeyFromDomains(ctx, [domain], id),
  ]);
  return new Response(JSON.stringify(org), {
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
async function removeOrg(req, ctx, info) {
  assertSuperuserAuthorized(req, ctx);

  const { org: id } = info;
  const org = await retrieveOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }

  await Promise.all([
    deleteOrg(ctx, id),
    removeOrgkeyFromDomains(ctx, org.domains, id),
  ]);

  return new Response('', { status: 204 });
}

/**
 * @param {UniversalContext} ctx
 * @param {string} orgId
 * @param {string} orgkey
 * @param {string[]} domains
 */
// eslint-disable-next-line no-underscore-dangle
async function _setOrgkey(ctx, orgId, orgkey, domains) {
  await Promise.all([
    storeOrgkey(ctx, orgId, orgkey),
    addOrgkeyToDomains(ctx, domains, orgId, orgkey),
  ]);
}

/**
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function rotateOrgkey(req, ctx, info) {
  const { org: id } = info;
  await assertOrgAdminAuthorized(req, ctx, id);

  const org = await retrieveOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }

  const { domains } = org;
  const orgkey = crypto.randomUUID().toUpperCase();
  await _setOrgkey(ctx, id, orgkey, domains);

  return new Response(JSON.stringify({ orgkey: `org:${id}:${orgkey}` }), {
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
async function setOrgkey(req, ctx, info) {
  assertSuperuserAuthorized(req, ctx);
  const { org: id } = info;
  const { orgkey } = ctx.data;
  if (!orgkey || typeof orgkey !== 'string') {
    throw errorWithResponse(400, 'invalid orgkey');
  }
  if (!orgkey.startsWith(`org:${id}:`)) {
    throw errorWithResponse(400, 'invalid orgkey, expecting org:<id>:<key>');
  }

  const org = await retrieveOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }

  const { domains } = org;
  const key = orgkey.slice(`org:${id}:`.length);
  await _setOrgkey(ctx, id, key, domains);

  return new Response('', { status: 204 });
}

/**
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @param {PathInfo} info
 */
async function getOrgBundles(req, ctx, info) {
  const { org: id } = info;
  await assertOrgAdminAuthorized(req, ctx, id, ctx.data.domainkey);

  const org = await retrieveOrg(ctx, id);
  if (!org) {
    return new Response('', { status: 404 });
  }

  const { domains, helixOrgs = [] } = org;
  if (!domains.length) {
    return new Response(JSON.stringify({ rumBundles: [] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  }

  const orgPath = new PathInfo(`/bundles/${id}:all/${info.segments.slice(3).join('/')}`);
  const aggregate = await fetchAggregate(ctx, orgPath);
  const ttl = getTTL(orgPath);
  if (aggregate) {
    return compressBody(
      ctx,
      req,
      JSON.stringify(aggregate),
      {
        'cache-control': `public, max-age=${ttl}`,
        'surrogate-key': info.surrogateKeys.join(' '),
      },
    );
  }

  // for each domain in org, fetch it's bundles from the CDN
  // filter to only include `top` and `cwv-*` events
  // downsample if needed
  // store aggregate

  // filter out domains that are non-prod
  const filtered = new Set(domains.filter(
    (domain) => !/[^.]+\.(hlx|aem)\.(page|live)/.test(domain) && !/[^.]+\.web\.pfizer/.test(domain) && !domain.endsWith(':all'),
  ));
  // include the org aggregate bundle
  helixOrgs.forEach((helixOrg) => {
    filtered.add(`${helixOrg}.aem.live`);
  });

  /** @type {RUMBundle[]} */
  let rumBundles = [];
  let totalEvents = 0;
  const { date } = orgPath;
  const fetch = getFetch(ctx);
  await processQueue(
    [...filtered],
    async (domain) => {
      const domainkey = await fetchDomainKey(ctx, domain);
      const url = `${ctx.env.CDN_ENDPOINT}/bundles/${domain}/${date}?domainkey=${domainkey}`;
      // fetch from the CDN so that it caches the result
      const resp = await fetch(url);
      /** @type {any} */
      let data;
      if (resp.ok) {
        data = await resp.json();
      } else {
        data = { rumBundles: [] };
      }
      rumBundles.push(...data.rumBundles.map((pbundle) => {
        const bundle = pbundle;
        // filter to only include `top` and `cwv-*` events
        bundle.events = bundle.events.filter((e) => !!e.checkpoint && (e.checkpoint === 'top' || e.checkpoint.startsWith('cwv-')));
        bundle.domain = domain;
        totalEvents += bundle.events.length;
        return bundle;
      }));
    },
  );

  const { reductionFactor, weightFactor } = calculateDownsample(
    totalEvents,
    orgPath.day ? MAX_EVENTS.daily : MAX_EVENTS.monthly,
  );
  if (reductionFactor > 0) {
    rumBundles = rumBundles
      .filter(() => (Math.random() > reductionFactor))
      .map((b) => ({
        ...b,
        weight: b.weight * weightFactor,
      }));
  }

  const str = JSON.stringify({ rumBundles });

  // store aggregate
  await storeAggregate(ctx, orgPath, str, ttl * 1000);

  return compressBody(
    ctx,
    req,
    str,
    {
      'cache-control': `public, max-age=${ttl}`,
      'surrogate-key': orgPath.surrogateKeys.join(' '),
    },
  );
}

/**
 * Handle /orgs route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  const info = PathInfo.fromContext(ctx);
  if (req.method === 'POST') {
    if (info.org) {
      if (info.subroute === 'key') {
        return rotateOrgkey(req, ctx, info);
      }
      return updateOrg(req, ctx, info);
    }
    return createOrg(req, ctx);
  } else if (req.method === 'GET') {
    if (info.org) {
      if (info.subroute === 'key') {
        return getOrgkey(req, ctx, info);
      }
      if (info.subroute === 'bundles') {
        return getOrgBundles(req, ctx, info);
      }
      return getOrg(req, ctx, info);
    }
    return listOrgs(req, ctx);
  } else if (req.method === 'DELETE') {
    if (info.subroute === 'domains') {
      return removeDomainFromOrg(req, ctx, info);
    } else if (info.subroute === 'helixorgs') {
      return removeHelixOrgFromOrg(req, ctx, info);
    } else if (info.org && !info.subroute) {
      return removeOrg(req, ctx, info);
    }
  } else if (req.method === 'PUT') {
    if (info.subroute === 'key') {
      return setOrgkey(req, ctx, info);
    }
  }
  return new Response('method not allowed', { status: 405 });
}
