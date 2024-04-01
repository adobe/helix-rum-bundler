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

// @ts-check

import { HelixStorage } from './support/storage.js';

/**
 * @type {<T extends Record<string, unknown>>(obj: T) => T}
 */
const pruneUndefined = (obj) => {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // @ts-ignore
  return result;
};

/**
 * @param {RawRUMEvent} event
 */
const getBundleProperties = (event) => {
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
    events: [],
  };
};

/**
 * @param {RawRUMEvent} event
 */
const getCWVEventType = (event) => {
  if (event.TTFB != null) {
    return 'TTFB';
  }
  if (event.FID != null) {
    return 'FID';
  }
  if (event.LCP != null) {
    return 'LCP';
  }
  if (event.CLS != null) {
    return 'CLS';
  }
  if (event.INP != null) {
    return 'INP';
  }
  return null;
};

/**
 * @param {RawRUMEvent} event
 * @param {RUMBundle} bundle
 * @returns {RUMEvent}
 */
const getEventProperties = (event, bundle) => {
  // custom handling cases for specific event types
  if (event.checkpoint === 'cwv') {
    const type = getCWVEventType(event);
    if (type) {
      // @ts-ignore
      return {
        checkpoint: `cwv-${type.toLowerCase()}`,
        value: event[type],
      };
    }
  }

  // @ts-ignore
  return pruneUndefined({
    ...event,
    timeDelta: event.time - Number(new Date(bundle.timeSlot)),
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
      this.ctx.log.debug(`storing bundle to ${this.key}.json`);
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
      ctx.attributes.rumBundleGroups = {};
    }

    if (ctx.attributes.rumBundleGroups[key]) {
      return ctx.attributes.rumBundleGroups[key];
    }

    log.debug(`hydrating bundlegroup for ${key}`);
    ctx.attributes.rumBundleGroups[key] = (async () => {
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
      ctx.attributes.rumBundleGroups[key] = new BundleGroup(ctx, key, data);
      return ctx.attributes.rumBundleGroups[key];
    })();
    return ctx.attributes.rumBundleGroups[key];
  }
}
