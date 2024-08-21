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

import { fingerprintValue, getCWVEventType } from '../support/util.js';

export default [{
  domain: 'sidekick',
  test: (e) => e.checkpoint.startsWith('sidekick:'),
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
  test: (e) => (e.checkpoint === 'top' || getCWVEventType(e) != null) && fingerprintValue(e) < 0.01,
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
        hostType: (typeof e.host === 'string' && e.host.endsWith('.adobeaemcloud.net')) ? 'aemcs' : 'helix',
      },
    };
  },
}, {
  // sidekick library
  domain: 'sidekick.library',
  test: (e) => e.checkpoint.startsWith('library:'),
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
  // crosswalk
  domain: 'crosswalk',
  test: (e) => e.checkpoint.startsWith('crosswalk:'),
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
  // collapse (hlx|aem).(live|page) into org/sites
  /**
   * @param {RawRUMEvent} _
   * @param {BundleInfo} info
   * @returns {boolean}
   */
  test: (_, info) => /[a-zA-Z0-9-]+--[a-zA-Z0-9-]+--[a-zA-Z0-9-]+.(hlx|aem)\.(page|live)/.test(info.domain),
  /**
   * @param {RawRUMEvent} e
   * @param {BundleInfo} info
   * @returns {{ key: string; info: BundleInfo; event: RawRUMEvent; }[]}
   */
  destination(e, info) {
    const res = /(?<ref>[a-zA-Z0-9-]+)--(?<site>[a-zA-Z0-9-]+)--(?<org>[a-zA-Z0-9-]+).(hlx|aem)\.(page|live)/.exec(info.domain);
    const { site, org } = res.groups;
    const siteDomain = `${site}--${org}.aem.live`;
    const orgDomain = `${org}--hlxsites.aem.live`;
    return [
      // site
      {
        key: `/${siteDomain}/${info.year}/${info.month}/${info.day}/${info.hour}.json`,
        info: {
          ...info,
          domain: siteDomain,
        },
        event: {
          ...e,
          domain: info.domain,
        },
      },
      // org
      {
        key: `/${orgDomain}/${info.year}/${info.month}/${info.day}/${info.hour}.json`,
        info: {
          ...info,
          domain: orgDomain,
        },
        event: {
          ...e,
          domain: info.domain,
        },
      },
    ];
  },
}];
