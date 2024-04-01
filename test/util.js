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

export const DEFAULT_CONTEXT = (overrides = {}) => ({
  log: console,
  env: {
    ...(overrides.env ?? {}),
  },
  attributes: {
    ...(overrides.attributes ?? {}),
  },
});

/**
 *
 * @param {(...args: any[]) => Promise<any>|Promise} fn
 * @param {number} status
 * @param {string} [xError]
 */
export function assertRejectsWithResponse(fn, status, xError) {
  return (typeof fn === 'function' ? fn() : fn).then(
    () => {
      throw new Error('Expected promise to be rejected');
    },
    (err) => {
      assert.strictEqual(err.response.status, status);
      if (xError) {
        assert.strictEqual(err.response.headers.get('x-error'), xError);
      }
    },
  );
}
