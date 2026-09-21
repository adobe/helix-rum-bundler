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

/* eslint-disable no-await-in-loop */

import v8 from 'node:v8';
import Profiler from './Profiler.js';
import { HelixStorage } from './storage.js';
import { errorWithResponse, getEnvVar } from './util.js';

const DEFAULT_MEMORY_LOG_INTERVAL = 5000;

/**
 * @returns {Record<string, number>}
 */
const memoryUsage = () => ({
  ...process.memoryUsage(),
  heapLimit: v8.getHeapStatistics().heap_size_limit,
});

/**
 * Name of the phase currently in flight, ie. the most recent `start:` mark with no matching
 * `end:` mark, so a memory sample can be attributed to a part of the iteration.
 *
 * @returns {string|undefined}
 */
const currentPhase = () => {
  const marks = performance.getEntriesByType('mark');
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const { name } = marks[i];
    if (name.startsWith('start:')) {
      const phase = name.slice('start:'.length);
      if (!marks.some((m) => m.name === `end:${phase}`)) {
        return phase;
      }
    }
  }
  return undefined;
};

/**
 * @param {UniversalContext} ctx
 * @param {Object} data
 */
async function writeLogs(ctx, data) {
  const {
    invocation: { event: { task } },
    attributes: { start: now },
  } = ctx;
  const day = now.getUTCDate();
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();
  const { logBucket } = HelixStorage.fromContext(ctx);

  // get existing
  let existing = {};
  const buf = await logBucket.get(`bundler/${task}/${year}/${month}/${day}.json`);
  if (buf) {
    existing = JSON.parse(buf.toString());
  }

  existing.performance = existing.performance || [];
  existing.performance.push(data);

  await logBucket.put(`bundler/${task}/${year}/${month}/${day}.json`, JSON.stringify(existing), 'application/json');
}

/**
 * @typedef {{ limit: number; }} LoopOpts
 * @type {<
*  TFunc extends (...args: any[]) => boolean|Promise<boolean>
* >(
*  fn: TFunc,
*  ctx: UniversalContext,
*  opts: LoopOpts
* ) => (...args: Parameters<TFunc>) => Promise<void>}
*/
export const loop = (fn, ctx, opts) => {
  const { limit } = opts;
  const profiler = Profiler.fromContext(ctx);

  return async (...args) => {
    let done = false;
    let before = performance.now();
    const { task } = ctx.invocation?.event || {};

    /**
     * Highest sample seen so far during the current iteration.
     * @type {Record<string, number>|undefined}
     */
    let peak;
    const sample = () => {
      const memory = memoryUsage();
      if (!peak || memory.rss > peak.rss) {
        peak = memory;
      }
      return memory;
    };

    const state = {
      timer: 0,
      /** @type {number[]} */
      times: [],
      average() {
        return this.timer / this.times.length;
      },
      /** @param {number} t */
      push(t) {
        this.times.push(t);
        this.timer += t;
      },
    };

    /**
     * A container level OOM kills the process outright, so anything logged only once an
     * iteration completes is lost for the iteration that actually died - which is the one worth
     * seeing. Sample as we go instead, so the trace reaches CloudWatch ahead of the kill.
     * Set `MEMORY_LOG_INTERVAL` to 0 to turn it off.
     */
    const heartbeatMs = getEnvVar(ctx, 'MEMORY_LOG_INTERVAL', DEFAULT_MEMORY_LOG_INTERVAL, 'integer');
    const heartbeat = heartbeatMs > 0
      ? setInterval(() => {
        ctx.log.info(JSON.stringify({
          metric: 'bundler-memory',
          task,
          loop: state.times.length,
          phase: currentPhase(),
          memory: sample(),
        }));
      }, heartbeatMs)
      : undefined;
    // never keep the process alive on its own account
    heartbeat?.unref?.();

    try {
      while (!done) {
        done = await fn(...args);

        const marks = performance.getEntriesByType('mark');
        const starts = marks.filter((m) => m.name.startsWith('start'));
        const measures = starts.reduce((acc, start) => {
          const name = start.name.replace('start:', '');
          const end = marks.find((m) => m.name === `end:${name}`);
          if (end) {
            acc[name] = end.startTime - start.startTime;
          }
          return acc;
        }, {});
        /**
         * `memory` is the state the iteration finished in; `peakMemory` is the highest the
         * heartbeat saw while it ran, which is the number that matters - peak occurs mid
         * iteration, while the parsed events and the bundles built from them are both live.
         *
         * `heapUsed` growing across iterations means retained JS objects (the caches), while
         * `external`/`arrayBuffers` growing means buffers. `heapLimit` is what V8 will actually
         * allow, which it derives from the container's memory and is not the same number as the
         * lambda's configured memory.
         */
        const memory = sample();
        ctx.log.info(JSON.stringify({
          metric: 'bundler-performance',
          task,
          loop: state.times.length,
          measures,
          memory,
          peakMemory: peak,
          stats: ctx.attributes.stats,
        }));
        if ([true, 'true'].includes(ctx.env.WRITE_PERF_LOGS)) {
          await writeLogs(ctx, {
            time: new Date().toISOString(),
            task,
            measures,
            memory,
            peakMemory: peak,
            stats: ctx.attributes.stats,
          });
        }
        performance.clearMarks();
        ctx.attributes.stats = {};
        peak = undefined;

        const after = performance.now();
        const dur = after - before;
        before = after;
        state.push(dur);

        if (state.timer + state.average() >= limit) {
          throw errorWithResponse(
            504,
            `timeout after ${state.times.length} runs (${Math.round(state.timer)} + ${Math.round(state.average())} >= ${limit})`,
          );
        }

        profiler?.next();
      }
    } finally {
      clearInterval(heartbeat);
    }
  };
};
