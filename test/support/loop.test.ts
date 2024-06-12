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
import { DEFAULT_CONTEXT, assertRejectsWithResponse, sleep } from '../util.js';
import { loop } from '../../src/support/loop.js';

describe('loop()', () => {
  it('passes arguments to function', async () => {
    const fn = (arg1, arg2) => {
      assert.deepStrictEqual(arg1, 'foo');
      assert.deepStrictEqual(arg2, 'bar');
      return true;
    };
    const wrapped = loop(fn, DEFAULT_CONTEXT(), { limit: 100 });
    await assert.doesNotReject(wrapped('foo', 'bar'));
  });

  it('throws timeout response if function loop will exceed timeout', async () => {
    let count = 0;
    const fn = async () => {
      await sleep(10);
      count += 1;
      return count > 10;
    };
    const wrapped = loop(fn, DEFAULT_CONTEXT(), { limit: 50 });
    await assertRejectsWithResponse(wrapped, 504, /^timeout after/);
  });
});