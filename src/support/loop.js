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

import Profiler from './Profiler.js';
import { HelixStorage } from './storage.js';
import { errorWithResponse } from './util.js';

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
      const { task } = ctx.invocation?.event || {};
      ctx.log.info(JSON.stringify({
        metric: 'bundler-performance',
        task,
        loop: state.times.length,
        measures,
        stats: ctx.attributes.stats,
      }));
      if ([true, 'true'].includes(ctx.env.WRITE_PERF_LOGS)) {
        await writeLogs(ctx, {
          time: new Date().toISOString(),
          task,
          measures,
          stats: ctx.attributes.stats,
        });
      }
      performance.clearMarks();
      ctx.attributes.stats = {};

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
  };
};
