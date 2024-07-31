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

import LRUCache from '../support/LRUCache.js';
import { HelixStorage } from '../support/storage.js';
import { getCWVEventType, pruneUndefined } from '../support/util.js';

/**
 * @param {RawRUMEvent} event
 */
export const getBundleProperties = (event) => {
  const tmpTime = new Date(event.time);
  const time = tmpTime.toISOString();
  tmpTime.setMinutes(0, 0, 0);
  const timeSlot = tmpTime.toISOString(); // only date/hour
  return {
    id: event.id,
    host: event.host,
    time,
    timeSlot,
    url: event.url,
    userAgent: event.user_agent,
    referer: event.string,
    weight: event.weight,
    domain: event.domain,
    events: [],
    ...(event.hostType ? { hostType: event.hostType } : {}),
  };
};

/**
 * @param {RawRUMEvent} event
 * @param {RUMBundle} bundle
 * @returns {RUMEvent}
 */
export const getEventProperties = (event, bundle) => {
  const timeDelta = typeof event.time === 'undefined' ? undefined : event.time - Number(new Date(bundle.timeSlot));
  // custom handling cases for specific event types
  if (event.checkpoint === 'cwv') {
    const type = getCWVEventType(event);
    if (type) {
      // @ts-ignore
      return pruneUndefined({
        checkpoint: `cwv-${type.toLowerCase()}`,
        value: event[type],
        timeDelta,
        source: event.source ?? undefined,
        target: event.target ?? undefined,
      });
    }
    return { checkpoint: 'cwv', timeDelta };
  }

  // @ts-ignore
  return pruneUndefined({
    ...event,
    timeDelta,
    domain: undefined,
    time: undefined,
    id: undefined,
    host: undefined,
    url: undefined,
    user_agent: undefined,
    referer: undefined,
    weight: undefined,
    source: event.source ?? undefined,
    target: event.target ?? undefined,
    value: event.value ?? undefined,
  });
};

export default class BundleGroup {
  /**
   * @type {UniversalContext}
   */
  ctx;

  /**
   * @type {Record<string, RUMBundle>}
   */
  bundles = {};

  /**
   * @type {boolean}
   */
  dirty = false;

  /**
   * @param {UniversalContext} ctx
   * @param {string} key
   * @param {BundleGroupData} [data]
   */
  constructor(ctx, key, data) {
    this.ctx = ctx;
    this.key = key;
    this.bundles = data?.bundles || {};
  }

  active() {
    return this.dirty;
  }

  /**
   * @param {string} sessionId {event.id}--{event.url.pathname}
   * @param {RawRUMEvent} event
   */
  push(sessionId, event) {
    if (!this.bundles[sessionId]) {
      // NOTE: only store what's required in the top level object
      // and skip those properties for the events within it
      this.bundles[sessionId] = getBundleProperties(event);
    }
    this.bundles[sessionId].events.push(getEventProperties(event, this.bundles[sessionId]));
    this.dirty = true;
  }

  async store() {
    if (this.dirty) {
      const data = JSON.stringify({ bundles: this.bundles });
      const { bundleBucket } = HelixStorage.fromContext(this.ctx);
      // this.ctx.log.debug(`storing bundles to ${this.key}.json`);
      await bundleBucket.put(`${this.key}.json`, data, 'application/json');
      this.dirty = false;
    }
  }

  /**
   * @param {UniversalContext} ctx
   * @param {string} domain
   * @param {number} year
   * @param {number} month
   * @param {number} day
   * @param {number} hour
   * @returns {Promise<BundleGroup>}
   */
  static async fromContext(ctx, domain, year, month, day, hour) {
    const { log } = ctx;
    const key = `${domain}/${year}/${month}/${day}/${hour}`;

    if (!ctx.attributes.rumBundleGroups) {
      ctx.attributes.rumBundleGroups = new LRUCache({ name: 'BundleGroup' });
    }

    if (ctx.attributes.rumBundleGroups.has(key)) {
      // @ts-ignore
      return ctx.attributes.rumBundleGroups.get(key);
    }

    log.debug(`hydrating bundlegroup for ${key}`);
    const promise = (async () => {
      let data = { bundles: {} };
      try {
        const { bundleBucket } = HelixStorage.fromContext(ctx);
        const buf = await bundleBucket.get(`${key}.json`);
        if (buf) {
          const txt = new TextDecoder('utf8').decode(buf);
          data = JSON.parse(txt);
        }
      } catch (e) {
        log.error('failed to get bundlegroup', e);
      }
      const group = new BundleGroup(ctx, key, data);
      ctx.attributes.rumBundleGroups.set(key, group);
      return group;
    })();

    ctx.attributes.rumBundleGroups.set(key, promise);
    return promise;
  }
}
