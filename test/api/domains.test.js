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
import handleRequest from '../../src/api/domains.js';
import { DEFAULT_CONTEXT, Nock } from '../util.js';

// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUEST = ({ method, params = {}, token = 'superkey' }) => new Request(`https://localhost/?${new URLSearchParams(params)}`, {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

describe('api/domains Tests', () => {
  /** @type {import('../util.js').Nocker} */
  let nock;
  beforeEach(() => {
    nock = new Nock().env();
  });
  afterEach(() => {
    nock.done();
  });

  it('GET /domains returns list of domains', async () => {
    const listBody = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-domains.xml'), 'utf-8');
    nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
      .get('/?delimiter=%2F&list-type=2&max-keys=1000&prefix=')
      .reply(200, listBody);

    const req = REQUEST({ method: 'GET' });
    const ctx = DEFAULT_CONTEXT({
      data: {},
      pathInfo: { suffix: '/domains' },
    });
    const resp = await handleRequest(req, ctx);
    assert.strictEqual(resp.status, 200);
    const data = await resp.json();
    assert.deepStrictEqual(data, {
      items: ['www.adobe.com', 'www.aem.live', 'blog.adobe.com'],
      pagination: { limit: 1000 },
      links: {},
    });
  });

  it('GET /domains returns pagination data if needed', async () => {
    const listBody = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-domains-truncated.xml'), 'utf-8');
    nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
      .get('/?delimiter=%2F&list-type=2&max-keys=3&prefix=')
      .reply(200, listBody);

    const req = REQUEST({ method: 'GET' });
    const ctx = DEFAULT_CONTEXT({
      data: { limit: 3 },
      pathInfo: { suffix: '/domains' },
    });
    const resp = await handleRequest(req, ctx);
    assert.strictEqual(resp.status, 200);
    const data = await resp.json();
    assert.deepStrictEqual(data, {
      items: ['www.adobe.com', 'www.aem.live', 'blog.adobe.com'],
      pagination: {
        limit: 3,
        next: 'abc=',
      },
      links: {
        next: 'https://endpoint.example/domains?start=abc%3D&limit=3',
      },
    });
  });

  it('GET /domains uses provided start token', async () => {
    const listBody = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-domains.xml'), 'utf-8');
    nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
      .get('/?continuation-token=abc%3D&delimiter=%2F&list-type=2&max-keys=3&prefix=')
      .reply(200, listBody);

    const req = REQUEST({ method: 'GET' });
    const ctx = DEFAULT_CONTEXT({
      data: { limit: '3', start: 'abc=' },
      pathInfo: { suffix: '/domains' },
    });
    const resp = await handleRequest(req, ctx);
    assert.strictEqual(resp.status, 200);
    const data = await resp.json();
    assert.deepStrictEqual(data, {
      items: ['www.adobe.com', 'www.aem.live', 'blog.adobe.com'],
      pagination: {
        limit: 3,
        start: 'abc=',
      },
      links: {},
    });
  });
});
