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
import handleRequest from '../../src/api/admins.js';
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
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid permission: foo:read');

      // invalid action
      req = REQUEST({ method: 'POST' });
      ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', permissions: ['domainkeys:foo'] } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid permission: domainkeys:foo');

      // not an array
      req = REQUEST({ method: 'POST' });
      ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', permissions: 'invalid' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid permissions');

      // invalid entry datatype
      req = REQUEST({ method: 'POST' });
      ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins' }, data: { id: 'foo', permissions: ['domainkeys:read', 123] } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid permissions');
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
      assert.strictEqual(await ungzip(bodies.admin), '{"permissions":[]}');
      assert.strictEqual(await ungzip(bodies.adminkey), 'TEST-UUID');
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
      assert.strictEqual(await ungzip(bodies.admin), '{"permissions":["domainkeys:read","domainkeys:write"]}');
      assert.strictEqual(await ungzip(bodies.adminkey), 'TEST-UUID');
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
      const { items } = await resp.json();
      assert.deepStrictEqual(items, ['adobe', 'foo', 'bar']);
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
        .reply(200, JSON.stringify({ permissions: [] }))
        .get('/admins/foo/.adminkey?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' }, data: { permissions: ['domainkeys:write'] } });
      await assertRejectsWithResponse(handleRequest(req, ctx), 400, 'adminkey not defined');
    });

    it('adds only the new permissions', async () => {
      const bodies = { admin: undefined };
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: ['domainkeys:read'] }))
        .get('/admins/foo/.adminkey?x-id=GetObject')
        .reply(200, 'ADMIN-KEY')
        .put('/admins/foo/admin.json?x-id=PutObject', async (b) => {
          bodies.admin = await ungzip(b);
          return true;
        })
        .reply(200);

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
        .get('/admins/foo/admin.json?x-id=GetObject')
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

  describe('DELETE /admins/:id/permissions/:permission', () => {
    it('returns 404 for missing permission', async () => {
      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/permissions/' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns 404 for missing admin', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(404);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/permissions/domainkeys:read' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns 200, halts early for no change', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: ['domainkeys:read'] }));

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/permissions/domainkeys:write' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
    });

    it('removes permission from admin', async () => {
      const bodies = { admin: undefined };
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: ['domainkeys:read', 'domainkeys:write'] }))
        .put('/admins/foo/admin.json?x-id=PutObject', async (b) => {
          bodies.admin = await ungzip(b);
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/permissions/domainkeys:write' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      assert.strictEqual(bodies.admin, '{"permissions":["domainkeys:read"]}');
    });
  });

  describe('DELETE /admins/:id', () => {
    it('returns 404 for missing admin', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(404);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('removes admin.json and .adminkey', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: ['domainkeys:read'] }))
        .post('/?delete=', async (b) => {
          assert.ok(b.includes('admins/foo/admin.json'), 'should delete admin.json');
          assert.ok(b.includes('admins/foo/.adminkey'), 'should delete adminkey');
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'DELETE' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 204);
    });
  });

  describe('GET /admins/:id', () => {
    it('returns 404 for non-existent admin', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns admin', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: ['domainkeys:read'] }));
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const data = await resp.json();
      assert.deepStrictEqual(data, { permissions: ['domainkeys:read'] });
    });
  });

  describe('POST /admins/:id/key', () => {
    it('returns 404 for non-existent admin', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('rotates the adminkey', async () => {
      const bodies = {};
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: ['domainkeys:read'] }))
        .put('/admins/foo/.adminkey?x-id=PutObject', async (b) => {
          bodies.adminkey = await ungzip(b);
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'POST' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { adminkey } = await resp.json();
      assert.strictEqual(adminkey, 'admin:foo:TEST-UUID');
      assert.strictEqual(bodies.adminkey, 'TEST-UUID');
    });
  });

  describe('PUT /admins/:id/key', () => {
    it('returns 404 for non-existent admin', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/key' }, data: { adminkey: 'admin:foo:valid-key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('rejects invalid adminkey (not string)', async () => {
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/key' }, data: { adminkey: 123 } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid adminkey');
    });

    it('rejects invalid adminkey (missing required prefix)', async () => {
      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/key' }, data: { adminkey: 'admin:wrongid:somekey' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 400, 'invalid adminkey, expecting admin:<id>:<key>');
    });

    it('sets the adminkey', async () => {
      const bodies = {};
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/admin.json?x-id=GetObject')
        .reply(200, JSON.stringify({ permissions: [] }))
        .put('/admins/foo/.adminkey?x-id=PutObject', async (b) => {
          bodies.adminkey = await ungzip(b);
          return true;
        })
        .reply(200);

      const req = REQUEST({ method: 'PUT' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/key' }, data: { adminkey: 'admin:foo:MY-NEW-ADMINKEY' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 204);
      assert.strictEqual(bodies.adminkey, 'MY-NEW-ADMINKEY');
    });
  });

  describe('GET /admins/:id/key', () => {
    it('returns 404 for non-existent adminkey', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/.adminkey?x-id=GetObject')
        .reply(404);
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 404);
    });

    it('returns adminkey', async () => {
      nock('https://helix-rum-users.s3.us-east-1.amazonaws.com')
        .get('/admins/foo/.adminkey?x-id=GetObject')
        .reply(200, 'THE-KEY');
      const req = REQUEST({ method: 'GET' });
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/admins/foo/key' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { adminkey } = await resp.json();
      assert.strictEqual(adminkey, 'admin:foo:THE-KEY');
    });
  });
});
