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
import esmock from 'esmock';
import { Request, Response } from '@adobe/fetch';
import { main } from '../src/index.js';
import { Nock } from './util.js';

describe('Index Tests', () => {
  it.skip('rejects unauthorized requests', async () => {
    const nock = Nock().domainKey('x', 'y');

    const resp = await main(new Request('https://localhost/'), {
      env: {},
      attributes: {},
      log: console,
      pathInfo: { suffix: '/bundles/x' },
    });
    assert.strictEqual(resp.status, 403);

    nock.done();
  });

  it('performs bundling when invoked by scheduler', async () => {
    const { main: mmain } = await esmock('../src/index.js', {
      '../src/bundler/index.js': {
        default: () => Promise.resolve(new Response('', { status: 200, headers: { route: 'bundle-rum' } })),
      },
      '../src/api/index.js': {
        default: () => Promise.resolve(new Response('', { status: 200, headers: { route: 'handle-request' } })),
      },
    });

    const resp = await mmain(
      new Request('https://localhost/'),
      { log: console, env: {}, invocation: { event: { source: 'aws.scheduler' } } },
    );
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(resp.headers.get('route'), 'bundle-rum');
  });
});
