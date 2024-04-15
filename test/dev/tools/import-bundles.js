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

/* eslint-disable no-console, no-param-reassign */

// @ts-check

import { config as configEnv } from 'dotenv';
import processQueue from '@adobe/helix-shared-process-queue';
import { importEventsByKey, sortRawEvents } from '../../../src/bundler.js';
import executeBundleQuery from './bq/index.js';
import { contextLike, parseDate, parseDateRange } from './util.js';

configEnv();

/** @type {'bigquery'|'runquery'} */
const BACKEND = 'bigquery';

/**
 * @param {{
 *  domain: string;
 *  date: string;
 *  domainKey: string;
 *  limit?: number;
 *  after?: string;
 * }} param0
 * @returns {string}
 */
const runQueryURL = ({
  domain,
  date,
  domainKey,
  limit,
  after,
}) => 'https://helix-pages.anywhere.run/helix-services/run-query@v3/rum-bundles?'
+ `url=${domain}&startdate=${date}&domainkey=${domainKey}${limit ? `&limit=${limit}` : ''}${after ? `&after=${after}` : ''}`;

/**
 * @param {string} domain
 * @param {string} date
 * @param {string} domainKey
 * @param {number} [limit]
 * @param {string} [after]
 */
const fetchRUMBundles = async (domain, date, domainKey, limit, after) => {
  let data;
  // @ts-ignore
  if (BACKEND === 'runquery') {
    const res = await fetch(runQueryURL({
      domain,
      date,
      domainKey,
      limit,
      after,
    }));
    if (!res.ok) {
      throw Error(`failed to fetch rum: ${res.status}`);
    }
    ({ results: { data } } = await res.json());
  } else {
    data = await executeBundleQuery(domain, domainKey, date);
  }

  return data || [];
};

/**
 *
 * @param {UniversalContext} ctx
 * @param {string} domainKey
 * @param {string} domain
 * @param {import('./util.js').ParsedDate} ymd
 * @param {number} [limit]
 * @param {string} [after]
 */
async function importBundlesForDate(ctx, domainKey, domain, ymd, limit, after) {
  const { year, month, day } = ymd;
  const date = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

  console.info(`fetching bundles from ${BACKEND} for ${domain} on ${date}`);
  const data = await fetchRUMBundles(domain, date, domainKey, limit, after);
  if (!data.length) {
    return;
  }

  console.debug(`processing ${data.length} bundles on ${domain}`);
  let totalEvents = 0;
  let ignoredEvents = 0;
  let lastId;
  const bundles = data.filter((bundle) => {
    if (!bundle.id) {
      ignoredEvents += bundle.events.length;
      return false;
    }
    lastId = bundle.id;
    totalEvents += bundle.events.length;
    return true;
  });

  console.debug(`ignoring ${ignoredEvents} events from ${data.length - bundles.length} (${(((data.length - bundles.length) / bundles.length) * 100).toFixed(2)}%) bundles on ${domain} due to missing id`);

  // convert bundles to array of events so they can be resorted by bundlegroup key
  const events = bundles.reduce((acc, bundle) => [
    ...acc,
    ...bundle.events.map((evt) => ({
      ...bundle,
      ...evt,
      rownum: undefined,
      time: Number(new Date(evt.time)),
      events: undefined,
    })),
  ], []);

  // do equivalent steps as bundler.js
  const rawEventMap = sortRawEvents(events, ctx.log);
  await importEventsByKey(ctx, rawEventMap);

  console.debug(`imported ${totalEvents} events from ${bundles.length} bundles`);
  if (lastId && BACKEND === 'runquery') {
    console.debug(`importing next page after ${lastId}`);

    // get next page
    // eslint-disable-next-line consistent-return
    return importBundlesForDate(ctx, domainKey, domain, ymd, limit, lastId);
  }
}

function assertEnv() {
  if (!process.env.DOMAIN_KEY) {
    throw Error('missing env variable: DOMAIN_KEY');
  }
  if (!process.env.DOMAIN && !process.env.DOMAINS) {
    throw Error('missing env variable: DOMAIN or DOMAINS');
  }
  if (!process.env.DATE && (!process.env.START_DATE || !process.env.END_DATE)) {
    throw Error('missing env variable: DATE or START_DATE and END_DATE');
  }
}

(async () => {
  assertEnv();

  const ctx = contextLike();
  const limit = undefined;
  /** @type {string} */
  // @ts-ignore
  const key = process.env.DOMAIN_KEY;

  /** @type {import('./util.js').ParsedDate[]} */
  let ymds;
  if (process.env.START_DATE && process.env.END_DATE) {
    ymds = parseDateRange(process.env.START_DATE, process.env.END_DATE);
  } else {
    // @ts-ignore
    ymds = [parseDate(process.env.DATE)];
  }

  /** @type {string[]} */
  let domains;
  if (process.env.DOMAIN && !process.env.DOMAIN.includes(',')) {
    domains = [process.env.DOMAIN];
  } else {
    // @ts-ignore
    domains = (process.env.DOMAINS || process.env.DOMAIN).split(',');
  }

  await processQueue(
    domains,
    async (domain) => {
      for (const ymd of ymds) {
        // eslint-disable-next-line no-await-in-loop
        await importBundlesForDate(ctx, key, domain, ymd, limit);
      }
    },
    8,
  );
})().catch(console.error);
