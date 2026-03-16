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
import { Request } from '@adobe/fetch';
import {
  DEFAULT_CONTEXT,
  Nock,
  assertRejectsWithResponse,
} from '../util.js';
import handleRequest from '../../src/api/bedrock.js';

const MESSAGES = [{ role: 'user', content: [{ text: 'Hello' }] }];
const PATH_INFO_SYNC = { suffix: '/bedrock' };
const PATH_INFO_JOBS = { suffix: '/bedrock/jobs' };
const PATH_INFO_JOB = (id) => ({ suffix: `/bedrock/jobs/${id}` });

const REQUEST = ({ method, token = 'superkey', body = null }) => new Request('https://localhost/', {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: body ? JSON.stringify(body) : undefined,
});

describe('api/bedrock Tests', () => {
  /** @type {import('../util.js').Nocker} */
  let nock;

  beforeEach(() => {
    nock = new Nock().env();
  });

  afterEach(() => {
    nock.done();
  });

  describe('POST /bedrock (sync) - authorization & validation', () => {
    it('rejects missing authorization header', async () => {
      const req = new Request('https://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        env: { TMP_SUPERUSER_API_KEY: 'superkey' },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 401, 'missing auth');
    });

    it('rejects invalid token', async () => {
      const req = REQUEST({ method: 'POST', token: 'invalid-key', body: { messages: [] } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        env: { TMP_SUPERUSER_API_KEY: 'superkey' },
        data: { messages: [] },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
    });

    it('rejects missing messages', async () => {
      const req = REQUEST({ method: 'POST', body: {} });
      const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO_SYNC, data: {} });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing messages in request body');
    });

    it('rejects missing modelId when not in env', async () => {
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        env: { BEDROCK_MODEL_ID: undefined },
        data: { messages: MESSAGES },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing modelId in request body or environment');
    });
  });

  describe('POST /bedrock/jobs (async) - authorization & validation', () => {
    it('rejects missing authorization header', async () => {
      const req = new Request('https://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: MESSAGES }),
      });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        env: { TMP_SUPERUSER_API_KEY: 'superkey' },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 401, 'missing auth');
    });

    it('rejects invalid token', async () => {
      const req = REQUEST({ method: 'POST', token: 'invalid-key', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        env: { TMP_SUPERUSER_API_KEY: 'superkey' },
        data: { messages: MESSAGES },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
    });

    it('rejects missing messages', async () => {
      const req = REQUEST({ method: 'POST', body: {} });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        data: {},
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing messages in request body');
    });

    it('rejects missing modelId when not in env', async () => {
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        env: { BEDROCK_MODEL_ID: undefined },
        data: { messages: MESSAGES },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing modelId in request body or environment');
    });
  });

  describe('GET /bedrock/jobs/{jobId} - authorization', () => {
    it('rejects missing authorization header', async () => {
      const req = new Request('https://localhost/', { method: 'GET' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOB('job_123'),
        env: { TMP_SUPERUSER_API_KEY: 'superkey' },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 401, 'missing auth');
    });

    it('rejects invalid token', async () => {
      const req = REQUEST({ method: 'GET', token: 'invalid-key' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOB('job_123'),
        env: { TMP_SUPERUSER_API_KEY: 'superkey' },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
    });
  });

  describe('HTTP method handling', () => {
    it('rejects GET on /bedrock', async () => {
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO_SYNC });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects PUT on /bedrock', async () => {
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO_SYNC });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects PUT on /bedrock/jobs', async () => {
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO_JOBS });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects DELETE on /bedrock/jobs', async () => {
      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO_JOBS });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects POST on /bedrock/jobs/{jobId}', async () => {
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO_JOB('test') });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects PUT on /bedrock/jobs/{jobId}', async () => {
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO_JOB('test') });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects DELETE on /bedrock/jobs/{jobId}', async () => {
      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO_JOB('test') });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });
  });
});

// NOTE: Full integration tests (actual AWS API calls) are in post-deploy.test.js
// These unit tests cover authorization, validation, and routing only.
// The esmock approach for mocking AWS SDK was removed due to excessive load times.
