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

export default class Manifest {
  /**
   * @type {UniversalContext}
   */
  ctx = undefined;

  /**
   * @type {string}
   */
  key = undefined;

  /**
   * @type {Record<string, SessionData>}
   */
  sessions = {};

  /**
   * @type {boolean}
   */
  dirty = false;

  /**
   * @param {UniversalContext} ctx
   * @param {string} key
   * @param {ManifestData} data
   */
  constructor(ctx, key, data = {}) {
    this.ctx = ctx;
    this.key = key;
    this.sessions = data.sessions || {};
  }

  /**
   * @param {string} id
   * @param {number} earliest
   * @param {number} latest
   * @returns {boolean}
   */
  has(id, earliest = -Infinity, latest = Infinity) {
    const session = this.sessions[id];
    return !!session && session.hour >= earliest && session.hour <= latest;
  }

  /**
   * @param {string} id
   * @returns {SessionData}
   */
  get(id) {
    return this.sessions[id];
  }

  /**
   * @param {string} id
   * @param {number} hour
   */
  add(id, hour) {
    if (this.sessions[id] && this.sessions[id].hour === hour) {
      return;
    }
    this.sessions[id] = { hour };
    this.dirty = true;
  }

  async store() {
    if (this.dirty) {
      const data = JSON.stringify({ sessions: this.sessions });
      const { bundleBucket } = HelixStorage.fromContext(this.ctx);
      // this.ctx.log.debug(`storing manifest to ${this.key}/.manifest.json`);
      await bundleBucket.put(`${this.key}/.manifest.json`, data, 'application/json');
      this.dirty = false;
    }
  }

  /**
   * @param {UniversalContext} ctx
   * @param {string} domain
   * @param {number} year
   * @param {number} month
   * @param {number} date
   * @returns {Promise<Manifest>}
   */
  static async fromContext(ctx, domain, year, month, date) {
    const { log } = ctx;
    const key = `${domain}/${year}/${month}/${date}`;

    if (!ctx.attributes.rumManifests) {
      ctx.attributes.rumManifests = {};
    }

    if (ctx.attributes.rumManifests[key]) {
      return ctx.attributes.rumManifests[key];
    }

    let data = { sessions: {} };
    try {
      const { bundleBucket } = HelixStorage.fromContext(ctx);
      const buf = await bundleBucket.get(`${key}/.manifest.json`);
      if (buf) {
        const txt = new TextDecoder('utf8').decode(buf);
        data = JSON.parse(txt);
      }
    } catch (e) {
      log.error('failed to get manifest', e);
    }
    ctx.attributes.rumManifests[key] = new Manifest(ctx, key, data);
    return ctx.attributes.rumManifests[key];
  }
}
