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
import handleRequest from '../../src/api/index.js';
import { DEFAULT_CONTEXT, Nock, assertRejectsWithResponse } from '../util.js';

describe('api Tests', () => {
  describe('handleRequest()', () => {
    /** @type {Request} */
    let req;
    /** @type {import('../util.js').Nocker} */
    let nock;

    beforeEach(() => {
      req = new Request('https://localhost/');
      nock = new Nock().env();
    });
    afterEach(() => {
      nock.done();
    });

    it('hourly api returns empty bundles array if file does not exist', async () => {
      nock.domainKey();
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/2024/3/1/0.json?x-id=GetObject')
        .reply(404);

      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/bundles/example.com/2024/03/01/0.json' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { rumBundles } = await resp.json();
      assert.deepStrictEqual(rumBundles, []);
    });

    it('get hourly data', async () => {
      const now = new Date().toISOString();
      nock.domainKey();
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/2024/3/1/0.json?x-id=GetObject')
        .reply(200, JSON.stringify({
          bundles: {
            'foo-/some/path': {
              id: 'foo',
              url: 'https://example.com/some/path',
              timeSlot: now,
              events: [{
                checkpoint: 'top',
              }],
            },
          },
        }));

      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/bundles/example.com/2024/03/01/0.json' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const data = await resp.json();
      assert.deepStrictEqual(data, {
        rumBundles: [{
          id: 'foo',
          url: 'https://example.com/some/path',
          timeSlot: now,
          events: [{
            checkpoint: 'top',
          }],
        }],
      });
    });

    it('get hourly data - over limit, serves aggregate if it exists', async () => {
      const now = new Date().toISOString();
      nock.domainKey();
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/2024/3/1/0.json?x-id=GetObject')
        .reply(200, JSON.stringify({
          bundles: {
            'foo-/some/path': {
              id: 'foo',
              url: 'https://example.com/some/path',
              timeSlot: now,
              events: [{
                checkpoint: 'top',
              }],
            },
          },
        }))
        .get('/example.com/2024/3/1/0/aggregate.json?x-id=GetObject')
        .reply(200, JSON.stringify({
          rumBundles: [{
            id: 'foo',
            url: 'https://example.com/some/path/from/aggregate',
            timeSlot: now,
            events: [{
              checkpoint: 'top',
            }],
          }],
        }));

      const ctx = DEFAULT_CONTEXT({ env: { HOURLY_FILE_MAX_SIZE: 100 }, pathInfo: { suffix: '/bundles/example.com/2024/03/01/0.json' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const data = await resp.json();
      assert.deepStrictEqual(data, {
        rumBundles: [{
          id: 'foo',
          url: 'https://example.com/some/path/from/aggregate',
          timeSlot: now,
          events: [{
            checkpoint: 'top',
          }],
        }],
      });
    });

    it('get hourly data - over limit, downsamples if no aggregate exists', async () => {
      const now = new Date().toISOString();
      nock.domainKey();
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/2024/3/1/0.json?x-id=GetObject')
        .reply(200, JSON.stringify({
          bundles: {
            'foo-/some/path': {
              id: 'foo',
              url: 'https://example.com/some/path',
              timeSlot: now,
              events: [{
                checkpoint: 'top',
              }],
            },
          },
        }))
        .get('/example.com/2024/3/1/0/aggregate.json?x-id=GetObject')
        .reply(404)
        .put('/example.com/2024/3/1/0/aggregate.json?x-id=PutObject')
        .reply((_, body) => {
          assert.deepStrictEqual(body, {
            rumBundles: [{
              id: 'foo',
              url: 'https://example.com/some/path',
              timeSlot: now,
              events: [{
                checkpoint: 'top',
              }],
            }],
          });
          return [200, ''];
        });

      const ctx = DEFAULT_CONTEXT({ env: { HOURLY_FILE_MAX_SIZE: 100 }, pathInfo: { suffix: '/bundles/example.com/2024/03/01/0.json' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const data = await resp.json();
      assert.deepStrictEqual(data, {
        rumBundles: [{
          id: 'foo',
          url: 'https://example.com/some/path',
          timeSlot: now,
          events: [{
            checkpoint: 'top',
          }],
        }],
      });
    });

    it('get daily data', async () => {
      nock.domainKey();
      nock.getAggregate(2024, 3, 1);
      nock.putAggregate(2024, 3, 1);

      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/2024/3/1/0.json?x-id=GetObject')
        .reply(200, JSON.stringify({
          bundles: {
            'foo-/some/path': {
              id: 'foo',
              url: 'https://example.com/some/path',
              timeSlot: '1',
              time: '2024-03-01T00:00:00.001Z',
              weight: 10,
              events: [{
                checkpoint: 'top',
              }],
            },
            'bar-/some/other/path': {
              id: 'bar',
              url: 'https://example.com/some/other/path',
              timeSlot: '2',
              time: '2024-03-01T00:00:00.002Z',
              weight: 10,
              events: [{
                checkpoint: 'top',
              }],
            },
          },
        }))
        .get('/example.com/2024/3/1/1.json?x-id=GetObject')
        .reply(200, JSON.stringify({
          bundles: {
            'foo-/foo': {
              id: 'foo',
              url: 'https://example.com/foo',
              timeSlot: '3',
              time: '2024-03-01T01:00:03.001Z',
              weight: 10,
              events: [],
            },
            'bar-/some/other/path': {
              id: 'bar',
              url: 'https://example.com/some/other/path',
              timeSlot: '4',
              time: '2024-03-01T01:00:00.004Z',
              weight: 10,
              events: [{
                checkpoint: 'top',
              }],
            },
          },
        }))
        .get(() => true)
        .times(22)
        .reply(404);

      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/bundles/example.com/2024/03/01.json' } });

      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);

      const data = await resp.json();
      assert.deepStrictEqual(data, {
        rumBundles: [
          {
            id: 'foo',
            url: 'https://example.com/some/path',
            timeSlot: '1',
            time: '2024-03-01T00:00:00.001Z',
            weight: 10,
            events: [
              {
                checkpoint: 'top',
              },
            ],
          },
          {
            id: 'bar',
            url: 'https://example.com/some/other/path',
            timeSlot: '2',
            time: '2024-03-01T00:00:00.002Z',
            weight: 10,
            events: [
              {
                checkpoint: 'top',
              },
            ],
          },
          {
            id: 'foo',
            url: 'https://example.com/foo',
            timeSlot: '3',
            time: '2024-03-01T01:00:03.001Z',
            weight: 10,
            events: [],
          },
          {
            id: 'bar',
            url: 'https://example.com/some/other/path',
            timeSlot: '4',
            time: '2024-03-01T01:00:00.004Z',
            weight: 10,
            events: [
              {
                checkpoint: 'top',
              },
            ],
          },
        ],
      });
    });

    it('get monthly data', async () => {
      nock.domainKey();
      nock.getAggregate(2024, 2);
      nock.putAggregate(2024, 2);

      const responseBodies = [[{
        id: 'foo',
        url: 'https://example.com/foo',
        timeSlot: '1',
        time: '2024-02-01T00:00:00.000Z',
        weight: 1000000,
        events: [{ checkpoint: 'top' }],
      }], [{
        id: 'bar',
        url: 'https://example.com/bar',
        timeSlot: '2',
        time: '2024-02-02T01:00:00.000Z',
        weight: 100,
        events: [{ checkpoint: 'top' }],
      }], [{
        id: 'baz',
        url: 'https://example.com/baz',
        timeSlot: '3',
        time: '2024-02-03T02:00:00.000Z',
        weight: 1,
        events: [{ checkpoint: 'top' }],
      }],
      ...new Array(25).fill([]),
      [{
        id: 'end',
        url: 'https://example.com/end',
        timeSlot: '29',
        time: '2024-02-29T03:00:00.000Z',
        weight: 100,
        events: [{ checkpoint: 'top' }],
      }]];
      nock('https://endpoint.example')
        .get((uri) => uri.startsWith('/bundles/example.com/2024/2/'))
        .times(29) // honors leap years
        .reply(() => [200, JSON.stringify({ rumBundles: responseBodies.shift() })]);

      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/bundles/example.com/2024/02' } });

      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      assert.strictEqual(responseBodies.length, 0);

      const data = await resp.json();
      assert.deepStrictEqual(data, {
        rumBundles: [
          {
            id: 'foo',
            url: 'https://example.com/foo',
            timeSlot: '1',
            time: '2024-02-01T00:00:00.000Z',
            weight: 1000000,
            events: [{ checkpoint: 'top' },
            ],
          },
          {
            id: 'bar',
            url: 'https://example.com/bar',
            timeSlot: '2',
            time: '2024-02-02T01:00:00.000Z',
            weight: 100,
            events: [{ checkpoint: 'top' }],
          },
          {
            id: 'baz',
            url: 'https://example.com/baz',
            timeSlot: '3',
            time: '2024-02-03T02:00:00.000Z',
            weight: 1,
            events: [{ checkpoint: 'top' }],
          },
          {
            id: 'end',
            url: 'https://example.com/end',
            timeSlot: '29',
            time: '2024-02-29T03:00:00.000Z',
            weight: 100,
            events: [{ checkpoint: 'top' }],
          },
        ],
      });
    });

    it('unknown route, returns 404', async () => {
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/foo' } });
      const prom = handleRequest(req, ctx);
      await assertRejectsWithResponse(prom, 404);
    });

    it('OPTIOMS always returns 204 for valid routes', async () => {
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/orgs' } });
      req = new Request('https://localhost/', { method: 'OPTIONS' });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 204);
    });
  });
});
