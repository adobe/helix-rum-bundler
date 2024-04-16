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

import assert from 'assert';
import { Request } from '@adobe/fetch';
import { assertAuthorized, parsePath, getCacheControl } from '../../src/api/bundles.js';
import { assertRejectsWithResponse } from '../util.js';

describe('api/bundles Tests', () => {
  describe('assertAuthorized()', () => {
    it('should throw 401 response on unauthorized requests', async () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' } };

      await assertRejectsWithResponse(async () => assertAuthorized(
        new Request('https://localhost/', { headers: {} }),
        ctx,
      ), 401, 'missing x-api-key');

      await assertRejectsWithResponse(async () => assertAuthorized(
        new Request('https://localhost/', { headers: { 'x-api-key': 'bar' } }),
        ctx,
      ), 403, 'invalid x-api-key');
    });

    it('allows x-api-key header', () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' } };

      assert.doesNotThrow(() => assertAuthorized(
        new Request('https://localhost/', { headers: { 'x-api-key': 'foo' } }),
        ctx,
      ));
    });

    it('allows domainkey param', () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' }, data: { domainkey: 'foo' } };

      assert.doesNotThrow(() => assertAuthorized(
        new Request('https://localhost/'),
        ctx,
      ));
    });
  });

  describe('parsePath()', () => {
    it('should throw 404 response on invalid paths', async () => {
      await assertRejectsWithResponse(async () => parsePath(''), 404, 'invalid path');
      await assertRejectsWithResponse(async () => parsePath('/bundles/domain/notanumber'), 404, 'invalid path');
    });

    it('parses paths', () => {
      // with hour
      let parsed = parsePath('/bundles/domain/2024/01/01/0.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/1/1/0');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        route: 'bundles',
        domain: 'domain',
        year: 2024,
        month: 1,
        day: 1,
        hour: 0,
        toString: undefined,
      });

      const parsedNoJson = parsePath('/bundles/domain/2024/01/01/0');
      assert.deepStrictEqual(
        { ...parsed, toString: undefined },
        { ...parsedNoJson, toString: undefined },
      );

      // with day
      parsed = parsePath('/bundles/domain/2024/3/4.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/3/4');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        route: 'bundles',
        domain: 'domain',
        year: 2024,
        month: 3,
        day: 4,
        hour: undefined,
        toString: undefined,
      });

      // with month
      parsed = parsePath('/bundles/domain/2024/12.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/12');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        route: 'bundles',
        domain: 'domain',
        year: 2024,
        month: 12,
        day: undefined,
        hour: undefined,
        toString: undefined,
      });

      // with year
      parsed = parsePath('/bundles/domain/2024.json');
      assert.strictEqual(parsed.toString(), '/domain/2024');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        route: 'bundles',
        domain: 'domain',
        year: 2024,
        month: undefined,
        day: undefined,
        hour: undefined,
        toString: undefined,
      });
    });
  });

  describe('getCacheControl()', () => {
    const ogDate = Date;
    beforeEach(() => {
      global.Date = class extends Date {
        static _stubbed = [];

        constructor(...args) {
          // eslint-disable-next-line no-underscore-dangle
          super(...(Date._stubbed.shift() || args));
        }

        static stub(...args) {
          // eslint-disable-next-line no-underscore-dangle
          Date._stubbed.push(args);
          return Date;
        }
      };
    });
    afterEach(() => {
      global.Date = ogDate;
    });

    /**
     * NOTE: Date stub uses 0-index month (like the DateConstructor)
     * and the resource uses 1-index month (like the S3 folder structure, api)
     */
    it('daily/hourly bundles >1 year old should be cached forever', () => {
      Date.stub(2024, 0, 1);
      const resource = {
        year: 2023,
        month: 1,
        day: 1,
      };
      let val = getCacheControl(resource); // daily bundle
      assert.strictEqual(val, 'public, max-age=31536000');

      Date.stub(2024, 0, 1);
      resource.hour = 0;
      val = getCacheControl(resource); // hourly bundle
      assert.strictEqual(val, 'public, max-age=31536000');
    });

    it('daily/hourly bundles >1 month old should be cached forever', () => {
      Date.stub(2024, 1, 1);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
      };
      let val = getCacheControl(resource); // daily bundle
      assert.strictEqual(val, 'public, max-age=31536000');

      Date.stub(2024, 1, 1);
      resource.hour = 0;
      val = getCacheControl(resource); // hourly bundle
      assert.strictEqual(val, 'public, max-age=31536000');
    });

    it('monthly bundles >1h past end of month, should be cached forever', () => {
      Date.stub(2024, 1, 2, 1); // feb 2 at 1:00
      const resource = {
        year: 2024,
        month: 1, // jan
      };
      const val = getCacheControl(resource);
      assert.strictEqual(val, 'public, max-age=31536000');
    });

    it('monthly bundles <1h past end of month, should be cached for 12h', () => {
      Date.stub(2024, 0, 2);
      const resource = {
        year: 2024,
        month: 1,
      };
      const val = getCacheControl(resource);
      assert.strictEqual(val, 'public, max-age=43200000');
    });

    it('daily bundles <25h old should be cached for 60min', () => {
      Date.stub(2024, 0, 2);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
      };
      const val = getCacheControl(resource);
      assert.strictEqual(val, 'public, max-age=3600000');
    });

    it('hourly bundles >=70m old should be cached forever', () => {
      Date.stub(2024, 0, 1, 2, 10, 1);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
        hour: 1,
      };
      const val = getCacheControl(resource);
      assert.strictEqual(val, 'public, max-age=31536000');
    });

    it('hourly bundles <70min old should be cached for 10min', () => {
      Date.stub(2024, 0, 1, 2, 0);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
        hour: 1,
      };
      const val = getCacheControl(resource);
      assert.strictEqual(val, 'public, max-age=600000');
    });
  });
});
