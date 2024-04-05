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
/// <reference path="./types.d.ts" />
// @ts-check

import { Response } from '@adobe/fetch';
import { promisify } from 'util';
import { gzip, brotliCompress } from 'zlib';

class ErrorWithResponse extends Error {
  /**
   * @param {string} message used for logging
   * @param {RResponse} response used as response
   */
  constructor(message, response) {
    super(message);
    this.response = response;
  }
}

/**
 * @param {number} status status code
 * @param {string} xError public, returned as x-error header
 * @param {string} [message=''] private, logged and not returned to client
 * @returns {ErrorWithResponse}
 */
export function errorWithResponse(status, xError, message = '') {
  return new ErrorWithResponse(
    message,
    new Response('', {
      status,
      headers: {
        'x-error': xError,
      },
    }),
  );
}

/**
 * @type {<
 *  TType extends 'integer'|'string'|undefined,
 *  TReturn = TType extends 'integer' ? number : string
 * >(
 *  ctx: UniversalContext,
 *  key: string,
 *  defaultVal: TReturn,
 *  type: TType
 * ) => TReturn}
 */
export const getEnvVar = (ctx, key, defaultVal, type) => {
  if (!ctx.env[key]) {
    return defaultVal;
  }
  // @ts-ignore
  return type === 'integer'
    ? parseInt(ctx.env[key], 10)
    : ctx.env[key];
};

/**
 * Get yesterday's date
 * @param {number} year
 * @param {number} month
 * @param {number} date
 * @returns {[year: number, month: number, date: number]}
 */
export const yesterday = (year, month, date) => {
  if (date > 1) {
    return [year, month, date - 1];
  }
  if (month > 1) {
    return [year, month - 1, new Date(year, month - 1, 0).getDate()];
  }
  return [year - 1, 12, 31];
};

/**
 * @type {<T extends Record<string, unknown>>(obj: T) => T}
 */
export const pruneUndefined = (obj) => {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // @ts-ignore
  return result;
};

/**
 * @typedef {{ limit: number; }} TimeoutOpts
 * @type {<
 *  TFunc extends (...args: any[]) => Promise<boolean>
 * >(
 *  fn: TFunc,
 *  opts: TimeoutOpts
 * ) => (...args: Parameters<TFunc>) => Promise<void>}
 */
export const timeout = (fn, opts) => {
  const { limit } = opts;

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
      // eslint-disable-next-line no-await-in-loop
      done = await fn(...args);

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
    }
  };
};

/**
 * Conditionally compress response body
 * @param {UniversalContext} ctx
 * @param {RRequest} req
 * @param {string} data
 * @param {Record<string, string>} [headers]
 */
export const compressBody = async (ctx, req, data, headers = {}) => {
  const { log } = ctx;

  if (!headers['Content-Type'] || headers['content-type']) {
    // eslint-disable-next-line no-param-reassign
    headers['Content-Type'] = 'application/json';
  }

  const acceptEncoding = req.headers.get('accept-encoding');
  if (!acceptEncoding) {
    return new Response(data, { headers });
  }

  if (acceptEncoding.includes('br')) {
    const compressed = await promisify(brotliCompress)(data);
    log.debug(`compressed ~${data.length}B to ${compressed.byteLength}B with brotli`);
    return new Response(compressed, {
      headers: {
        'Content-Encoding': 'br',
        ...headers,
      },
    });
  }

  if (acceptEncoding.includes('gzip')) {
    const compressed = await promisify(gzip)(data);
    log.debug(`compressed ~${data.length}B to ${compressed.byteLength}B with gzip`);
    return new Response(compressed, {
      headers: {
        'Content-Encoding': 'gzip',
        ...headers,
      },
    });
  }
  return new Response(data, { headers });
};
