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

import assert from 'assert';
import { assertAuthorized, getTTL } from '../../src/api/bundles.js';
import {
  DEFAULT_CONTEXT, Nock, assertRejectsWithResponse, mockDate,
} from '../util.js';

describe('api/bundles Tests', () => {
  describe('assertAuthorized()', () => {
    /** @type {import('../util.js').Nocker} */
    let nock;

    beforeEach(() => {
      nock = new Nock().env();
    });
    afterEach(() => {
      nock.done();
    });

    it('should throw 401 response on unauthorized requests', async () => {
      nock.domainKey('example.com', 'correct');

      const ctx = DEFAULT_CONTEXT({ data: { domainkey: 'notcorrect' } });
      await assertRejectsWithResponse(async () => assertAuthorized(ctx, 'example.com'), 403, 'invalid domainkey param');
    });

    it('should throw 401 response on missing domainkey files', async () => {
      nock.domainKey('example.com', null);

      const ctx = DEFAULT_CONTEXT({ data: { domainkey: 'anything' } });
      await assertRejectsWithResponse(async () => assertAuthorized(ctx, 'example.com'), 401, 'domainkey not set');
    });

    it('should throw 401 response on revoked domainkeys', async () => {
      nock.domainKey('example.com', 'revoked');

      const ctx = DEFAULT_CONTEXT({ data: { domainkey: 'anything' } });
      await assertRejectsWithResponse(async () => assertAuthorized(ctx, 'example.com'), 401, 'domainkey revoked');
    });

    it('allows domainkey param', async () => {
      nock.domainKey('example.com', 'foo');
      const ctx = DEFAULT_CONTEXT({ data: { domainkey: 'foo' } });

      await assert.doesNotReject(() => assertAuthorized(
        ctx,
        'example.com',
      ));
    });
  });

  describe('getTTL()', () => {
    beforeEach(() => {
      mockDate();
    });
    afterEach(() => {
      global.Date.reset();
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
      let val = getTTL(resource); // daily bundle
      assert.strictEqual(val, 31536000);

      Date.stub(2024, 0, 1);
      resource.hour = 0;
      val = getTTL(resource); // hourly bundle
      assert.strictEqual(val, 31536000);
    });

    it('daily/hourly bundles >1 month old should be cached forever', () => {
      Date.stub(2024, 1, 1);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
      };
      let val = getTTL(resource); // daily bundle
      assert.strictEqual(val, 31536000);

      Date.stub(2024, 1, 1);
      resource.hour = 0;
      val = getTTL(resource); // hourly bundle
      assert.strictEqual(val, 31536000);
    });

    it('monthly bundles >12h past end of month, should be cached forever', () => {
      Date.stub(2024, 1, 2, 12); // feb 2 at 1:00
      const resource = {
        year: 2024,
        month: 1, // jan
      };
      const val = getTTL(resource);
      assert.strictEqual(val, 31536000);
    });

    it('monthly bundles <12h past end of month, should be cached for 6h', () => {
      Date.stub(2024, 0, 2);
      const resource = {
        year: 2024,
        month: 1,
      };
      const val = getTTL(resource);
      assert.strictEqual(val, 21600);
    });

    it('daily bundles <25h old should be cached for 60min', () => {
      Date.stub(2024, 0, 2);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
      };
      const val = getTTL(resource);
      assert.strictEqual(val, 3600);
    });

    it('hourly bundles >=3h old should be cached forever', () => {
      Date.stub(2024, 0, 1, 5, 1);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
        hour: 1,
      };
      const val = getTTL(resource);
      assert.strictEqual(val, 31536000);
    });

    it('hourly bundles <3hmin old should be cached for 10min', () => {
      Date.stub(2024, 0, 1, 2, 0);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
        hour: 1,
      };
      const val = getTTL(resource);
      assert.strictEqual(val, 600);
    });
  });
});
