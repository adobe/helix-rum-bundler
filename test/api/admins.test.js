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

describe('api/admins Tests', () => {
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
    const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' } });
    const resp = await handleRequest(req, ctx);
    assert.deepEqual(resp.status, 405);
  });

  describe('POST /admins', () => {
    it('rejects invalid (missing id)', async () => {
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: null } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid id');
    });

    it('rejects invalid permissions', async () => {
      // invalid scope
      let req = REQUEST({ method: 'POST' });
      let ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', permissions: ['foo:read'] } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid permissions');

      // invalid action
      req = REQUEST({ method: 'POST' });
      ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', permissions: ['domainkeys:foo'] } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid permissions');

      // not an array
      req = REQUEST({ method: 'POST' });
      ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', permissions: 'invalid' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid permissions');

      // invalid entry datatype
      req = REQUEST({ method: 'POST' });
      ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', permissions: ['domainkeys:read', 123] } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid permissions');
    });

    it('rejects invalid permissions (invalid action)', async () => {
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', helixOrgs: 'invalid' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid helixOrgs');
    });

    it('rejects already existing', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .head('/admins/foo/admin.json')
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 409);
    });

    it('accepts valid, without initial permissions', async () => {
      const bodies = { admin: undefined, adminkey: undefined };

      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .head('/admins/foo/admin.json')
        .reply(404);

      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .put('/admins/foo/admin.json?x-id=PutObject', (b) => {
          bodies.admin = b;
          return true;
        })
        .reply(200)
        .put('/admins/foo/.adminkey?x-id=PutObject', (b) => {
          bodies.adminkey = b;
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo' } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 200);
      assert.strictEqual(await ungzip(bodies.org), '{"permissions":[]}');
      assert.strictEqual(await ungzip(bodies.orgkey), 'TEST-UUID');
      assert.deepStrictEqual(await resp.json(), { adminkey: 'admin:foo:TEST-UUID' });
    });

    it('accepts valid, with initial permissions', async () => {
      const bodies = { admin: undefined, adminkey: undefined };

      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .head('/admins/foo/admin.json')
        .reply(404);

      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .put('/admins/foo/admin.json?x-id=PutObject', (b) => {
          bodies.admin = b;
          return true;
        })
        .reply(200)
        .put('/admins/foo/.adminkey?x-id=PutObject', (b) => {
          bodies.adminkey = b;
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', permissions: ['domainkeys:read', 'domainkeys:write'] } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 200);
      assert.strictEqual(await ungzip(bodies.org), '{"permissions":["domainkeys:read","domainkeys:write"]}');
      assert.strictEqual(await ungzip(bodies.orgkey), 'TEST-UUID');
      assert.deepStrictEqual(await resp.json(), { adminkey: 'admin:foo:TEST-UUID' });
    });
  });

  describe('GET /admins', () => {
    it('returns admins', async () => {
      const listBody = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-admins.xml'), 'utf-8');
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/?delimiter=%2F&list-type=2&max-keys=1000&prefix=admins%2F')
        .reply(200, listBody);

      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { admins } = await resp.json();
      assert.deepStrictEqual(admins, ['adobe', 'foo', 'bar']);
    });
  });

  describe('POST /admins/:id', () => {
    it('returns 400 for invalid permissions', async () => {
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' }, data: { permissions: [123] } });
      await assertRejectsWithResponse(handleRequest(req, ctx), 400, 'invalid permissions');
    });

    it('returns 404 if admin does not exist', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' }, data: { permissions: ['domainkeys:write'] } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('halts request if adminkey missing (inconsistent storage, should not occur)', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: [] }))
        .get('/admins/foo/.adminkey?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' }, data: { domains: ['domainkeys:write'] } });
      await assertRejectsWithResponse(handleRequest(req, ctx), 400, 'adminkey not defined');
    });

    it('adds only the new permissions', async () => {
      const bodies = { admin: undefined };
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admins.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: ['domainkeys:read'] }))
        .get('/admins/foo/.adminkey?x-id=GetObject')
        .reply(200, 'ADMIN-KEY')
        .put('/admins/foo/admin.json?x-id=PutObject', async (b) => {
          bodies.admin = await ungzip(b);
          return true;
        });

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' }, data: { permissions: ['domainkeys:write'] } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 200);
      const { permissions } = await resp.json();
      assert.deepStrictEqual(permissions, ['domainkeys:read', 'domainkeys:write']);
      assert.strictEqual(bodies.admin, '{"permissions":["domainkeys:read","domainkeys:write"]}');
    });

    it('skips write if no new permissions added', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admins.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: ['domainkeys:read', 'domainkeys:write'] }))
        .get('/admins/foo/.adminkey?x-id=GetObject')
        .reply(200, 'ADMIN-KEY');

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' }, data: { permissions: ['domainkeys:write'] } });
      const resp = await handleRequest(req, ctx);

      assert.strictEqual(resp.status, 200);
      const { permissions } = await resp.json();
      assert.deepStrictEqual(permissions, ['domainkeys:read', 'domainkeys:write']);
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

  describe('DELETE /orgs/:id/helixorgs/:helixorg', () => {
    it('returns 404 for missing helixorg', async () => {
      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/helixorgs/' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns 404 for missing org', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(404);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/helixorgs/foo' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns 200, halts early for no change', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: [], helixOrgs: ['adobe', 'adobecom'] }));

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/helixorgs/foo' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
    });

    it('removes helixorg from org', async () => {
      const bodies = { org: undefined };
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: ['www.adobe.com'], helixOrgs: ['adobe', 'adobecom', 'foo'] }))
        .put('/orgs/adobe/org.json?x-id=PutObject', async (b) => {
          bodies.org = await ungzip(b);
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/helixorgs/foo' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      assert.strictEqual(bodies.org, '{"domains":["www.adobe.com"],"helixOrgs":["adobe","adobecom"]}');
    });
  });

  describe('DELETE /orgs/:id', () => {
    it('returns 404 for missing org', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(404);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('removes org from all domains, deletes orgkey and org.json', async () => {
      let body;
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/org.json?x-id=GetObject')
        .reply(200, JSON.stringify({ domains: ['foo.example', 'www.adobe.com', 'dont.exist'] }))
        .post('/?delete=', async (b) => {
          assert.ok(b.includes('orgs/adobe/org.json'), 'should delete org.json');
          assert.ok(b.includes('orgs/adobe/.orgkey'), 'should delete orgkey');
          return true;
        })
        .reply(200)
        .get('/domains/foo.example/.orgkeys.json?x-id=GetObject')
        .reply(200, JSON.stringify({ adobe: 'ORG-KEY', other: 'OTHER-ORG-KEY' }))
        .get('/domains/www.adobe.com/.orgkeys.json?x-id=GetObject')
        .reply(200, JSON.stringify({ foo: 'OTHER-ORG-KEY' }))
        .get('/domains/dont.exist/.orgkeys.json?x-id=GetObject')
        .reply(404)
        .put('/domains/foo.example/.orgkeys.json?x-id=PutObject', async (b) => {
          body = JSON.parse(await ungzip(b));
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 204);
      assert.deepStrictEqual(body, { other: 'OTHER-ORG-KEY' });
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

  describe('GET /orgs/:id/key', () => {
    it('returns 404 for non-existent orgkey', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/.orgkey?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns orgkey', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/orgs/adobe/.orgkey?x-id=GetObject')
        .reply(200, 'THE-KEY');
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs/adobe/key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { orgkey } = await resp.json();
      assert.strictEqual(orgkey, 'THE-KEY');
    });
  });
});
