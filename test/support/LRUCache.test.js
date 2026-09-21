/*
 * Copyright 2026 Adobe. All rights reserved.
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
import LRUCache from '../../src/support/LRUCache.js';
import { sleep } from '../util.js';

const nopLog = { info: () => {} };

/** @param {boolean} isActive */
const entry = (isActive = false) => ({ active: () => isActive });

const resident = (cache, keys) => keys.filter((key) => cache.has(key));

/**
 * NOTE: entries are timestamped with `Date.now()`, so the writes below are spaced out
 * to give them distinct, comparable recency values.
 */
describe('LRUCache', () => {
  it('purges the least recently used entries', async () => {
    const cache = new LRUCache({ limit: 4, threshold: 0.5, log: nopLog });

    cache.set('a', entry());
    await sleep(2);
    cache.set('b', entry());
    await sleep(2);
    cache.set('c', entry());
    await sleep(2);

    // reading 'a' makes it the most recently used, so 'b' and 'c' are the stale ones
    assert.ok(cache.get('a'));
    await sleep(2);

    // reaching the limit purges `limit * threshold` (2) entries, oldest first
    cache.set('d', entry());

    assert.deepStrictEqual(resident(cache, ['a', 'b', 'c', 'd']), ['a', 'd']);
  });

  it('does not purge active entries', async () => {
    const cache = new LRUCache({ limit: 4, threshold: 0.5, log: nopLog });

    // 'a' is the oldest, but still dirty, so it has to stay
    cache.set('a', entry(true));
    await sleep(2);
    cache.set('b', entry());
    await sleep(2);
    cache.set('c', entry());
    await sleep(2);
    cache.set('d', entry());

    assert.deepStrictEqual(resident(cache, ['a', 'b', 'c', 'd']), ['a', 'c', 'd']);
  });

  it('does not purge pending entries', async () => {
    const cache = new LRUCache({ limit: 2, threshold: 0.5, log: nopLog });

    const pending = Promise.resolve(entry());
    cache.set('a', pending);
    await sleep(2);
    cache.set('b', entry());

    assert.strictEqual(cache.get('a'), pending);
  });

  it('returns undefined for unknown keys', () => {
    const cache = new LRUCache({ log: nopLog });
    assert.strictEqual(cache.has('nope'), false);
    assert.strictEqual(cache.get('nope'), undefined);
  });
});
