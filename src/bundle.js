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
 * Log files are written from Fastly to S3 every hour on the hour.
 * Each file written contains a single invocation's logs, meaning
 * there's exactly 1 RUM event in each file. The filename follows
 * the format `yyyy-mm-ddTHH:min:sec.ms-{id}.log` (UTC), but we ignore the
 * timestamp in the filename, instead using the value in the event
 * since it is masked by rum-collector.
 */

/**
 * @typedef {{
 *  time: number;
 *  host: string;
 *  url: string;
 *  user_agent: string;
 *  referer: string | null;
 *  weight: number;
 *  id: string;
 *  CLS: number;
 *  LCP: number;
 *  FID: number;
 * }} RUMEvent
 */

/**
 *
 * @param {string[]} raws raw event file contents, stringified JSON
 * @param {Record<string, any>} bundleMap bundles by key
 */
export default function bundle(raws, bundleMap = {}) {
  raws.forEach((raw) => {
    try {
      /** @type {RUMEvent} */
      const event = JSON.parse(raw);
      const date = new Date(event.time);
      const domain = event.host;
      const key = `/${domain}/${date.getUTCFullYear()}/${date.getUTCMonth()}/${date.getUTCDate()}/${date.getUTCHours()}`;
      if (!bundleMap[key]) {
        // eslint-disable-next-line no-param-reassign
        bundleMap[key] = [];
      }
      bundleMap[key].push(event);
    } catch (e) {
      console.error(e);
    }
  });
}
