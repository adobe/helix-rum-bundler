/*
 * Copyright 2019 Adobe. All rights reserved.
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
import assert from 'assert';
import { bundleRUM, sortRawEvents } from '../src/bundler.js';
import { DEFAULT_CONTEXT, assertRejectsWithResponse } from './util.js';

describe('bundler Tests', () => {
  describe('sortRawEvents()', () => {
    let log;
    beforeEach(() => {
      log = { warn: () => {} };
    });

    it('ignores urls without host', () => {
      const sorted = sortRawEvents([{ url: '/some/absolute/path' }], log);
      assert.deepStrictEqual(sorted, {});
    });

    it('sorts into domain/date keys', () => {
      const t1 = 0;
      const t2 = 61 * 60 * 1000;

      const sorted = sortRawEvents([
        { url: 'https://example.com', time: t1, checkpoint: 1 },
        { url: 'https://example.com', time: t2, checkpoint: 2 },
        { url: 'http://example.com:80', time: t1, checkpoint: 3 },
      ], log);

      assert.strictEqual(Object.keys(sorted).length, 2);
      assert.deepStrictEqual(sorted['/example.com/1970/1/1/0.json'], {
        events: [
          {
            url: 'https://example.com/',
            time: 0,
            checkpoint: 1,
          },
          {
            url: 'http://example.com/',
            time: 0,
            checkpoint: 3,
          },
        ],
        info: {
          domain: 'example.com',
          year: 1970,
          month: 1,
          day: 1,
          hour: 0,
        },
      });
      assert.deepStrictEqual(sorted['/example.com/1970/1/1/1.json'], {
        events: [
          {
            url: 'https://example.com/',
            time: 3660000,
            checkpoint: 2,
          },
        ],
        info: {
          domain: 'example.com',
          year: 1970,
          month: 1,
          day: 1,
          hour: 1,
        },
      });
    });
  });

  describe('bundleRUM()', () => {
    it('throws 409 if logs are locked', async () => {
      const ctx = DEFAULT_CONTEXT({
        attributes: {
          storage: {
            logBucket: {
              head: () => Promise.resolve({}),
            },
          },
        },
      });

      await assertRejectsWithResponse(bundleRUM(ctx), 409);
    });
  });
});
