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
import handleRequest from '../../src/api/orgs.js';
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

  describe('createOrg()', () => {
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
});
