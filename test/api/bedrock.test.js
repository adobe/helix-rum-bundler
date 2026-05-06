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
const PATH_INFO_SYNC = { suffix: '/bedrock' };
const PATH_INFO_JOBS = { suffix: '/bedrock/jobs' };
const PATH_INFO_JOB = (id) => ({ suffix: `/bedrock/jobs/${id}` });
const PATH_INFO_USAGE = { suffix: '/bedrock/usage' };

const TEST_DOMAIN = 'example.com';
const TEST_DOMAINKEY = 'test-domain-key';

const REQUEST = ({ method, body = null }) => new Request('https://localhost/', {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

const OPUS_MODEL_ID = 'us.anthropic.claude-opus-4-6-v1';

const MOCK_BEDROCK_RESPONSE = {
  content: [{ type: 'text', text: 'Hello!' }],
  stop_reason: 'end_turn',
  model: 'claude-opus-4-6',
  usage: { input_tokens: 10, output_tokens: 5 },
};

function MockCmd(input) {
  this.input = input;
}

// Shared state for mocks
let s3Storage = {};
let lambdaInvocations = [];
let bedrockError = null;
let stsError = null;
let s3Error = null;
let lambdaError = null;

function createMocks() {
  function MockBedrockClient() {}
  MockBedrockClient.prototype.send = (_) => {
    if (bedrockError) return Promise.reject(bedrockError);
    return Promise.resolve({
      body: new TextEncoder().encode(JSON.stringify(MOCK_BEDROCK_RESPONSE)),
    });
  };

  function MockSTSClient() {}
  MockSTSClient.prototype.send = () => {
    if (stsError) return Promise.reject(stsError);
    return Promise.resolve({
      Credentials: {
        AccessKeyId: 'key',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
      },
    });
  };

  function MockS3Client() {}
  MockS3Client.prototype.send = (cmd) => {
    const key = cmd.input.Key;
    if (cmd.input.Body !== undefined) {
      s3Storage[key] = cmd.input.Body;
      return Promise.resolve({});
    }
    if (s3Error) return Promise.reject(s3Error);
    if (s3Storage[key]) {
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(s3Storage[key]) },
      });
    }
    const err = new Error('NoSuchKey');
    err.name = 'NoSuchKey';
    return Promise.reject(err);
  };

  function MockLambdaClient() {}
  MockLambdaClient.prototype.send = (cmd) => {
    if (lambdaError) return Promise.reject(lambdaError);
    lambdaInvocations.push(JSON.parse(cmd.input.Payload));
    return Promise.resolve({});
  };

  return {
    '@aws-sdk/client-bedrock-runtime': {
      BedrockRuntimeClient: MockBedrockClient,
      InvokeModelCommand: MockCmd,
    },
    '@aws-sdk/client-sts': {
      STSClient: MockSTSClient,
      AssumeRoleCommand: MockCmd,
    },
    '@aws-sdk/client-s3': {
      S3Client: MockS3Client,
      PutObjectCommand: MockCmd,
      GetObjectCommand: MockCmd,
    },
    '@aws-sdk/client-lambda': {
      LambdaClient: MockLambdaClient,
      InvokeCommand: MockCmd,
    },
  };
}

describe('api/bedrock Tests', function testSuite() {
  this.timeout(30000);

  let nock;
  let handleRequest;
  let processBedrockJob;

  before(async () => {
    const mod = await esmock('../../src/api/bedrock.js', createMocks());
    handleRequest = mod.default;
    processBedrockJob = mod.processBedrockJob;
  });

  beforeEach(() => {
    nock = new Nock().env();
    s3Storage = {};
    lambdaInvocations = [];
    bedrockError = null;
    stsError = null;
    s3Error = null;
    lambdaError = null;
  });

  afterEach(() => {
    nock.done();
  });

  describe('POST /bedrock (sync)', () => {
    it('rejects missing domain or domainkey', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { messages: [] } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        data: { messages: [] },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 401, 'missing domain or domainkey');
    });

    it('rejects invalid domainkey', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { messages: [] } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        data: { messages: [], domain: TEST_DOMAIN, domainkey: 'wrong-key' },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 403, 'invalid domainkey');
    });

    it('rejects missing messages', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: {} });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing messages in request body');
    });

    it('rejects missing modelId', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        env: { BEDROCK_MODEL_ID: undefined },
        data: { messages: MESSAGES, domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing modelId in request body or environment');
    });

    it('returns 200 with response on success', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID },
        data: { messages: MESSAGES, domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const body = await resp.json();
      assert.strictEqual(body.stop_reason, 'end_turn');
    });

    it('returns 502 on bedrock error', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      bedrockError = new Error('Model error');
      bedrockError.name = 'ModelError';
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID },
        data: { messages: MESSAGES, domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 502, 'bedrock error: ModelError');
    });

    it('returns 502 on STS error', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      stsError = new Error('STS failed');
      stsError.name = 'STSError';
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID, BEDROCK_ROLE_ARN: 'arn:aws:iam::123:role/test' },
        data: { messages: MESSAGES, domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 502, 'sts error: STSError');
    });

    it('uses STS credentials when BEDROCK_ROLE_ARN is set', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID, BEDROCK_ROLE_ARN: 'arn:aws:iam::123:role/test' },
        data: { messages: MESSAGES, domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
    });
  });

  describe('POST /bedrock/jobs (async)', () => {
    it('rejects missing messages', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: {} });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing messages in request body');
    });

    it('returns 202 with jobId on success', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID, AWS_LAMBDA_FUNCTION_NAME: 'test' },
        data: { messages: MESSAGES, domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 202);
      const body = await resp.json();
      assert.ok(body.jobId.startsWith('job_'));
      assert.strictEqual(body.status, 'processing');
    });

    it('saves job to S3 and invokes Lambda', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID, AWS_LAMBDA_FUNCTION_NAME: 'test' },
        data: { messages: MESSAGES, domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      const { jobId } = await resp.json();

      // Check S3
      const saved = JSON.parse(s3Storage[`bedrock-jobs/${jobId}.json`]);
      assert.strictEqual(saved.status, 'processing');

      // Check Lambda payload
      assert.strictEqual(lambdaInvocations.length, 1);
      assert.strictEqual(lambdaInvocations[0].jobId, jobId);
    });

    it('returns 502 and saves failed status on Lambda invoke error', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      lambdaError = new Error('Lambda invoke failed');
      lambdaError.name = 'ServiceException';
      const req = REQUEST({ method: 'POST', body: { messages: MESSAGES } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID, AWS_LAMBDA_FUNCTION_NAME: 'test' },
        data: { messages: MESSAGES, domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 502, 'failed to start job');

      // Check S3 was updated with failed status
      const keys = Object.keys(s3Storage);
      assert.strictEqual(keys.length, 1);
      const saved = JSON.parse(s3Storage[keys[0]]);
      assert.strictEqual(saved.status, 'failed');
      assert.strictEqual(saved.error.name, 'InvocationError');
    });
  });

  describe('GET /bedrock/jobs/{jobId}', () => {
    it('returns 404 for non-existent job', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOB('job_none'),
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 404, 'job not found');
    });

    it('returns processing job', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const jobId = 'job_test1';
      s3Storage[`bedrock-jobs/${jobId}.json`] = JSON.stringify({ status: 'processing' });
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOB(jobId),
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const body = await resp.json();
      assert.strictEqual(body.status, 'processing');
    });

    it('returns completed job with result', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const jobId = 'job_test2';
      s3Storage[`bedrock-jobs/${jobId}.json`] = JSON.stringify({
        status: 'completed',
        result: MOCK_BEDROCK_RESPONSE,
      });
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOB(jobId),
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      const body = await resp.json();
      assert.strictEqual(body.status, 'completed');
      assert.ok(body.result);
    });

    it('returns failed job with error', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const jobId = 'job_test3';
      s3Storage[`bedrock-jobs/${jobId}.json`] = JSON.stringify({
        status: 'failed',
        error: { name: 'Err', message: 'fail' },
      });
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOB(jobId),
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      const body = await resp.json();
      assert.strictEqual(body.status, 'failed');
      assert.strictEqual(body.error.name, 'Err');
    });

    it('throws on S3 error other than NoSuchKey', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      s3Error = new Error('Access Denied');
      s3Error.name = 'AccessDenied';
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOB('job_err'),
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assert.rejects(
        () => handleRequest(req, ctx),
        (err) => err.name === 'AccessDenied',
      );
    });
  });

  describe('processBedrockJob', () => {
    it('processes job and saves completed result', async () => {
      const jobId = 'job_proc1';
      const ctx = DEFAULT_CONTEXT({ env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID } });
      const event = { jobId, request: { messages: MESSAGES, modelId: OPUS_MODEL_ID } };
      await processBedrockJob(ctx, event);
      const saved = JSON.parse(s3Storage[`bedrock-jobs/${jobId}.json`]);
      assert.strictEqual(saved.status, 'completed');
      assert.ok(saved.result);
      assert.ok(saved.elapsed >= 0);
    });

    it('saves failed status on bedrock error', async () => {
      bedrockError = new Error('fail');
      bedrockError.name = 'BedrockErr';
      const jobId = 'job_proc2';
      const ctx = DEFAULT_CONTEXT({ env: { BEDROCK_MODEL_ID: OPUS_MODEL_ID } });
      const event = { jobId, request: { messages: MESSAGES, modelId: OPUS_MODEL_ID } };
      await processBedrockJob(ctx, event);
      const saved = JSON.parse(s3Storage[`bedrock-jobs/${jobId}.json`]);
      assert.strictEqual(saved.status, 'failed');
      assert.strictEqual(saved.error.name, 'BedrockErr');
    });
  });

  describe('POST /bedrock/usage', () => {
    it('rejects missing reportId', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { inputTokens: 100, outputTokens: 50 } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_USAGE,
        data: {
          inputTokens: 100,
          outputTokens: 50,
          domain: TEST_DOMAIN,
          domainkey: TEST_DOMAINKEY,
        },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing reportId');
    });

    it('rejects missing token counts', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: { reportId: 'report_123' } });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_USAGE,
        data: { reportId: 'report_123', domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'missing or invalid token counts');
    });

    it('logs usage via log.info and returns 200', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: {} });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_USAGE,
        data: {
          reportId: 'report_abc123',
          model: 'claude-opus-4-6',
          inputTokens: 45000,
          outputTokens: 12000,
          domain: TEST_DOMAIN,
          domainkey: TEST_DOMAINKEY,
        },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const body = await resp.json();
      assert.strictEqual(body.status, 'recorded');

      // Verify log.info was called with usage data
      const infoCalls = ctx.log.calls.info;
      const usageLog = infoCalls.find((call) => call[0] === '[bedrock-usage]');
      assert.ok(usageLog, 'should log usage');
      assert.strictEqual(usageLog[1].domain, TEST_DOMAIN);
      assert.strictEqual(usageLog[1].model, 'claude-opus-4-6');
      assert.strictEqual(usageLog[1].inputTokens, 45000);
      assert.strictEqual(usageLog[1].outputTokens, 12000);
      assert.strictEqual(usageLog[1].totalTokens, 57000);
      assert.strictEqual(usageLog[1].reportId, 'report_abc123');
    });

    it('uses unknown for missing domain and model', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST', body: {} });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_USAGE,
        data: {
          reportId: 'report_anon',
          inputTokens: 100,
          outputTokens: 50,
          domain: TEST_DOMAIN,
          domainkey: TEST_DOMAINKEY,
        },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);

      const infoCalls = ctx.log.calls.info;
      const usageLog = infoCalls.find((call) => call[0] === '[bedrock-usage]');
      assert.ok(usageLog, 'should log usage');
      assert.strictEqual(usageLog[1].domain, TEST_DOMAIN);
      assert.strictEqual(usageLog[1].model, 'unknown');
    });
  });

  describe('HTTP method handling', () => {
    it('rejects GET on /bedrock', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_SYNC,
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects PUT on /bedrock/jobs', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOBS,
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });

    it('rejects POST on /bedrock/jobs/{jobId}', async () => {
      nock.domainKey(TEST_DOMAIN, TEST_DOMAINKEY);
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({
        pathInfo: PATH_INFO_JOB('x'),
        data: { domain: TEST_DOMAIN, domainkey: TEST_DOMAINKEY },
      });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 405);
    });
  });
});
