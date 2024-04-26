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

import processQueue from '@adobe/helix-shared-process-queue';
import { HelixStorage } from '../../../src/support/storage.js';

/**
 * @typedef {{ year: number; month: number; day: number; }} ParsedDate
 */

/** @type {() => UniversalContext} */
export const contextLike = (overrides = {}) => ({
  // @ts-ignore
  log: console,
  // @ts-ignore
  env: {
    ...process.env,
    ...(overrides.env ?? {}),
  },
  // @ts-ignore
  attributes: {
    ...(overrides.attributes ?? {}),
  },
});

/**
 * @param {string} date yyyy-mm-dd
 * @returns {ParsedDate}
 */
export const parseDate = (date) => {
  const [year, month, day] = date.split('-').map((s) => parseInt(s, 10));
  return { year, month, day };
};

/**
 * @param {string} start
 * @param {string} end
 * @returns {ParsedDate[]}
 */
export const parseDateRange = (start, end) => {
  if (!start || !end) {
    throw Error('missing start or end in range');
  }

  const startDate = parseDate(start);
  const endDate = parseDate(end);

  const dates = [];
  for (let y = startDate.year; y <= endDate.year; y += 1) {
    const startMonth = y === startDate.year ? startDate.month : 1;
    const endMonth = y === endDate.year ? endDate.month : 12;

    for (let m = startMonth; m <= endMonth; m += 1) {
      const startDay = (y === startDate.year && m === startDate.month) ? startDate.day : 1;
      let endDay = (y === endDate.year && m === endDate.month) ? endDate.day : 31;

      const lastPosDay = new Date(y, m, 0).getDate();
      if (endDay > lastPosDay) {
        endDay = lastPosDay;
      }

      for (let d = startDay; d <= endDay; d += 1) {
        dates.push({ year: y, month: m, day: d });
      }
    }
  }

  return dates;
};

/**
 * Extract the OS from the user agent string
 * @returns {':android'|':ios'|':ipados'|''} the OS
 */
function getMobileOS(userAgent) {
  if (userAgent.includes('android')) {
    return ':android';
  } else if (userAgent.includes('ipad')) {
    return ':ipados';
  } else if (userAgent.includes('like mac os')) {
    return ':ios';
  }
  return '';
}

/**
 * Extract the OS from the user agent string
 * @returns {':windows'|':mac'|':linux'|''} the OS
 */
function getDesktopOS(userAgent) {
  if (userAgent.includes('windows')) {
    return ':windows';
  } else if (userAgent.includes('mac os')) {
    return ':mac';
  } else if (userAgent.includes('linux')) {
    return ':linux';
  }
  return '';
}

/**
 * user agent masking
 * to be applied to events imported from bq before 2023-09-11
 * @param {string} userAgent
 * @returns {string}
 */
export function getMaskedUserAgent(userAgent) {
  if (!userAgent) {
    return 'undefined';
  }
  const lcUA = userAgent.toLowerCase();

  if (lcUA.includes('mobile')
    || lcUA.includes('opera mini')) {
    return `mobile${getMobileOS(lcUA)}`;
  }
  if (lcUA.includes('bot')
    || lcUA.includes('spider')
    || lcUA.includes('crawler')
    || lcUA.includes('ahc/')
    || lcUA.includes('node')
    || lcUA.includes('python')
    || lcUA.includes('probe')
    || lcUA.includes('axios')
    || lcUA.includes('curl')
    || lcUA.includes('+https://')
    || lcUA.includes('+http://')) {
    return 'bot';
  }

  return `desktop${getDesktopOS(lcUA)}`;
}

/**
 * @param {UniversalContext} ctx
 * @returns {Promise<{ missing:string[]; empty:string[] }>}
 */
export async function findOpenDomains(ctx) {
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const domains = await bundleBucket.listFolders('');
  const collected = await processQueue(
    domains,
    async (domain) => {
      const key = await bundleBucket.head(`${domain}/.domainkey`);
      if (!key) {
        return { missing: domain };
      }
      if (key.ContentLength === 0) {
        return { empty: domain };
      }
      return undefined;
    },
  );
  return collected.reduce((acc, curr) => {
    if (curr) {
      if (curr.missing) {
        acc.missing.push(curr.missing);
      }
      if (curr.empty) {
        acc.empty.push(curr.empty);
      }
    }
    return acc;
  }, { missing: [], empty: [] });
}
