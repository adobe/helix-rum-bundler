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
import esmock from 'esmock';
import { Request } from '@adobe/fetch';
import {
  DEFAULT_CONTEXT,
  Nock,
  assertRejectsWithResponse,
} from '../util.js';

const REQUEST = ({ method, token = 'superkey', body = null }) => new Request('https://localhost/', {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: body ? JSON.stringify(body) : undefined,
});

const MOCK_INVOKE_RESPONSE = {
  body: new TextEncoder().encode(JSON.stringify({
    content: [{ type: 'text', text: 'Hello! How can I help you?' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  })),
};

const MOCK_STS_CREDENTIALS = {
  Credentials: {
    AccessKeyId: 'mock-access-key-id',
    SecretAccessKey: 'mock-secret-access-key',
    SessionToken: 'mock-session-token',
  },
};

describe('api/bedrock Tests', () => {
  /** @type {import('../util.js').Nocker} */
  let nock;
  /** @type {typeof import('../../src/api/bedrock.js').default} */
  let handleRequest;
  let converseCallArgs;

  beforeEach(async () => {
    nock = new Nock().env();
    converseCallArgs = null;

    function MockBedrockRuntimeClient() {}
    MockBedrockRuntimeClient.prototype.send = function send(command) {
      converseCallArgs = command.input;
      return Promise.resolve(MOCK_INVOKE_RESPONSE);
    };

    function MockInvokeModelCommand(input) {
      this.input = input;
    }

    function MockSTSClient() {}
    MockSTSClient.prototype.send = function send() {
      return Promise.resolve(MOCK_STS_CREDENTIALS);
    };

    function MockAssumeRoleCommand(input) {
      this.input = input;
    }

    handleRequest = (await esmock('../../src/api/bedrock.js', {
      '@aws-sdk/client-bedrock-runtime': {
        BedrockRuntimeClient: MockBedrockRuntimeClient,
        InvokeModelCommand: MockInvokeModelCommand,
      },
      '@aws-sdk/client-sts': {
        STSClient: MockSTSClient,
        AssumeRoleCommand: MockAssumeRoleCommand,
      },
    })).default;
  });

  afterEach(() => {
    nock.done();
  });

  describe('POST /bedrock', () => {
    describe('authorization', () => {
      it('rejects missing authorization header', async () => {
        const req = new Request('https://localhost/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [] }),
        });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 401, 'missing auth');
      });

      it('rejects invalid token', async () => {
        const req = REQUEST({
          method: 'POST',
          token: 'invalid-key',
          body: { messages: [] },
        });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
          data: { messages: [] },
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
      });

      it('rejects non-existent admin', async () => {
        nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
          .get('/admins/unknown/admin.json?x-id=GetObject')
          .reply(404);

        const req = REQUEST({
          method: 'POST',
          token: 'admin:unknown:some-key',
          body: { messages: [] },
        });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
          data: { messages: [] },
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
      });

      it('allows valid superuser', async () => {
        const req = REQUEST({
          method: 'POST',
          token: 'superkey',
          body: { messages: [{ role: 'user', content: [{ text: 'Hi' }] }] },
        });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: {
            TMP_SUPERUSER_API_KEY: 'superkey',
            BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0',
          },
          data: { messages: [{ role: 'user', content: [{ text: 'Hi' }] }] },
        });

        const resp = await handleRequest(req, ctx);
        assert.strictEqual(resp.status, 200);
      });

      it('allows valid admin key', async () => {
        nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
          .get('/admins/myuser/admin.json?x-id=GetObject')
          .reply(200, JSON.stringify({ permissions: ['domainkeys:read'] }))
          .get('/admins/myuser/.adminkey?x-id=GetObject')
          .reply(200, 'my-admin-key');

        const req = REQUEST({
          method: 'POST',
          token: 'admin:myuser:my-admin-key',
          body: {
            modelId: 'test-model',
            messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
          },
        });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
          data: {
            modelId: 'test-model',
            messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
          },
        });

        const resp = await handleRequest(req, ctx);
        assert.strictEqual(resp.status, 200);
      });

      it('rejects admin with wrong key', async () => {
        nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
          .get('/admins/myuser/admin.json?x-id=GetObject')
          .reply(200, JSON.stringify({ permissions: ['domainkeys:read'] }))
          .get('/admins/myuser/.adminkey?x-id=GetObject')
          .reply(200, 'correct-key');

        const req = REQUEST({
          method: 'POST',
          token: 'admin:myuser:wrong-key',
          body: {
            modelId: 'test-model',
            messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
          },
        });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
          data: {
            modelId: 'test-model',
            messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
          },
        });

        await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
      });
    });

    describe('request validation', () => {
      it('rejects missing messages', async () => {
        const req = REQUEST({ method: 'POST', body: {} });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          data: {},
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing messages in request body');
      });

      it('rejects missing modelId when not in env', async () => {
        const req = REQUEST({
          method: 'POST',
          body: { messages: [{ role: 'user', content: [{ text: 'Hi' }] }] },
        });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { BEDROCK_MODEL_ID: undefined },
          data: { messages: [{ role: 'user', content: [{ text: 'Hi' }] }] },
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing modelId in request body or environment');
      });
    });

    describe('invokeModel', () => {
      it('returns response with correct structure', async () => {
        const messages = [{ role: 'user', content: [{ text: 'Hello' }] }];
        const req = REQUEST({ method: 'POST', body: { messages } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          data: { messages },
        });

        const resp = await handleRequest(req, ctx);
        assert.strictEqual(resp.status, 200);
        assert.strictEqual(resp.headers.get('content-type'), 'application/json');

        const body = await resp.json();
        assert.ok(body.content);
        assert.strictEqual(body.stop_reason, 'end_turn');
        assert.ok(body.usage);
      });

      it('uses modelId from request body over env', async () => {
        const messages = [{ role: 'user', content: [{ text: 'Hello' }] }];
        const requestModelId = 'anthropic.claude-3-opus-20240229-v1:0';
        const req = REQUEST({ method: 'POST', body: { messages, modelId: requestModelId } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          data: { messages, modelId: requestModelId },
        });

        await handleRequest(req, ctx);
        assert.strictEqual(converseCallArgs.modelId, requestModelId);
      });

      it('passes optional parameters in request body', async () => {
        const requestData = {
          messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
          system: 'You are helpful.',
          temperature: 0.7,
          max_tokens: 1000,
        };
        const req = REQUEST({ method: 'POST', body: requestData });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          data: requestData,
        });

        await handleRequest(req, ctx);

        const sentBody = JSON.parse(converseCallArgs.body);
        assert.strictEqual(sentBody.system, requestData.system);
        assert.strictEqual(sentBody.temperature, requestData.temperature);
        assert.strictEqual(sentBody.max_tokens, requestData.max_tokens);
      });

      it('returns 502 on Bedrock API error', async () => {
        function MockBedrockRuntimeClientError() {}
        MockBedrockRuntimeClientError.prototype.send = function send() {
          const error = new Error('Model not accessible');
          error.name = 'AccessDeniedException';
          return Promise.reject(error);
        };

        function MockInvokeModelCommandError(input) {
          this.input = input;
        }

        function MockSTSClient() {}
        MockSTSClient.prototype.send = () => Promise.resolve(MOCK_STS_CREDENTIALS);
        function MockAssumeRoleCommand(input) {
          this.input = input;
        }

        const handleRequestWithError = (await esmock('../../src/api/bedrock.js', {
          '@aws-sdk/client-bedrock-runtime': {
            BedrockRuntimeClient: MockBedrockRuntimeClientError,
            InvokeModelCommand: MockInvokeModelCommandError,
          },
          '@aws-sdk/client-sts': {
            STSClient: MockSTSClient,
            AssumeRoleCommand: MockAssumeRoleCommand,
          },
        })).default;

        const messages = [{ role: 'user', content: [{ text: 'Hello' }] }];
        const req = REQUEST({ method: 'POST', body: { messages } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: { suffix: '/bedrock' },
          env: { BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          data: { messages },
        });

        await assertRejectsWithResponse(() => handleRequestWithError(req, ctx), 502, 'bedrock error: AccessDeniedException');
      });
    });
  });

  describe('other methods', () => {
    it('rejects GET', async () => {
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/bedrock' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects PUT', async () => {
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/bedrock' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects DELETE', async () => {
      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/bedrock' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });
  });
});
