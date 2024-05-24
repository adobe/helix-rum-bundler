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

import LRUCache from '../support/LRUCache.js';
import { HelixStorage } from '../support/storage.js';

export default class Manifest {
  /**
   * @type {UniversalContext}
   */
  ctx;

  /**
   * @type {string}
   */
  key;

  /**
   * @type {Record<string, SessionData>}
   */
  sessions = {};

  /**
   * @type {boolean}
   */
  dirty = false;

  /**
   * @type {number}
   */
  day;

  /**
   * @param {UniversalContext} ctx
   * @param {string} key
   * @param {number} day
   * @param {ManifestData} [data]
   */
  constructor(ctx, key, day, data) {
    this.ctx = ctx;
    this.key = key;
    this.day = day;
    this.sessions = data?.sessions || {};
  }

  active() {
    return this.dirty;
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
   * @param {number} day
   * @returns {Promise<Manifest>}
   */
  static async fromContext(ctx, domain, year, month, day) {
    const { log } = ctx;
    const key = `${domain}/${year}/${month}/${day}`;

    if (!ctx.attributes.rumManifests) {
      ctx.attributes.rumManifests = new LRUCache({ name: 'Manifest' });
    }

    if (ctx.attributes.rumManifests.has(key)) {
      // @ts-ignore
      return ctx.attributes.rumManifests.get(key);
    }

    const promise = (async () => {
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
      const manifest = new Manifest(ctx, key, day, data);
      ctx.attributes.rumManifests.set(key, manifest);
      return manifest;
    })();

    ctx.attributes.rumManifests.set(key, promise);
    return promise;
  }
}
