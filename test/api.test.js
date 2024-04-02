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
import { parsePath, assertAuthorization } from '../src/api.js';
import { assertRejectsWithResponse } from './util.js';

describe('api Tests', () => {
  describe('assertAuthorization()', () => {
    it('should throw 401 response on unauthorized requests', async () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' } };

      await assertRejectsWithResponse(async () => assertAuthorization(
        new Request('https://localhost/', { headers: {} }),
        ctx,
      ), 401, 'missing x-api-key');

      await assertRejectsWithResponse(async () => assertAuthorization(
        new Request('https://localhost/', { headers: { 'x-api-key': 'bar' } }),
        ctx,
      ), 403, 'invalid x-api-key');
    });

    it('allows x-api-key header', () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' } };

      assert.doesNotThrow(() => assertAuthorization(
        new Request('https://localhost/', { headers: { 'x-api-key': 'foo' } }),
        ctx,
      ));
    });

    it('allows domainkey param', () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' }, data: { domainkey: 'foo' } };

      assert.doesNotThrow(() => assertAuthorization(
        new Request('https://localhost/'),
        ctx,
      ));
    });
  });

  describe('parsePath()', () => {
    it('should throw 404 response on invalid paths', async () => {
      await assertRejectsWithResponse(async () => parsePath('/short.json'), 404, 'invalid path (short)');
      await assertRejectsWithResponse(async () => parsePath('/long/a/b/c/d/e/f/g/h.json'), 404, 'invalid path (long)');
      await assertRejectsWithResponse(async () => parsePath('/no/json/extension'), 404, 'invalid path (wrong extension)');
    });

    it('parses paths', () => {
      // with hour
      let parsed = parsePath('/domain/2024/01/01/0.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/1/1/0');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        domain: 'domain',
        year: 2024,
        month: 1,
        day: 1,
        hour: 0,
        toString: undefined,
      });

      // with day
      parsed = parsePath('/domain/2024/3/4.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/3/4');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        domain: 'domain',
        year: 2024,
        month: 3,
        day: 4,
        toString: undefined,
      });

      // with month
      parsed = parsePath('/domain/2024/12.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/12');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        domain: 'domain',
        year: 2024,
        month: 12,
        toString: undefined,
      });

      // with year
      parsed = parsePath('/domain/2024.json');
      assert.strictEqual(parsed.toString(), '/domain/2024');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        domain: 'domain',
        year: 2024,
        toString: undefined,
      });
    });
  });
});
