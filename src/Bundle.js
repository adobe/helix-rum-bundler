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

import { HelixStorage } from './support/storage.js';

export default class Bundle {
  /**
   * @type {UniversalContext}
   */
  ctx = undefined;

  /**
   * @type {Record<string, RUMEventGroup>}
   */
  groups = {};

  /**
   * @type {boolean}
   */
  dirty = false;

  /**
   * @param {UniversalContext} ctx
   * @param {string} key
   * @param {BundleData} data
   */
  constructor(ctx, key, data = {}) {
    console.log('bundle constructor', key);
    this.ctx = ctx;
    this.key = key;
    this.groups = data.groups || {};
  }

  /**
   * @param {RUMEvent} event
   */
  push(event) {
    if (!this.groups[event.id]) {
      this.groups[event.id] = {
        // TODO: be more selective with the data that's stored in the group object
        ...event,
        events: [],
      };
    }
    this.groups[event.id].events.push(event);
    this.dirty = true;
  }

  async store() {
    if (this.dirty) {
      const data = JSON.stringify({ groups: this.groups });
      const { bundleBucket } = HelixStorage.fromContext(this.ctx);
      this.ctx.log.debug(`storing bundle to ${this.key}.json`);
      await bundleBucket.put(`${this.key}.json`, JSON.stringify(data), 'application/json');
      this.dirty = false;
    }
  }

  /**
   * @param {UniversalContext} ctx
   * @param {string} domain
   * @param {number} year
   * @param {number} month
   * @param {number} date
   * @param {number} date
   * @returns {Promise<Bundle>}
   */
  static async fromContext(ctx, domain, year, month, date, hour) {
    const { log } = ctx;
    const key = `${domain}/${year}/${month}/${date}/${hour}`;

    if (!ctx.attributes.rumBundles) {
      ctx.attributes.rumBundles = {};
    }

    if (ctx.attributes.rumBundles[key]) {
      return ctx.attributes.rumBundles[key];
    }

    let data = { groups: {} };
    try {
      const { bundleBucket } = HelixStorage.fromContext(ctx);
      const buf = await bundleBucket.get(`${key}.json`);
      if (buf) {
        const txt = new TextDecoder('utf8').decode(buf);
        data = JSON.parse(txt);
      }
    } catch (e) {
      log.error('failed to get bundle', e);
    }
    ctx.attributes.rumBundles[key] = new Bundle(ctx, key, data);
    return ctx.attributes.rumBundles[key];
  }
}
