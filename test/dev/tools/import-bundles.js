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
import { importEventsByKey, sortRawEvents } from '../../../src/bundler.js';

configEnv();

/**
 * @param {string} date yyyy-mm-dd
 */
const parseDate = (date) => {
  const [year, month, day] = date.split('-').map((s) => parseInt(s, 10));
  return { year, month, day };
};

/**
 * @param {{
 *  domain: string;
 *  date: string;
 *  domainKey: string;
 *  limit?: number;
 * }} param0
 * @returns {string}
 */
const runQueryURL = ({
  domain,
  date,
  domainKey,
  limit,
}) => `https://helix-pages.anywhere.run/helix-services/run-query@v3/rum-bundles?url=${domain}&startdate=${date}&domainkey=${domainKey}${limit ? `&limit=${limit}` : ''}`;

/** @type {() => UniversalContext} */
const contextLike = () => ({
  // @ts-ignore
  log: console,
  // @ts-ignore
  env: {
    ...process.env,
  },
  // @ts-ignore
  attributes: {},
});

/**
 *
 * @param {UniversalContext} ctx
 * @param {string} domainKey
 * @param {string} domain
 * @param {{year: number; month: number; day: number;}} ymd
 * @param {number} [limit]
 */
async function importBundlesForDate(ctx, domainKey, domain, ymd, limit) {
  const { year, month, day } = ymd;
  const date = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

  console.info(`fetching bundles for ${domain} on ${date}`);
  const res = await fetch(runQueryURL({
    domain,
    date,
    domainKey,
    limit,
  }));
  if (!res.ok) {
    throw Error(`failed to fetch rum: ${res.status}`);
  }

  const { results: { data } } = await res.json();

  let totalEvents = 0;
  let ignoredEvents = 0;
  const bundles = data.filter((bundle) => {
    if (!bundle.id) {
      ignoredEvents += bundle.events.length;
      return false;
    }
    totalEvents += bundle.events.length;
    return true;
  });

  console.debug(`ignoring ${ignoredEvents} events from ${data.length - bundles.length} bundles due to missing id`);

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
}

(async () => {
  if (!process.env.DOMAIN_KEY) {
    throw Error('missing DOMAIN_KEY env variable');
  }

  const ctx = contextLike();
  const key = process.env.DOMAIN_KEY;
  const ymds = [parseDate('2024-03-20')];
  const domain = 'www.adobe.com';
  const limit = undefined;

  for (const ymd of ymds) {
    // eslint-disable-next-line no-await-in-loop
    await importBundlesForDate(ctx, key, domain, ymd, limit);
  }
})().catch(console.error);
