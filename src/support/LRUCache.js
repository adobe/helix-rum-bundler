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
 * @template {{ active(): boolean; } | Promise<any>} T
 */
export default class LRUCache {
  /** @type {Map<string, { t: number; v: T; }>} */
  #map;

  /** @type {number} */
  limit;

  /** @type {number} */
  threshold;

  constructor({
    name = 'default',
    log = console,
    limit = 1000,
    threshold = 0.5,
  } = {}) {
    this.#map = new Map();
    this.limit = limit;
    this.threshold = threshold;
    this.name = name;
    this.log = log;
  }

  #purge() {
    let rm = 0;
    [...this.#map.entries()]
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, this.limit * this.threshold)
      .forEach(([key, { v }]) => {
        if (v instanceof Promise) {
          return;
        }
        if (!v.active()) {
          rm += 1;
          this.#map.delete(key);
        }
      });
    this.log.info(`LRUCache(${this.name}): purged ${rm} item to new size ${this.#map.size}`);
  }

  /**
   * @param {string} key
   */
  has(key) {
    return this.#map.has(key);
  }

  /**
   * @param {string} key
   * @returns {T|undefined}
   */
  get(key) {
    const item = this.#map.get(key);
    if (item) {
      item.t = Date.now();
      return item.v;
    }
    return undefined;
  }

  /**
   * @param {string} key
   * @param {T} value
   */
  set(key, value) {
    this.#map.set(key, { t: Date.now(), v: value });
    if (this.#map.size >= this.limit) {
      this.#purge();
    }
  }
}
