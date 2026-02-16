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
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modelId: 'anthropic.claude-opus-4-5-20251101-v1:0',
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        }),
      });
      assert.strictEqual(res.status, 401);
    }).timeout(50000);

    it('calls bedrock converse API', async () => {
      const res = await fetch(target.url('/bedrock'), {
        method: 'POST',
        headers: {
          ...target.headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modelId: 'anthropic.claude-opus-4-5-20251101-v1:0',
          messages: [{ role: 'user', content: [{ text: 'Say OK' }] }],
          inferenceConfig: { maxTokens: 10 },
        }),
      });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.ok(json.output, 'response should have output');
      assert.ok(json.stopReason, 'response should have stopReason');
      assert.ok(json.usage, 'response should have usage');
    }).timeout(60000);
  });
});
