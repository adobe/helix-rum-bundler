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

const MESSAGES = [{ role: 'user', content: [{ text: 'Hello' }] }];
const PATH_INFO = { suffix: '/bedrock' };

const REQUEST = ({ method, token = 'superkey', body = null }) => new Request('https://localhost/', {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: body ? JSON.stringify(body) : undefined,
});

const OPUS_MODEL_ID = 'us.anthropic.claude-opus-4-6-v1';

function createMockStreamBody(text = 'Hello! How can I help you?') {
  const enc = new TextEncoder();
  const events = [
    { type: 'message_start', message: { model: 'claude-opus-4-6', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
  ];
  return {
    async* [Symbol.asyncIterator]() {
      for (const event of events) {
        yield { chunk: { bytes: enc.encode(JSON.stringify(event)) } };
      }
    },
  };
}

function createMockToolUseStreamBody() {
  const enc = new TextEncoder();
  const events = [
    { type: 'message_start', message: { model: 'claude-opus-4-6', usage: { input_tokens: 10 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_abc123', name: 'get_weather' },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"loc' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ation":"NYC"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
  ];
  return {
    async* [Symbol.asyncIterator]() {
      for (const event of events) {
        yield { chunk: { bytes: enc.encode(JSON.stringify(event)) } };
      }
    },
  };
}

function createMockMultipleToolUseStreamBody() {
  const enc = new TextEncoder();
  const events = [
    { type: 'message_start', message: { model: 'claude-opus-4-6', usage: { input_tokens: 500 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_first_001', name: 'analyze_metrics' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"metric":"page_views","operation":"analyze"}' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_second_002', name: 'navigate_source' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"source":"organic","filter":"last_7_days"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 90 } },
  ];
  return {
    async* [Symbol.asyncIterator]() {
      for (const e of events) {
        yield { chunk: { bytes: enc.encode(JSON.stringify(e)) } };
      }
    },
  };
}

function createMockLargeTextResponseStreamBody() {
  const enc = new TextEncoder();
  const largeText = '# Report\n## Metrics\nLCP: 2.3s, FID: 45ms, CLS: 0.08\n## Traffic: 1.2M views\n'.repeat(50);
  const events = [
    { type: 'message_start', message: { model: 'claude-opus-4-6', usage: { input_tokens: 2500 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    ...Array.from({ length: Math.ceil(largeText.length / 500) }, (_, i) => ({
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: largeText.slice(i * 500, (i + 1) * 500) },
    })),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4000 } },
  ];
  return {
    async* [Symbol.asyncIterator]() {
      for (const e of events) {
        yield { chunk: { bytes: enc.encode(JSON.stringify(e)) } };
      }
    },
  };
}

async function readStreamResponse(resp) {
  return JSON.parse((await resp.text()).trim());
}

const MOCK_STS_CREDENTIALS = {
  Credentials: {
    AccessKeyId: 'mock-access-key-id',
    SecretAccessKey: 'mock-secret-access-key',
    SessionToken: 'mock-session-token',
  },
};

function MockCmd(input) {
  this.input = input;
}

async function esmockBedrockWithError(errorMessage, errorName) {
  function MockClient() {}
  MockClient.prototype.send = () => Promise.reject(
    Object.assign(new Error(errorMessage), { name: errorName }),
  );

  return (await esmock('../../src/api/bedrock.js', {
    '@aws-sdk/client-bedrock-runtime': { BedrockRuntimeClient: MockClient, InvokeModelWithResponseStreamCommand: MockCmd },
    '@aws-sdk/client-sts': { STSClient: MockCmd, AssumeRoleCommand: MockCmd },
  })).default;
}

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
      return Promise.resolve({ body: createMockStreamBody() });
    };

    function MockSTSClient() {}
    MockSTSClient.prototype.send = function send() {
      return Promise.resolve(MOCK_STS_CREDENTIALS);
    };

    handleRequest = (await esmock('../../src/api/bedrock.js', {
      '@aws-sdk/client-bedrock-runtime': {
        BedrockRuntimeClient: MockBedrockRuntimeClient,
        InvokeModelWithResponseStreamCommand: MockCmd,
      },
      '@aws-sdk/client-sts': {
        STSClient: MockSTSClient,
        AssumeRoleCommand: MockCmd,
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
          pathInfo: PATH_INFO,
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 401, 'missing auth');
      });

      it('rejects invalid token', async () => {
        const req = REQUEST({ method: 'POST', token: 'invalid-key', body: { messages: [] } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
          data: { messages: [] },
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
      });

      it('rejects non-existent admin', async () => {
        nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
          .get('/admins/unknown/admin.json?x-id=GetObject')
          .reply(404);

        const req = REQUEST({ method: 'POST', token: 'admin:unknown:some-key', body: { messages: [] } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
          data: { messages: [] },
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
      });

      it('allows valid superuser', async () => {
        const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { TMP_SUPERUSER_API_KEY: 'superkey', BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          data: { messages: MESSAGES },
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

        const data = { modelId: 'test-model', messages: MESSAGES };
        const req = REQUEST({ method: 'POST', token: 'admin:myuser:my-admin-key', body: data });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
          data,
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

        const data = { modelId: 'test-model', messages: MESSAGES };
        const req = REQUEST({ method: 'POST', token: 'admin:myuser:wrong-key', body: data });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { TMP_SUPERUSER_API_KEY: 'superkey' },
          data,
        });

        await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid auth');
      });
    });

    describe('request validation', () => {
      it('rejects missing messages', async () => {
        const req = REQUEST({ method: 'POST', body: {} });
        const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO, data: {} });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing messages in request body');
      });

      it('rejects missing modelId when not in env', async () => {
        const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: undefined },
          data: { messages: MESSAGES },
        });
        await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing modelId in request body or environment');
      });
    });

    describe('invokeModel', () => {
      it('returns response with correct structure', async () => {
        const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          data: { messages: MESSAGES },
        });

        const resp = await handleRequest(req, ctx);
        assert.strictEqual(resp.status, 200);
        assert.strictEqual(resp.headers.get('content-type'), 'application/json');

        const body = await readStreamResponse(resp);
        assert.ok(body.content);
        assert.strictEqual(body.content[0].text, 'Hello! How can I help you?');
        assert.strictEqual(body.stop_reason, 'end_turn');
        assert.strictEqual(body.model, 'claude-opus-4-6');
        assert.deepStrictEqual(body.usage, { input_tokens: 10, output_tokens: 20 });
      });

      it('uses modelId from request body over env', async () => {
        const requestModelId = 'anthropic.claude-3-opus-20240229-v1:0';
        const req = REQUEST({ method: 'POST', body: { messages: MESSAGES, modelId: requestModelId } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          data: { messages: MESSAGES, modelId: requestModelId },
        });

        await handleRequest(req, ctx);
        assert.strictEqual(converseCallArgs.modelId, requestModelId);
      });

      it('passes optional parameters in request body', async () => {
        const requestData = {
          messages: MESSAGES,
          system: 'You are helpful.',
          temperature: 0.7,
          max_tokens: 1000,
        };
        const req = REQUEST({ method: 'POST', body: requestData });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          data: requestData,
        });

        await handleRequest(req, ctx);

        const sentBody = JSON.parse(converseCallArgs.body);
        assert.strictEqual(sentBody.system, requestData.system);
        assert.strictEqual(sentBody.temperature, requestData.temperature);
        assert.strictEqual(sentBody.max_tokens, requestData.max_tokens);
      });

      it('uses cross-account role when BEDROCK_ROLE_ARN is set', async () => {
        const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: {
            BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0',
            BEDROCK_ROLE_ARN: 'arn:aws:iam::123456789012:role/BedrockRole',
          },
          data: { messages: MESSAGES },
        });

        const resp = await handleRequest(req, ctx);
        assert.strictEqual(resp.status, 200);
      });

      it('returns 502 on STS AssumeRole error', async () => {
        function MockSTSError() {}
        MockSTSError.prototype.send = () => Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDenied' }));

        const handler = (await esmock('../../src/api/bedrock.js', {
          '@aws-sdk/client-bedrock-runtime': { BedrockRuntimeClient: MockCmd, InvokeModelWithResponseStreamCommand: MockCmd },
          '@aws-sdk/client-sts': { STSClient: MockSTSError, AssumeRoleCommand: MockCmd },
        })).default;

        const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: 'model', BEDROCK_ROLE_ARN: 'arn:aws:iam::123:role/R' },
          data: { messages: MESSAGES },
        });

        await assertRejectsWithResponse(() => handler(req, ctx), 502, 'sts error: AccessDenied');
      });

      it('returns 502 on Bedrock API error with details', async () => {
        const handler = await esmockBedrockWithError('Model not accessible', 'AccessDeniedException');
        const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: 'model' },
          data: { messages: MESSAGES },
        });

        await assertRejectsWithResponse(
          () => handler(req, ctx),
          502,
          /AccessDeniedException: Model not accessible.*requestId=/,
        );
      });

      it('returns 502 on Bedrock timeout with details', async () => {
        const handler = await esmockBedrockWithError('Socket timed out', 'TimeoutError');
        const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: 'model' },
          data: { messages: MESSAGES },
        });

        await assertRejectsWithResponse(
          () => handler(req, ctx),
          502,
          /TimeoutError: Socket timed out.*requestId=/,
        );
      });

      it('retries on ServiceUnavailableException and succeeds', async () => {
        let attempts = 0;
        function MockRetry() {}
        MockRetry.prototype.send = () => {
          attempts += 1;
          if (attempts < 2) {
            const err = new Error('Service unavailable');
            err.name = 'ServiceUnavailableException';
            return Promise.reject(err);
          }
          return Promise.resolve({ body: createMockStreamBody() });
        };

        const handler = (await esmock('../../src/api/bedrock.js', {
          '@aws-sdk/client-bedrock-runtime': { BedrockRuntimeClient: MockRetry, InvokeModelWithResponseStreamCommand: MockCmd },
          '@aws-sdk/client-sts': { STSClient: MockCmd, AssumeRoleCommand: MockCmd },
        })).default;

        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID },
          data: { messages: MESSAGES },
        });
        const resp = await handler(REQUEST({ method: 'POST', body: { messages: MESSAGES } }), ctx);

        assert.strictEqual(resp.status, 200);
        assert.strictEqual(attempts, 2);
      }).timeout(10000);

      it('returns 502 after max retries on ServiceUnavailableException', async () => {
        function MockAlwaysFail() {}
        MockAlwaysFail.prototype.send = () => {
          const err = new Error('Service unavailable');
          err.name = 'ServiceUnavailableException';
          err.$metadata = { requestId: 'test-req-123', httpStatusCode: 503 };
          return Promise.reject(err);
        };

        const handler = (await esmock('../../src/api/bedrock.js', {
          '@aws-sdk/client-bedrock-runtime': { BedrockRuntimeClient: MockAlwaysFail, InvokeModelWithResponseStreamCommand: MockCmd },
          '@aws-sdk/client-sts': { STSClient: MockCmd, AssumeRoleCommand: MockCmd },
        })).default;

        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID },
          data: { messages: MESSAGES },
        });

        await assertRejectsWithResponse(
          () => handler(REQUEST({ method: 'POST', body: { messages: MESSAGES } }), ctx),
          502,
          /ServiceUnavailableException.*requestId=test-req-123.*attempt=3\/3/,
        );
      }).timeout(20000);

      it('returns tool_use blocks with id, name, and parsed input', async () => {
        function MockBedrockToolUse() {}
        MockBedrockToolUse.prototype.send = () => Promise.resolve({
          body: createMockToolUseStreamBody(),
        });

        const handler = (await esmock('../../src/api/bedrock.js', {
          '@aws-sdk/client-bedrock-runtime': { BedrockRuntimeClient: MockBedrockToolUse, InvokeModelWithResponseStreamCommand: MockCmd },
          '@aws-sdk/client-sts': { STSClient: MockCmd, AssumeRoleCommand: MockCmd },
        })).default;

        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID },
          data: { messages: MESSAGES },
        });
        const resp = await handler(
          REQUEST({ method: 'POST', body: { messages: MESSAGES } }),
          ctx,
        );
        const body = await readStreamResponse(resp);

        assert.strictEqual(body.content[0].type, 'tool_use');
        assert.strictEqual(body.content[0].id, 'toolu_abc123');
        assert.strictEqual(body.content[0].name, 'get_weather');
        assert.deepStrictEqual(body.content[0].input, { location: 'NYC' });
      });

      it('handles multiple tool_use blocks', async () => {
        function Mock() {}
        Mock.prototype.send = () => Promise.resolve({
          body: createMockMultipleToolUseStreamBody(),
        });

        const handler = (await esmock('../../src/api/bedrock.js', {
          '@aws-sdk/client-bedrock-runtime': {
            BedrockRuntimeClient: Mock,
            InvokeModelWithResponseStreamCommand: MockCmd,
          },
          '@aws-sdk/client-sts': { STSClient: MockCmd, AssumeRoleCommand: MockCmd },
        })).default;

        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID },
          data: { messages: MESSAGES },
        });
        const resp = await handler(
          REQUEST({ method: 'POST', body: { messages: MESSAGES } }),
          ctx,
        );
        const body = await readStreamResponse(resp);

        assert.strictEqual(body.content.length, 2);
        assert.strictEqual(body.content[0].id, 'toolu_first_001');
        assert.strictEqual(body.content[1].id, 'toolu_second_002');
        assert.deepStrictEqual(body.content[0].input, { metric: 'page_views', operation: 'analyze' });
      });

      it('handles large synthesis response (4k tokens)', async () => {
        function Mock() {}
        Mock.prototype.send = () => Promise.resolve({
          body: createMockLargeTextResponseStreamBody(),
        });

        const handler = (await esmock('../../src/api/bedrock.js', {
          '@aws-sdk/client-bedrock-runtime': {
            BedrockRuntimeClient: Mock,
            InvokeModelWithResponseStreamCommand: MockCmd,
          },
          '@aws-sdk/client-sts': { STSClient: MockCmd, AssumeRoleCommand: MockCmd },
        })).default;

        const largeData = {
          messages: MESSAGES,
          system: 'Analyze data. '.repeat(100),
          max_tokens: 4096,
        };
        const ctx = DEFAULT_CONTEXT({
          pathInfo: PATH_INFO,
          env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID },
          data: largeData,
        });
        const body = await readStreamResponse(await handler(REQUEST({ method: 'POST', body: largeData }), ctx));

        assert.ok(body.content[0].text.length > 3000);
        assert.strictEqual(body.usage.output_tokens, 4000);
      });
    });
  });

  describe('other methods', () => {
    ['GET', 'PUT', 'DELETE'].forEach((method) => {
      it(`rejects ${method}`, async () => {
        const req = REQUEST({ method });
        const ctx = DEFAULT_CONTEXT({ pathInfo: PATH_INFO });
        const resp = await handleRequest(req, ctx);
        assert.strictEqual(resp.status, 405);
      });
    });
  });
});
