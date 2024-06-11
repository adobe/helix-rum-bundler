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

import { fingerprintValue } from '../support/util.js';

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
  test: (e) => {
    const val = fingerprintValue(e);
    return (e.checkpoint === 'top' || /$cwv-/.test(e.checkpoint)) && val < 0.01;
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
        weight: e.weight * 100,
        domain: info.domain,
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
}];
