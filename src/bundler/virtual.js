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

import { fingerprintValue, getCWVEventType, weightedThreshold } from '../support/util.js';

export default [{
  domain: 'aem.live:sidekick',
  test: (e) => e.source === 'sidekick',
  destination(e, info) {
    return {
      key: `/${this.domain}/${info.year}/${info.month}/${info.day}/${info.hour}.json`,
      info: {
        ...info,
        domain: this.domain,
      },
      event: {
        ...e,
        domain: info.domain,
      },
    };
  },
}, {
  // all top events, for viewing all domains' events
  // downsample by 100x
  domain: 'all',
  test: (e) => e.checkpoint === 'top' && Math.random() < 0.01,
  destination(e, info) {
    return {
      key: `/${this.domain}/${info.year}/${info.month}/${info.day}/${info.hour}.json`,
      info: {
        ...info,
        domain: this.domain,
      },
      event: {
        ...e,
        weight: e.weight * 100,
        domain: info.domain,
      },
    };
  },
}, {
  // all top events (new impl), for viewing all domains' events
  // downsample by 100x
  domain: 'aem.live:all',
  test: (e) => (e.checkpoint === 'top' || getCWVEventType(e) != null) && fingerprintValue(e) > weightedThreshold(e),
  hostType(e) {
    if (typeof e.host === 'string') {
      if (e.host.endsWith('.adobeaemcloud.net')) {
        return 'aemcs';
      } else if (e.host.endsWith('.adobecqms.net')) {
        return 'ams';
      } else if (e.host.endsWith('.adobecommerce.net')) {
        return 'commerce';
      }
    }
    return 'helix';
  },
  destination(e, info) {
    return {
      key: `/${this.domain}/${info.year}/${info.month}/${info.day}/${info.hour}.json`,
      info: {
        ...info,
        domain: this.domain,
      },
      event: {
        ...e,
        weight: Math.round(e.weight * (1 / (1 - weightedThreshold(e)))),
        domain: info.domain,
        hostType: this.hostType(e),
      },
    };
  },
}, {
  // collapse (hlx|aem).(live|page) into orgs
  /**
   * @param {RawRUMEvent} _
   * @param {BundleInfo} info
   * @returns {boolean}
   */
  test: (_, info) => /[a-zA-Z0-9-]+--[a-zA-Z0-9-]+--[a-zA-Z0-9-]+.(hlx|aem)\.(page|live)/.test(info.domain),
  /**
   * @param {RawRUMEvent} e
   * @param {BundleInfo} info
   * @returns {{ key: string; info: BundleInfo; event: RawRUMEvent; }}
   */
  destination(e, info) {
    const res = /(?<ref>[a-zA-Z0-9-]+)--(?<site>[a-zA-Z0-9-]+)--(?<org>[a-zA-Z0-9-]+).(hlx|aem)\.(page|live)/.exec(info.domain);
    const { org } = res.groups;
    const domain = `${org}.aem.live`;
    return {
      key: `/${domain}/${info.year}/${info.month}/${info.day}/${info.hour}.json`,
      info: {
        ...info,
        domain,
      },
      event: {
        ...e,
        domain: info.domain,
      },
    };
  },
}, {
  // collapse *.web.pfizer into aem.live org
  domain: 'pfizer.aem.live',
  /**
   * @param {RawRUMEvent} _
   * @param {BundleInfo} info
   * @returns {boolean}
   */
  test: (_, info) => /[^.]+\.web\.pfizer/.test(info.domain),
  /**
   * @param {RawRUMEvent} e
   * @param {BundleInfo} info
   * @returns {{ key: string; info: BundleInfo; event: RawRUMEvent; }}
   */
  destination(e, info) {
    return {
      key: `/${this.domain}/${info.year}/${info.month}/${info.day}/${info.hour}.json`,
      info: {
        ...info,
        domain: this.domain,
      },
      event: {
        ...e,
        domain: info.domain,
      },
    };
  },
}];
