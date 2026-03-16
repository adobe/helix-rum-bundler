/*
 * Copyright 2019 Adobe. All rights reserved.
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
import { h1NoCache } from '@adobe/fetch';
import { createTargets } from './post-deploy-utils.js';

const OPUS_MODEL_ID = 'us.anthropic.claude-opus-4-6-v1';
const POLL_INTERVAL = 3000;
const MAX_POLL_TIME = 180000; // 3 minutes max for polling

/**
 * Poll job status until complete or timeout
 */
async function pollJobUntilComplete(fetch, url, headers, jobId) {
  const jobUrl = `${url}/bedrock/jobs/${jobId}`;
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_TIME) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL);
    });

    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(jobUrl, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      throw new Error(`Poll failed: ${res.status}`);
    }

    // eslint-disable-next-line no-await-in-loop
    const job = await res.json();

    if (job.status === 'completed') {
      return job;
    }

    if (job.status === 'failed') {
      throw new Error(`Job failed: ${job.error?.message || 'Unknown error'}`);
    }
  }

  throw new Error(`Job timed out after ${MAX_POLL_TIME / 1000}s`);
}

createTargets().forEach((target) => {
  describe(`Post-Deploy Tests (${target.title()})`, () => {
    const fetchContext = h1NoCache();
    const { fetch } = fetchContext;

    afterEach(async () => {
      await fetchContext.reset();
    });

    it('returns the status of the function', async () => {
      const url = target.url('/_status_check/healthcheck.json');
      const res = await fetch(url, {
        headers: {
          ...target.headers,
          authorization: undefined,
        },
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      delete json.process;
      delete json.response_time;
      // status returns 0.0.0+ci123 for ci versions
      const version = target.version.startsWith('ci')
        ? `0.0.0+${target.version}`
        : target.version;
      assert.deepStrictEqual(json, {
        status: 'OK',
        version,
      });
    }).timeout(50000);

    it('invokes the function', async () => {
      const res = await fetch(target.url('/'));
      assert.strictEqual(res.status, 401);
    }).timeout(50000);

    // ============ Sync Bedrock Tests (/bedrock) ============

    it('rejects bedrock request without auth', async () => {
      const res = await fetch(target.url('/bedrock'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: OPUS_MODEL_ID, messages: [{ role: 'user', content: 'Hi' }] }),
      });
      assert.strictEqual(res.status, 401);
    }).timeout(50000);

    it('calls bedrock sync API for quick request', async () => {
      const res = await fetch(target.url('/bedrock'), {
        method: 'POST',
        headers: { ...target.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: OPUS_MODEL_ID,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 10,
        }),
      });
      const body = await res.text();
      assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}: ${res.headers.get('x-error') || body}`);
      const json = JSON.parse(body);
      assert.ok(json.content, 'response should have content');
      assert.ok(json.stop_reason, 'response should have stop_reason');
      assert.ok(json.usage, 'response should have usage');
    }).timeout(60000);

    // ============ Async Job Tests (/bedrock/jobs) ============

    it('rejects bedrock jobs request without auth', async () => {
      const res = await fetch(target.url('/bedrock/jobs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: OPUS_MODEL_ID, messages: [{ role: 'user', content: 'Hi' }] }),
      });
      assert.strictEqual(res.status, 401);
    }).timeout(50000);

    it('submits async job and returns jobId', async () => {
      const res = await fetch(target.url('/bedrock/jobs'), {
        method: 'POST',
        headers: { ...target.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: OPUS_MODEL_ID,
          messages: [{ role: 'user', content: 'Say hello' }],
          max_tokens: 50,
        }),
      });
      const body = await res.text();
      assert.strictEqual(res.status, 202, `Expected 202 but got ${res.status}: ${body}`);

      const json = JSON.parse(body);
      assert.ok(json.jobId, 'response should have jobId');
      assert.ok(json.jobId.startsWith('job_'), 'jobId should start with job_');
      assert.strictEqual(json.status, 'processing', 'status should be processing');
    }).timeout(30000);

    it('polls job status and gets result', async () => {
      // Submit job
      const submitRes = await fetch(target.url('/bedrock/jobs'), {
        method: 'POST',
        headers: { ...target.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: OPUS_MODEL_ID,
          messages: [{ role: 'user', content: 'Say hello in exactly 5 words' }],
          max_tokens: 50,
        }),
      });

      assert.strictEqual(submitRes.status, 202);
      const { jobId } = await submitRes.json();

      // Poll until complete
      const job = await pollJobUntilComplete(
        fetch,
        target.url(''),
        target.headers,
        jobId,
      );

      assert.strictEqual(job.status, 'completed');
      assert.ok(job.result, 'completed job should have result');
      assert.ok(job.result.content, 'result should have content');
      assert.ok(job.result.stop_reason, 'result should have stop_reason');
      assert.ok(job.elapsed >= 0, 'should have elapsed time');
    }).timeout(120000);

    it('handles substantial synthesis via async job (avoids timeout)', async () => {
      // Submit large request as async job
      const submitRes = await fetch(target.url('/bedrock/jobs'), {
        method: 'POST',
        headers: { ...target.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: OPUS_MODEL_ID,
          messages: [{
            role: 'user',
            content: `Analyze this web performance data and write a detailed 300-word report:
- Page views: 272M, LCP: 2.4s, CLS: 0.012, INP: 64ms
- Traffic: 45M from search, 12M from paid
- Top pages: /home (50M), /products (30M), /checkout (10M)
Include sections on performance metrics and traffic patterns.`,
          }],
          system: 'You are a web analytics expert. Provide detailed analysis.',
          max_tokens: 2048,
        }),
      });

      const submitBody = await submitRes.text();
      assert.strictEqual(submitRes.status, 202, `Expected 202 but got ${submitRes.status}: ${submitBody}`);
      const { jobId } = JSON.parse(submitBody);

      // Poll until complete - this can take 60+ seconds but won't timeout
      const job = await pollJobUntilComplete(
        fetch,
        target.url(''),
        target.headers,
        jobId,
      );

      assert.strictEqual(job.status, 'completed', 'job should complete successfully');
      assert.ok(job.result.content?.[0]?.text?.length > 500, 'response should be substantial (>500 chars)');
      assert.ok(job.result.usage?.output_tokens > 100, 'should generate significant output tokens');
    }).timeout(240000);

    it('returns 404 for non-existent job', async () => {
      const res = await fetch(target.url('/bedrock/jobs/job_nonexistent_12345'), {
        method: 'GET',
        headers: target.headers,
      });
      assert.strictEqual(res.status, 404);
    }).timeout(30000);
  });
});
