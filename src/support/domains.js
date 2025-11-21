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

import { purgeSurrogateKey } from './cache.js';
import { HelixStorage } from './storage.js';
import { yesterday } from './util.js';

/**
 * Fetch domainkey for domain
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @returns {Promise<string|null>}
 */
export async function fetchDomainKey(ctx, domain) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  const buf = await bundleBucket.get(`/${domain}/.domainkey`);
  if (!buf) {
    return null;
  }
  return new TextDecoder('utf8').decode(buf);
}

/**
 * Fetch list of domains
 *
 * @param {UniversalContext} ctx
 * @param {string} [start]
 * @param {number|string} [plimit]
 * @param {string} [pfilter]
 * @returns {Promise<{items:string[]; pagination:Pagination; links:Links; }>}
 */
export async function listDomains(ctx, start, plimit, pfilter) {
  let limit = plimit && typeof plimit === 'string' ? parseInt(plimit, 10) : plimit;
  limit = typeof limit === 'number' && limit > 0 ? limit : 1000;

  const filter = pfilter && typeof pfilter === 'string' ? decodeURIComponent(pfilter) : undefined;

  const { bundleBucket } = HelixStorage.fromContext(ctx);
  const { folders, next } = await bundleBucket.listFolders('', { start, limit, filter });
  return {
    items: folders.map((d) => (d.endsWith('/') ? d.slice(0, -1) : d)),
    pagination: {
      start,
      limit,
      next,
    },
    links: {
      next: next ? `${ctx.env.CDN_ENDPOINT}/domains?start=${encodeURIComponent(next)}&limit=${limit}${filter ? `&filter=${pfilter}` : ''}` : undefined,
    },
  };
}

/**
 * Get domain lookup table from context
 * @param {UniversalContext} ctx
 * @returns {Promise<DomainTable>}
 */
export async function getDomainTable(ctx) {
  if (!ctx.attributes.domainTable) {
    let timeout;
    ctx.attributes.domainTable = {
      domains: new Map(),
      // @ts-ignore
      async load() {
        const { bundleBucket } = HelixStorage.fromContext(ctx);
        const data = await bundleBucket.get('/.domains/lookup.json');
        const json = data ? JSON.parse(new TextDecoder('utf8').decode(data)) : {};
        this.domains = new Map(Object.entries(json));
      },
      save() {
        // debounced save
        if (timeout) {
          clearTimeout(timeout);
        }
        // use named function to identify in tests
        // eslint-disable-next-line prefer-arrow-callback
        timeout = setTimeout(async function saveDomainTable() {
          timeout = null;
          const { domains } = ctx.attributes.domainTable;
          const { bundleBucket } = HelixStorage.fromContext(ctx);
          const data = Object.fromEntries(domains.entries());
          await bundleBucket.put('/.domains/lookup.json', JSON.stringify(data), 'application/json');
          ctx.log.info(`saved ${domains.size} domains to lookup table`);
        }, 1000);
      },
      add(domain) {
        this.domains.set(domain, true);
        this.save();
      },
      has(domain) {
        return this.domains.has(domain);
      },
    };
    // @ts-ignore
    await ctx.attributes.domainTable.load();
  }
  return ctx.attributes.domainTable;
}

/**
 * Check whether domain exists in storage yet
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
export async function isNewDomain(ctx, domain) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  // check if domainkey exists in lookup table
  const domainTable = await getDomainTable(ctx);
  if (domainTable.has(domain)) {
    return false;
  }

  // still might already exist, if so add to lookup table
  const res = await bundleBucket.head(`/${domain}/.domainkey`);
  if (res !== null) {
    domainTable.add(domain);
    return false;
  }
  return res === null;
}

/**
 * Set domainkey in storage.
 * Assumes caller is authorized.
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @param {string|undefined} [domainkey]
 * @returns {Promise<string>}
 */
export async function setDomainKey(ctx, domain, domainkey, purgeCache = true) {
  if (!domainkey) {
    // eslint-disable-next-line no-param-reassign
    domainkey = crypto.randomUUID().toUpperCase();
  }

  // update storage
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  await bundleBucket.put(`/${domain}/.domainkey`, domainkey, 'text/plain');

  if (purgeCache) {
    await purgeSurrogateKey(ctx, domain);
  }

  return domainkey;
}

/**
 * Get the top N domains for the last M days.
 *
 * @param {UniversalContext} ctx
 * @param {number} days M
 * @param {number} count N
 */
export async function findTopDomains(ctx, days, count = 100) {
  const domainkey = await fetchDomainKey(ctx, 'aem.live:all');

  const now = new Date();
  /** @type {[year: number, month: number, day: number]} */
  let date = [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];

  const proms = new Array(days).fill(0).map(async () => {
    const url = `${ctx.env.CDN_ENDPOINT}/bundles/aem.live:all/${date.join('/')}?domainkey=${domainkey}`;
    date = yesterday(...date);

    const resp = await fetch(url);
    return resp.json();
  });

  const domainHitMap = (await Promise.all(proms)).reduce((acc, json) => {
    const { rumBundles } = json;
    rumBundles.forEach((bundle) => {
      const { domain, weight } = bundle;
      if (!acc[domain]) {
        acc[domain] = 0;
      }
      acc[domain] += weight;
    });
    return acc;
  }, {});

  const sorted = Object.entries(domainHitMap).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, count).map(([domain]) => domain);
}
