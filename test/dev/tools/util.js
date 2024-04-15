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

/**
 * @typedef {{ year: number; month: number; day: number; }} ParsedDate
 */

/** @type {() => UniversalContext} */
export const contextLike = () => ({
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
