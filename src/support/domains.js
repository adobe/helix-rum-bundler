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

import { getFetch } from './util.js';
import { purgeSurrogateKey } from './cache.js';
import { HelixStorage } from './storage.js';

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
 * Check whether domain exists in storage yet
 *
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
export async function isNewDomain(ctx, domain) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  const res = await bundleBucket.head(`/${domain}/.domainkey`);
  return res === null;
}

/**
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @param {string} domainkey
 */
export async function addRunQueryDomainkey(ctx, domain, domainkey) {
  const fetch = getFetch(ctx);
  const resp = await fetch(runQueryURL({ domain, domainkey }), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.env.RUNQUERY_ROTATION_KEY}`,
    },
  });
  if (!resp.ok) {
    ctx.log.warn(`failed to add runquery domainkey for ${domain}: ${resp.status}`);
  }
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
export async function setDomainKey(ctx, domain, domainkey) {
  if (!domainkey) {
    // eslint-disable-next-line no-param-reassign
    domainkey = crypto.randomUUID().toUpperCase();
  }

  // update storage
  const { bundleBucket } = HelixStorage.fromContext(ctx);
  await bundleBucket.put(`/${domain}/.domainkey`, domainkey, 'text/plain');

  await Promise.allSettled([
    // update runquery
    addRunQueryDomainkey(ctx, domain, domainkey),
    // purge cache
    purgeSurrogateKey(ctx, domain),
  ]);
  return domainkey;
}
