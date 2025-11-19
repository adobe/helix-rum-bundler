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

import fs from 'fs';
import path from 'path';

export default class Profiler {
  data;

  rate = 1000; // ms between ticks

  t0;

  interval;

  filename;

  constructor() {
    this.filename = `memory-${new Date().toISOString().replace(/:/g, '-')}.json`;
    this.data = [[]];
  }

  /**
   * @param {UniversalContext} ctx
   * @returns {Profiler | null}
   */
  static fromContext(ctx) {
    if (!process.env.PROFILE_MEM) {
      return null;
    }
    if (ctx.attributes.profiler) {
      return ctx.attributes.profiler;
    }
    ctx.attributes.profiler = new Profiler();
    return ctx.attributes.profiler;
  }

  start() {
    this.t0 = performance.now();
    this.interval = setInterval(() => {
      this.tick();
    }, this.rate);
  }

  tick() {
    const now = performance.now();
    const diff = now - this.t0;
    this.data[this.data.length - 1].push({
      t: diff,
      memory: process.memoryUsage(),
    });
  }

  next() {
    this.data.push([]);
    this.t0 = performance.now();
  }

  stop() {
    clearInterval(this.interval);
    fs.writeFileSync(
      path.resolve(import.meta.dirname, `../../test/dev/profiler/${this.filename}`),
      JSON.stringify(this.data, null, 2),
    );
    this.data = [[]];
    this.filename = `memory-${new Date().toISOString().replace(/:/g, '-')}.json`;
  }
}
