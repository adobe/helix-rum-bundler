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

    it('rejects bedrock request without auth', async () => {
      const res = await fetch(target.url('/bedrock'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'us.anthropic.claude-opus-4-6-v1', messages: [{ role: 'user', content: 'Hi' }] }),
      });
      assert.strictEqual(res.status, 401);
    }).timeout(50000);

    it('calls bedrock InvokeModel API', async () => {
      const res = await fetch(target.url('/bedrock'), {
        method: 'POST',
        headers: { ...target.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'us.anthropic.claude-opus-4-6-v1', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 10 }),
      });
      const body = await res.text();
      assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}: ${res.headers.get('x-error') || ''}`);
      const json = JSON.parse(body);
      assert.ok(json.content && json.stop_reason && json.usage, 'response should have content, stop_reason, usage');
    }).timeout(60000);

    it('handles substantial synthesis request', async () => {
      const res = await fetch(target.url('/bedrock'), {
        method: 'POST',
        headers: { ...target.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: 'us.anthropic.claude-opus-4-6-v1',
          messages: [{
            role: 'user',
            content: `Analyze this web performance data and write a 500-word report:
- Page views: 272M, LCP: 2.4s, CLS: 0.012, INP: 64ms
- Traffic: 45M from search, 12M from paid
- Top pages: /home (50M), /products (30M), /checkout (10M)
Include sections on performance, traffic patterns, and 3 specific recommendations.`,
          }],
          system: 'You are a senior web analytics consultant. Provide detailed, actionable analysis.',
          max_tokens: 4096,
        }),
      });
      const body = await res.text();
      assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}: ${res.headers.get('x-error') || ''}`);
      const json = JSON.parse(body);
      assert.ok(json.content?.[0]?.text?.length > 1500, 'response should be substantial (>1500 chars)');
      assert.ok(json.usage?.output_tokens > 400, 'should generate significant output tokens');
    }).timeout(120000);
  });
});
