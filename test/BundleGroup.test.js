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

/* eslint-env mocha */
/* eslint-disable camelcase */

import assert from 'assert';
import { getEventProperties, getBundleProperties } from '../src/BundleGroup.js';

const mockRawEvent = ({
  id = 'ABC',
  checkpoint = 'foo',
  time = 1,
  host = 'rum.hlx.page',
  url = 'https://example.com/some/path?query=true',
  user_agent = 'desktop',
  referer,
  weight = 100,
  INP,
  TTFB,
  CLS,
  LCP,
  FID,
  ...rest
} = {}) => ({
  id,
  checkpoint,
  time,
  host,
  url,
  user_agent,
  referer,
  weight,
  INP,
  TTFB,
  CLS,
  LCP,
  FID,
  ...rest,
});

describe('BundleGroup Tests', () => {
  describe('getBundleProperties()', () => {
    it('adds events array', () => {
      const evt = mockRawEvent();
      const bundleProps = getBundleProperties(evt);

      assert.deepStrictEqual(bundleProps.events, []);
      assert.strictEqual(bundleProps.time, '1970-01-01T00:00:00.001Z');
    });

    it('sets timeSlot property without min/sec/ms', () => {
      const time = Number(new Date('2024-04-02T23:10:12.584Z'));
      const evt = mockRawEvent({ time });
      const bundleProps = getBundleProperties(evt);

      assert.strictEqual(bundleProps.time, '2024-04-02T23:10:12.584Z');
      assert.strictEqual(bundleProps.timeSlot, '2024-04-02T23:00:00.000Z');
    });
  });

  describe('getEventProperties()', () => {
    it('excludes undefined times', () => {
      const bundle = getBundleProperties(mockRawEvent());
      const evt = mockRawEvent({ time: undefined });
      evt.time = undefined;
      const eventProps = getEventProperties(evt, bundle);
      assert.deepStrictEqual(eventProps, { checkpoint: 'foo' });
    });

    it('creates cwv events with value properties', () => {
      const bundle = getBundleProperties(mockRawEvent());
      let eventProps = getEventProperties(mockRawEvent({ checkpoint: 'cwv', INP: 0 }), bundle);
      assert.deepStrictEqual(eventProps, { checkpoint: 'cwv-inp', value: 0, timeDelta: 1 });

      eventProps = getEventProperties(mockRawEvent({ checkpoint: 'cwv', INP: 10 }), bundle);
      assert.deepStrictEqual(eventProps, { checkpoint: 'cwv-inp', value: 10, timeDelta: 1 });

      eventProps = getEventProperties(mockRawEvent({ checkpoint: 'cwv', TTFB: 10 }), bundle);
      assert.deepStrictEqual(eventProps, { checkpoint: 'cwv-ttfb', value: 10, timeDelta: 1 });

      eventProps = getEventProperties(mockRawEvent({ checkpoint: 'cwv', FID: 10 }), bundle);
      assert.deepStrictEqual(eventProps, { checkpoint: 'cwv-fid', value: 10, timeDelta: 1 });

      eventProps = getEventProperties(mockRawEvent({ checkpoint: 'cwv', LCP: 10 }), bundle);
      assert.deepStrictEqual(eventProps, { checkpoint: 'cwv-lcp', value: 10, timeDelta: 1 });

      eventProps = getEventProperties(mockRawEvent({ checkpoint: 'cwv', CLS: 10 }), bundle);
      assert.deepStrictEqual(eventProps, { checkpoint: 'cwv-cls', value: 10, timeDelta: 1 });
    });

    it('creates top level cwv events', () => {
      const bundle = getBundleProperties(mockRawEvent());
      const eventProps = getEventProperties(mockRawEvent({ checkpoint: 'cwv' }), bundle);
      assert.deepStrictEqual(eventProps, { checkpoint: 'cwv', timeDelta: 1 });
    });

    it('removes null value/source/target', () => {
      const bundle = getBundleProperties(mockRawEvent());
      let eventProps = getEventProperties(mockRawEvent({ value: null, source: 'source', target: 'target' }), bundle);
      assert.deepStrictEqual(eventProps, {
        checkpoint: 'foo',
        timeDelta: 1,
        source: 'source',
        target: 'target',
      });

      eventProps = getEventProperties(mockRawEvent({ value: 'value', source: null, target: 'target' }), bundle);
      assert.deepStrictEqual(eventProps, {
        checkpoint: 'foo',
        timeDelta: 1,
        value: 'value',
        target: 'target',
      });

      eventProps = getEventProperties(mockRawEvent({ value: 'value', source: 'source', target: null }), bundle);
      assert.deepStrictEqual(eventProps, {
        checkpoint: 'foo',
        timeDelta: 1,
        value: 'value',
        source: 'source',
      });
    });
  });
});
