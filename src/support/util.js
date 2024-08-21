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

import crypto from 'crypto';
import { promisify } from 'util';
import { gzip, brotliCompress } from 'zlib';
import { keepAliveNoCache, Response } from '@adobe/fetch';

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
 * @param {string} [xError] public, returned as x-error header
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
 * @param {UniversalContext} ctx
 */
export function getFetch(ctx) {
  if (!ctx.attributes.fetchContext) {
    ctx.attributes.fetchContext = keepAliveNoCache({
      userAgent: 'adobe-fetch', // static user-agent for recorded tests
    });
  }
  return ctx.attributes.fetchContext.fetch;
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
  if (!headers.Vary && !headers.vary) {
    // eslint-disable-next-line no-param-reassign
    headers.vary = 'accept-encoding';
  } else if (!headers.vary.toLowerCase().includes('accept-encoding')) {
    // eslint-disable-next-line no-param-reassign
    headers.vary += ', accept-encoding';
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

/**
 * calculate nearest order of magnitude
 * @param {number} x
 * @returns {number}
 */
export const magnitude = (x) => {
  const order = Math.floor(Math.log(x) / Math.LN10 + 0.000000001);
  return 10 ** order;
};

/**
 * calculate downsampling factors
 * @param {number} total
 * @param {number} maximum
 */
export const calculateDownsample = (total, maximum) => {
  // if max == 100
  // t = 100 => 0, 1
  // t = 600 => 0, 1
  // t = 1000 => 0.9, 10
  // t = 4000 => 0.9, 10
  // etc..

  if (total <= maximum) {
    return {
      reductionFactor: 0,
      weightFactor: 1,
    };
  }

  const mTotal = magnitude(total);
  const mMax = magnitude(maximum);
  if (mTotal <= mMax) {
    return {
      reductionFactor: 0,
      weightFactor: 1,
    };
  }

  const reductionFactor = (mTotal - mMax) / mTotal;
  const weightFactor = (mTotal > mMax || reductionFactor > 1)
    ? Math.round(1 / (1 - reductionFactor))
    : 1;
  return {
    reductionFactor,
    weightFactor,
  };
};

/**
 * @param {RawRUMEvent} event
 * @returns {string|null}
 */
export const getCWVEventType = (event) => {
  if (event.TTFB != null) {
    return 'TTFB';
  }
  if (event.FID != null) {
    return 'FID';
  }
  if (event.LCP != null) {
    return 'LCP';
  }
  if (event.CLS != null) {
    return 'CLS';
  }
  if (event.INP != null) {
    return 'INP';
  }
  return null;
};

/**
 * @param {{id: string; url: string; weight: number;}} event
 */
export const fingerprint = (event) => {
  const uid = `${event.id}--${event.url}--${event.weight || 0}`;
  console.log('uid: ', uid);
  return crypto.createHash('md5').update(uid).digest('hex');
};

/**
 * @param {{id: string; url: string; weight: number;}} event
 * @returns {number} between 0 and 1, evenly distributed
 */
export const fingerprintValue = (event) => Number.parseInt(fingerprint(event), 16) / 3.402824e38;
