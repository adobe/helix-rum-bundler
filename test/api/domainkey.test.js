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

/* eslint-env mocha */

import assert from 'assert';
import { Request } from '@adobe/fetch';
import handleRequest from '../../src/api/domainkey.js';
import {
  DEFAULT_CONTEXT,
  Nock,
  assertRejectsWithResponse,
} from '../util.js';

const REQUEST = ({ method, token = 'superkey' }) => new Request('https://localhost/', {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

describe('api/domainkey Tests', () => {
  /** @type {import('../util.js').Nocker} */
  let nock;
  let ogUUID;
  beforeEach(() => {
    nock = new Nock().env();
    ogUUID = crypto.randomUUID;
    crypto.randomUUID = () => 'test-uuid';
  });
  afterEach(() => {
    nock.done();
    crypto.randomUUID = ogUUID;
  });

  describe('getDomainkey()', () => {
    it('rejects unauthorized', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/domains/example.com/.orgkeys.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'GET', token: 'invalid' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/domainkey/example.com' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 403);
    });

    it('allows valid superuser', async () => {
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/.domainkey?x-id=GetObject')
        .reply(200, 'simple-domainkey');

      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/domainkey/example.com' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { domainkey } = await resp.json();
      assert.strictEqual(domainkey, 'simple-domainkey');
    });

    it('allows valid orgkey', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/domains/example.com/.orgkeys.json?x-id=GetObject')
        .reply(200, JSON.stringify({ someorg: 'my-org-key' }));

      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/.domainkey?x-id=GetObject')
        .reply(200, 'simple-domainkey');

      const req = REQUEST({ method: 'GET', token: 'my-org-key' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/domainkey/example.com' } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 200);
      const { domainkey } = await resp.json();
      assert.strictEqual(domainkey, 'simple-domainkey');
    });
  });
});
