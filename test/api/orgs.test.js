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
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import handleRequest from '../../src/api/orgs.js';
import {
  DEFAULT_CONTEXT,
  Nock,
  assertRejectsWithResponse,
  ungzip,
} from '../util.js';

// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUEST = ({ method, token = 'superkey' }) => new Request('https://localhost/', {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

describe('api/orgs Tests', () => {
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

  it('rejects unhandled method', async () => {
    const req = REQUEST({ method: 'FOO' });
    const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs' } });
    const resp = await handleRequest(req, ctx);
    assert.deepEqual(resp.status, 405);
  });

  describe('POST /orgs', () => {
    it('rejects invalid (missing id)', async () => {
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs' }, data: { id: null } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid id');
    });

    it('rejects invalid (invalid domains)', async () => {
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs' }, data: { id: 'foo', domains: 'invalid' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid domains');
    });

    it('rejects already existing', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .head('/orgs/foo/org.json')
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs' }, data: { id: 'foo' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 409);
    });

    it('accepts valid, without initial domains', async () => {
      const bodies = { org: undefined, orgkey: undefined };

      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .head('/orgs/foo/org.json')
        .reply(404);

      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .put('/orgs/foo/org.json?x-id=PutObject', (b) => {
          bodies.org = b;
          return true;
        })
        .reply(200)
        .put('/orgs/foo/.orgkey?x-id=PutObject', (b) => {
          bodies.orgkey = b;
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs' }, data: { id: 'foo' } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 200);
      assert.strictEqual(await ungzip(bodies.org), '{"domains":[]}');
      assert.strictEqual(await ungzip(bodies.orgkey), 'TEST-UUID');
    });

    it('accepts valid, with initial domains', async () => {
      const bodies = { org: undefined, orgkey: undefined, domainOrgkeyMap: undefined };

      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .head('/orgs/foo/org.json')
        .reply(404);

      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .put('/orgs/foo/org.json?x-id=PutObject', (b) => {
          bodies.org = b;
          return true;
        })
        .reply(200)
        .put('/orgs/foo/.orgkey?x-id=PutObject', (b) => {
          bodies.orgkey = b;
          return true;
        })
        .reply(200)
        .get('/domains/example.com/.orgkeys.json?x-id=GetObject')
        .reply(404)
        .put('/domains/example.com/.orgkeys.json?x-id=PutObject', (b) => {
          bodies.domainOrgkeyMap = b;
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs' }, data: { id: 'foo', domains: ['example.com'] } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 200);
      assert.strictEqual(await ungzip(bodies.org), '{"domains":["example.com"]}');
      assert.strictEqual(await ungzip(bodies.orgkey), 'TEST-UUID');
      assert.strictEqual(await ungzip(bodies.domainOrgkeyMap), '{"foo":"TEST-UUID"}');
    });
  });

  describe('GET /orgs', () => {
    it('returns orgs', async () => {
      const listBody = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-orgs.xml'), 'utf-8');
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/?delimiter=%2F&list-type=2&prefix=orgs%2F')
        .reply(200, listBody);

      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { orgs } = await resp.json();
      assert.deepStrictEqual(orgs, ['adobe', 'foo', 'bar']);
    });
  });

  describe('POST /orgs/:id', () => {
    it('returns 400 for invalid domains', async () => {
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' }, data: { domains: ['new.domain', 123] } });
      await assertRejectsWithResponse(handleRequest(req, ctx), 400, 'invalid domains');
    });

    it('returns 404 if org does not exist', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' }, data: { domains: ['new.domain', 'foo.example', 'bar.example'] } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('halts request if orgkey missing (inconsistent storage, should not occur)', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: [] }))
        .get('/orgs/adobe/.orgkey?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' }, data: { domains: ['new.domain', 'foo.example', 'bar.example'] } });
      await assertRejectsWithResponse(handleRequest(req, ctx), 400, 'orgkey not defined');
    });

    it('adds only the new domains', async () => {
      const bodies = { org: undefined, orgkeys: undefined, orgkeys2: undefined };
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: ['foo.example', 'bar.example'] }))
        .get('/orgs/adobe/.orgkey?x-id=GetObject')
        .reply(200, 'ORG-KEY')
        .put('/orgs/adobe/org.json?x-id=PutObject', async (b) => {
          bodies.org = await ungzip(b);
          return true;
        })
        .reply(200)
        .get('/domains/new.domain/.orgkeys.json?x-id=GetObject')
        .reply(200, JSON.stringify({}))
        .get('/domains/new.domain.two/.orgkeys.json?x-id=GetObject')
        .reply(200, JSON.stringify({ existing: 'EXISTING-ORG-KEY' }))
        .put('/domains/new.domain/.orgkeys.json?x-id=PutObject', async (b) => {
          bodies.orgkeys = await ungzip(b);
          return true;
        })
        .reply(200)
        .put('/domains/new.domain.two/.orgkeys.json?x-id=PutObject', async (b) => {
          bodies.orgkeys2 = await ungzip(b);
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' }, data: { domains: ['new.domain', 'new.domain.two', 'foo.example', 'bar.example'] } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 200);
      const { domains } = await resp.json();
      assert.deepStrictEqual(domains, ['foo.example', 'bar.example', 'new.domain', 'new.domain.two']);

      assert.strictEqual(bodies.org, '{"domains":["foo.example","bar.example","new.domain","new.domain.two"]}');
      assert.strictEqual(bodies.orgkeys, '{"adobe":"ORG-KEY"}');
      assert.strictEqual(bodies.orgkeys2, '{"existing":"EXISTING-ORG-KEY","adobe":"ORG-KEY"}');
    });
  });

  describe('DELETE /orgs/:id/domains/:domain', () => {
    it('returns 404 for missing domain', async () => {
      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/domains/' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns 404 for missing org', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(404);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/domains/www.adobe.com' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns 200, halts early for no change', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: ['foo.example'] }));

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/domains/www.adobe.com' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
    });

    it('removes domain from org', async () => {
      const bodies = { org: undefined, orgkeys: undefined };
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: ['foo.example', 'www.adobe.com', 'other.bar'] }))
        .put('/orgs/adobe/org.json?x-id=PutObject', async (b) => {
          bodies.org = await ungzip(b);
          return true;
        })
        .reply(200)
        .get('/domains/www.adobe.com/.orgkeys.json?x-id=GetObject')
        .reply(200, JSON.stringify({ adobe: 'ORG-KEY', other: 'OTHER-ORG-KEY' }))
        .put('/domains/www.adobe.com/.orgkeys.json?x-id=PutObject', async (b) => {
          bodies.orgkeys = await ungzip(b);
          return true;
        })
        .reply(200, JSON.stringify({ adobe: 'ORG-KEY', other: 'OTHER-ORG-KEY' }));

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/domains/www.adobe.com' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      assert.strictEqual(bodies.org, '{"domains":["foo.example","other.bar"]}');
      assert.strictEqual(bodies.orgkeys, '{"other":"OTHER-ORG-KEY"}');
    });
  });

  describe('GET /orgs/:id', () => {
    it('rejects unauthorized', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/.orgkey?x-id=GetObject')
        .reply(200, 'ORG-KEY');
      const req = REQUEST({ method: 'GET', token: 'invalid' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 403);
    });

    it('returns 404 for non-existent org', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns org', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: ['foo.example', 'www.adobe.com'] }));
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const data = await resp.json();
      assert.deepStrictEqual(data, { domains: ['foo.example', 'www.adobe.com'] });
    });
  });

  describe('POST /orgs/:id/key', () => {
    it('returns 404 for non-existent org', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('rotates the orgkey', async () => {
      const bodies = {};
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: ['existing.example'] }))
        .put('/orgs/adobe/.orgkey?x-id=PutObject', async (b) => {
          bodies.orgkey = await ungzip(b);
          return true;
        })
        .reply(200)
        .get('/domains/existing.example/.orgkeys.json?x-id=GetObject')
        .reply(200, JSON.stringify({ adobe: 'should-be-overwritten', foo: 'should-be-retained' }))
        .put('/domains/existing.example/.orgkeys.json?x-id=PutObject', async (b) => {
          bodies.domainOrgkeyMap = await ungzip(b);
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { orgkey } = await resp.json();
      assert.strictEqual(orgkey, 'TEST-UUID');
      assert.strictEqual(bodies.orgkey, 'TEST-UUID');
      assert.strictEqual(bodies.domainOrgkeyMap, '{"adobe":"TEST-UUID","foo":"should-be-retained"}');
    });
  });

  describe('PUT /orgs/:id/key', () => {
    it('returns 404 for non-existent org', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/key' }, data: { orgkey: 'valid-key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('rejects invalid orgkey', async () => {
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/key' }, data: { orgkey: 123 } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid orgkey');
    });

    it('sets the orgkey', async () => {
      const bodies = {};
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: [] }))
        .put('/orgs/adobe/.orgkey?x-id=PutObject', async (b) => {
          bodies.orgkey = await ungzip(b);
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/key' }, data: { orgkey: 'MY-NEW-ORGKEY' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 204);
      assert.strictEqual(bodies.orgkey, 'MY-NEW-ORGKEY');
    });
  });
});
