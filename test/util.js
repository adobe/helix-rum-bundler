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

/* eslint-disable import/no-extraneous-dependencies */

import assert from 'assert';
import nock from 'nock';

/**
 * @typedef {ReturnType<Nock>} Nocker
 */

export const DEFAULT_CONTEXT = (overrides = {}) => ({
  log: console,
  env: {
    BATCH_LIMIT: '100',
    CONCURRENCY_LIMIT: '4',
    TMP_SUPERUSER_API_KEY: 'domainkey',
    BUNDLER_PROCESS_ALL: 'true',
    BUNDLER_DURATION_LIMIT: String(9 * 60 * 1000),
    ...(overrides.env ?? {}),
  },
  attributes: {
    ...(overrides.attributes ?? {}),
  },
  pathInfo: {
    suffix: '/',
    ...(overrides.pathInfo ?? {}),
  },
});

/**
 *
 * @param {((...args: any[]) => Promise<any>)|Promise<any>} fn
 * @param {number} status
 * @param {string|RegExp} [xError]
 */
export function assertRejectsWithResponse(fn, status, xError) {
  return (typeof fn === 'function' ? fn() : fn).then(
    () => {
      throw new Error('Expected promise to be rejected');
    },
    (err) => {
      assert.ok(err.response, `Expected error to have response, got error: ${err.message}`);
      assert.strictEqual(err.response.status, status);
      if (xError) {
        const actualXError = err.response.headers.get('x-error');
        if (typeof xError === 'string') {
          assert.strictEqual(actualXError, xError);
        } else {
          assert.ok(xError.test(actualXError));
        }
      }
    },
  );
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
// eslint-disable-next-line no-promise-executor-return
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function Nock() {
  /** @type {Record<string, nock.Scope} */
  const scopes = {};

  /** @type {any[]} */
  let unmatched;

  /** @type {Record<string, unknown>} */
  let savedEnv;

  function noMatchHandler(req) {
    unmatched.push(req);
  }

  /**
   * @param {string} url
   * @returns {nock.Scope}
   */
  function nocker(url) {
    let scope = scopes[url];
    if (!scope) {
      scope = nock(url);
      scopes[url] = scope;
    }
    if (!unmatched) {
      unmatched = [];
      nock.emitter.on('no match', noMatchHandler);
    }
    nock.disableNetConnect();
    return scope;
  }

  nocker.env = (overrides = {}) => {
    savedEnv = { ...process.env };
    Object.assign(process.env, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'dummy-id',
      AWS_SECRET_ACCESS_KEY: 'dummy-key',
      ...overrides,
    });
    return nocker;
  };

  nocker.done = () => {
    if (savedEnv) {
      process.env = savedEnv;
    }

    if (unmatched) {
      assert.deepStrictEqual(unmatched.map((req) => req.options || req), []);
      nock.emitter.off('no match', noMatchHandler);
    }
    try {
      Object.values(scopes).forEach((s) => s.done());
    } finally {
      nock.cleanAll();
    }
  };

  return nocker;
}
