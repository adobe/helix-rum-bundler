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
import {
  pruneUndefined, getEnvVar, yesterday, timeout,
} from '../src/util.js';
import { assertRejectsWithResponse, sleep } from './util.js';

describe('util Tests', () => {
  describe('pruneUndefined()', () => {
    it('removes undefined values', () => {
      const obj = {
        a: 1,
        b: undefined,
        c: null,
      };
      assert.deepStrictEqual(pruneUndefined(obj), { a: 1, c: null });
    });
  });

  describe('getEnvVar()', () => {
    it('parses integers', () => {
      const val = getEnvVar({ env: { TEST: '123' } }, 'TEST', 456, 'integer');
      assert.strictEqual(val, 123);
    });

    it('does not parse strings', () => {
      const val = getEnvVar({ env: { TEST: 'foo' } }, 'TEST', 'bar');
      assert.strictEqual(val, 'foo');
    });

    it('returns default value if env variable is nullish', () => {
      let val = getEnvVar({ env: { TEST: null } }, 'TEST', 1, 'integer');
      assert.strictEqual(val, 1);

      val = getEnvVar({ env: { TEST: undefined } }, 'TEST', 2, 'integer');
      assert.strictEqual(val, 2);

      val = getEnvVar({ env: { TEST: '' } }, 'TEST', 3, 'integer');
      assert.strictEqual(val, 3);
    });
  });

  describe('yesterday()', () => {
    it('returns the previous day', () => {
      let val = yesterday(2024, 1, 2);
      assert.deepStrictEqual(val, [2024, 1, 1]);

      // new year
      val = yesterday(2024, 1, 1);
      assert.deepStrictEqual(val, [2023, 12, 31]);

      // 31 day month
      val = yesterday(2024, 4, 1);
      assert.deepStrictEqual(val, [2024, 3, 31]);

      // leap year
      val = yesterday(2024, 3, 1);
      assert.deepStrictEqual(val, [2024, 2, 29]);

      // non-leap year
      val = yesterday(2023, 3, 1);
      assert.deepStrictEqual(val, [2023, 2, 28]);
    });
  });

  describe('timeout()', () => {
    it('passes arguments to function', async () => {
      const fn = (arg1, arg2) => {
        assert.deepStrictEqual(arg1, 'foo');
        assert.deepStrictEqual(arg2, 'bar');
        return true;
      };
      const wrapped = timeout(fn, { limit: 100, log: console });
      await assert.doesNotReject(wrapped('foo', 'bar'));
    });

    it('throws timeout response if function loop will exceed timeout', async () => {
      let count = 0;
      const fn = async () => {
        await sleep(10);
        count += 1;
        return count > 10;
      };
      const wrapped = timeout(fn, { limit: 50, log: console });
      await assertRejectsWithResponse(wrapped, 504, /^timeout after 4 runs/);
    });
  });
});
