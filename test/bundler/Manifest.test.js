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
import Manifest from '../../src/bundler/Manifest.js';

/**
 * @param {(data: string) => Promise<void>|void} onPut
 */
const ctxWithBucket = (onPut) => ({
  log: { debug: () => {}, error: () => {} },
  attributes: {
    storage: {
      bundleBucket: { put: (_key, data) => onPut(data) },
    },
  },
});

describe('Manifest Tests', () => {
  describe('store()', () => {
    it('stays dirty when the write fails, so it is retried', async () => {
      const manifest = new Manifest(ctxWithBucket(() => {
        throw Error('nope');
      }), 'key', 2024, 1, 2);
      manifest.add('sessionId', 3);
      assert.strictEqual(manifest.active(), true);

      await assert.rejects(manifest.store(), /nope/);
      assert.strictEqual(manifest.active(), true, 'unsaved manifest must stay dirty');
    });

    /**
     * Pending saves are flushed part way through a domain, so a store can be in flight while
     * later hours of the same domain are still adding sessions.
     */
    it('does not drop a session added while the write is in flight', async () => {
      /** @type {string[]} */
      const written = [];
      let release;
      const inFlight = new Promise((resolve) => {
        release = resolve;
      });

      const manifest = new Manifest(ctxWithBucket(async (data) => {
        written.push(data);
        await inFlight;
      }), 'key', 2024, 1, 2);

      manifest.add('first', 1);
      const storing = manifest.store();

      manifest.add('second', 2);
      release();
      await storing;

      assert.strictEqual(manifest.active(), true, 'the later session leaves it dirty');
      assert.ok(!written[0].includes('second'), 'first write could not have included it');

      await manifest.store();
      assert.ok(written[1].includes('second'), 'second write must include the late session');
      assert.strictEqual(manifest.active(), false);
    });

    it('is a no-op when not dirty', async () => {
      let puts = 0;
      const manifest = new Manifest(ctxWithBucket(() => {
        puts += 1;
      }), 'key', 2024, 1, 2);
      await manifest.store();
      assert.strictEqual(puts, 0);
    });
  });
});
