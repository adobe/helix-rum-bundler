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
import {
  pruneUndefined,
  getEnvVar,
  yesterday,
  calculateDownsample,
  magnitude,
  weightedThreshold,
} from '../../src/support/util.js';

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

  describe('magnitude()', () => {
    it('returns the floor order of magnitude', () => {
      assert.deepEqual(magnitude(0), 0);
      assert.deepEqual(magnitude(0.1), 0.1);
      assert.deepEqual(magnitude(1), 1);
      assert.deepEqual(magnitude(10), 10);
      assert.deepEqual(magnitude(100), 100);
      assert.deepEqual(magnitude(1000), 1000);
      assert.deepEqual(magnitude(10000), 10000);

      assert.deepEqual(magnitude(9), 1);
      assert.deepEqual(magnitude(90), 10);
      assert.deepEqual(magnitude(900), 100);
      assert.deepEqual(magnitude(9000), 1000);
      assert.deepEqual(magnitude(90000), 10000);
    });
  });

  describe('calculateDownsample()', () => {
    it('fewer than maximum, dont reduce', () => {
      const { weightFactor, reductionFactor } = calculateDownsample(10, 100);
      assert.strictEqual(weightFactor, 1);
      assert.strictEqual(reductionFactor, 0);
    });

    it('10x maximum, reduce 90%', () => {
      const { weightFactor, reductionFactor } = calculateDownsample(100, 10);
      assert.strictEqual(weightFactor, 10);
      assert.strictEqual(reductionFactor, 0.9);
    });

    it('100x maximum, reduce 99%', () => {
      const { weightFactor, reductionFactor } = calculateDownsample(1000, 10);
      assert.strictEqual(weightFactor, 100);
      assert.strictEqual(reductionFactor, 0.99);
    });

    it('allows non-magnitude weight factors', () => {
      const { weightFactor, reductionFactor } = calculateDownsample(2398.44, 10);
      assert.strictEqual(weightFactor, 240);
      assert.strictEqual(reductionFactor, 0.9958306232384383);
    });
  });

  describe('weighedThreshold()', () => {
    it('calculates the threshold', () => {
      assert.strictEqual(weightedThreshold({ weight: 1 }), 0.9999);
      assert.strictEqual(weightedThreshold({ weight: 10 }), 0.999);
      assert.strictEqual(weightedThreshold({ weight: 100 }), 0.99);
      assert.strictEqual(weightedThreshold({ weight: 1000 }), 0.9);
      assert.strictEqual(weightedThreshold({ weight: 10000 }), 0.010000000000000009);
      assert.strictEqual(weightedThreshold({ weight: 100000 }), 0.010000000000000009);
    });
  });
});
