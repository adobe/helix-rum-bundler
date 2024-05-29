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
  ungzip,
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

    it('returns 404 if missing', async () => {
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/.domainkey?x-id=GetObject')
        .reply(404);

      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/domainkey/example.com' } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 404);
    });
  });

  it('POST rotates domainkey', async () => {
    let body;
    nock('https://helix-pages.anywhere.run')
      .post('/helix-services/run-query@v3/rotate-domainkeys?url=example.com&newkey=TEST-UUID&note=rumbundler')
      .reply(200);

    nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
      .put('/example.com/.domainkey?x-id=PutObject', (b) => {
        body = b;
        return true;
      })
      .reply(200);
    nock.purgeFastly('example.com');

    const req = REQUEST({ method: 'POST' });
    const ctx = DEFAULT_CONTEXT({
      data: { domainkey: 'this-should-be-ignored' },
      pathInfo: { suffix: '/domainkey/example.com' },
    });
    const resp = await handleRequest(req, ctx);
    assert.strictEqual(await ungzip(body), 'TEST-UUID');
    assert.strictEqual(resp.status, 201);
    const { domainkey } = await resp.json();
    assert.strictEqual(domainkey, 'TEST-UUID');
  });

  it('PUT sets domainkey', async () => {
    let body;
    nock('https://helix-pages.anywhere.run')
      .post('/helix-services/run-query@v3/rotate-domainkeys?url=example.com&newkey=NEW-DOMAINKEY&note=rumbundler')
      .reply(200);

    nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
      .put('/example.com/.domainkey?x-id=PutObject', (b) => {
        body = b;
        return true;
      })
      .reply(200);
    nock.purgeFastly('example.com');

    const req = REQUEST({ method: 'PUT' });
    const ctx = DEFAULT_CONTEXT({
      data: { domainkey: 'NEW-DOMAINKEY' },
      pathInfo: { suffix: '/domainkey/example.com' },
    });
    const resp = await handleRequest(req, ctx);
    assert.strictEqual(await ungzip(body), 'NEW-DOMAINKEY');
    assert.strictEqual(resp.status, 204);
    const resBody = await resp.text();
    assert.strictEqual(resBody, '');
  });

  it('PUT rejects missing domainkey', async () => {
    const req = REQUEST({ method: 'PUT' });
    const ctx = DEFAULT_CONTEXT({
      data: { domainkey: 123 },
      pathInfo: { suffix: '/domainkey/example.com' },
    });

    await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid domainkey');
  });

  it('DELETE removes domainkey content, leaves the file empty', async () => {
    let body;
    nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
      .put('/example.com/.domainkey?x-id=PutObject', (b) => {
        body = b;
        return true;
      })
      .reply(200);
    nock.purgeFastly('example.com');

    const req = REQUEST({ method: 'DELETE' });
    const ctx = DEFAULT_CONTEXT({
      pathInfo: { suffix: '/domainkey/example.com' },
    });
    const resp = await handleRequest(req, ctx);
    assert.strictEqual(Buffer.from(body, 'hex').toString('utf-8'), '');
    assert.strictEqual(resp.status, 204);
    const resBody = await resp.text();
    assert.strictEqual(resBody, '');
  });

  it('rejects unhandled methods', async () => {
    const req = REQUEST({ method: 'PATCH' });
    const ctx = DEFAULT_CONTEXT({
      pathInfo: { suffix: '/domainkey/example.com' },
    });
    const resp = await handleRequest(req, ctx);
    assert.strictEqual(resp.status, 405);
  });
});
