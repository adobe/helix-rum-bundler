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

/**
 * @param {object} ctx
 * @param {string} metric
 * @returns {string[]}
 */
const logsMatching = (ctx, metric) => ctx.log.calls.info
  .map((args) => args?.[0])
  .filter((line) => typeof line === 'string' && line.startsWith(`{"metric":"${metric}"`));

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

  /**
   * A container level OOM kills the process outright, so a sample taken only once the iteration
   * returns never reaches CloudWatch for the iteration that died.
   */
  it('logs memory while an iteration is still running', async () => {
    const ctx = DEFAULT_CONTEXT({ env: { MEMORY_LOG_INTERVAL: '10' } });
    /** @type {string[]} */
    let memoryDuringRun = [];
    /** @type {string[]} */
    let perfDuringRun = [];

    const fn = async () => {
      // sample what had been logged part way through, before this iteration returns
      await sleep(60);
      memoryDuringRun = logsMatching(ctx, 'bundler-memory');
      perfDuringRun = logsMatching(ctx, 'bundler-performance');
      return true;
    };
    await loop(fn, ctx, { limit: 10000 })();

    assert.ok(memoryDuringRun.length > 0, 'expected a memory sample before the iteration returned');
    // ...while the per-iteration reporter had not run, so this is the only record an OOM leaves
    assert.deepStrictEqual(perfDuringRun, []);

    const [first] = memoryDuringRun.map((l) => JSON.parse(l));
    assert.strictEqual(typeof first.memory.heapUsed, 'number');
    assert.strictEqual(typeof first.memory.heapLimit, 'number');
    assert.strictEqual(first.loop, 0);
  });

  it('attributes memory samples to the phase in flight', async () => {
    const ctx = DEFAULT_CONTEXT({ env: { MEMORY_LOG_INTERVAL: '10' } });

    const fn = async () => {
      performance.mark('start:total');
      performance.mark('start:import-events');
      await sleep(40);
      performance.mark('end:import-events');
      await sleep(40);
      return true;
    };
    await loop(fn, ctx, { limit: 10000 })();

    const phases = logsMatching(ctx, 'bundler-memory').map((l) => JSON.parse(l).phase);
    assert.ok(phases.includes('import-events'), `expected an import-events sample, got ${phases}`);
    // once that phase ends, samples fall back to the enclosing one
    assert.ok(phases.includes('total'), `expected a total sample, got ${phases}`);
  });

  it('reports the peak seen during the iteration, not just the final state', async () => {
    const ctx = DEFAULT_CONTEXT({ env: { MEMORY_LOG_INTERVAL: '10' } });

    const fn = async () => {
      await sleep(40);
      return true;
    };
    await loop(fn, ctx, { limit: 10000 })();

    const [perf] = logsMatching(ctx, 'bundler-performance').map((l) => JSON.parse(l));
    assert.ok(perf.peakMemory, 'expected peakMemory to be reported');
    assert.ok(
      perf.peakMemory.rss >= perf.memory.rss,
      'peak should be at least the closing sample',
    );
  });

  it('can be turned off', async () => {
    const ctx = DEFAULT_CONTEXT({ env: { MEMORY_LOG_INTERVAL: '0' } });

    const fn = async () => {
      await sleep(40);
      return true;
    };
    await loop(fn, ctx, { limit: 10000 })();

    assert.deepStrictEqual(logsMatching(ctx, 'bundler-memory'), []);
    // the per-iteration line is unaffected
    assert.strictEqual(logsMatching(ctx, 'bundler-performance').length, 1);
  });
});
