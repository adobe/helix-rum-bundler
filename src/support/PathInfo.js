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

import { errorWithResponse } from './util.js';

export class PathInfo {
  /** @type {string} */
  route;

  /** @type {string} */
  domain;

  /** @type {number} */
  year;

  /** @type {number|undefined} */
  month;

  /** @type {number|undefined} */
  day;

  /** @type {number|undefined} */
  hour;

  constructor(path) {
    if (!path.endsWith('.json')) {
      // eslint-disable-next-line no-param-reassign
      path += '.json';
    }

    const segments = path.slice(0, -'.json'.length).split('/').slice(1);
    const [route, domain, year, month, day, hour] = segments;

    this.route = route;
    this.domain = domain;
    if (this.route === 'domainkey') {
      if (year) {
        throw errorWithResponse(404, 'invalid path');
      }
    } else {
      if (year) {
        this.year = parseInt(year, 10);
      }
      if (month) {
        this.month = parseInt(month, 10);
      }
      if (day) {
        this.day = parseInt(day, 10);
      }
      if (hour) {
        this.hour = parseInt(hour, 10);
      }

      if (Number.isNaN(this.year)
    || Number.isNaN(this.month)
    || Number.isNaN(this.day)
    || Number.isNaN(this.hour)) {
        throw errorWithResponse(404, 'invalid path');
      }
    }
  }

  toString() {
    const parts = ['', this.domain, this.year, this.month, this.day, this.hour];
    return parts.filter((p) => p !== undefined).join('/');
  }

  get surrogateKeys() {
    if (this.route === 'domainkey') {
      return [];
    }
    const keys = [this.domain, String(this.year)];
    if (this.month !== undefined) {
      keys.push(`${this.year}-${this.month}`);
      if (this.day !== undefined) {
        keys.push(`${this.year}-${this.month}-${this.day}`);
        if (this.hour !== undefined) {
          keys.push(`${this.year}-${this.month}-${this.day}-${this.hour}`);
        }
      }
    }
    return keys;
  }

  /**
   * make new PathInfo with optional overrides
   * @param {number} [year]
   * @param {number} [month]
   * @param {number} [day]
   * @param {number} [hour]
   * @returns {PathInfo}
   */
  clone(year, month, day, hour) {
    const parts = ['', this.route, this.domain, year ?? this.year, month ?? this.month, day ?? this.day, hour ?? this.hour];
    const newPath = parts.filter((p) => p !== undefined).join('/');
    return new PathInfo(newPath);
  }
}
