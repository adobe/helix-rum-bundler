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
import handleRequest, { parsePath, assertAuthorization, getCacheControl } from '../src/api.js';
import { DEFAULT_CONTEXT, Nock, assertRejectsWithResponse } from './util.js';

describe('api Tests', () => {
  describe('handleRequest()', () => {
    /** @type {Request} */
    let req;
    /** @type {import('./util.js').Nocker} */
    let nock;

    beforeEach(() => {
      req = new Request('https://localhost/', { headers: { 'x-api-key': 'domainkey' } });
      nock = new Nock().env();
    });
    afterEach(() => {
      nock.done();
    });

    it('monthly api not implemented', async () => {
      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/domain/2024/03.json' } });
      await assertRejectsWithResponse(() => handleRequest(req, ctx), 501, 'not implemented');
    });

    it('hourly api returns 404 if hour file does not exist', async () => {
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/2024/3/1/0.json?x-id=GetObject')
        .reply(404);

      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/example.com/2024/03/01/0.json' } });
      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);
      const { rumBundles } = await resp.json();
      assert.deepStrictEqual(rumBundles, []);
    });

    it('get hourly data', async () => {
      const now = new Date().toISOString();
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

      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/example.com/2024/03/01/0.json' } });
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
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        .get('/example.com/2024/3/1/0.json?x-id=GetObject')
        .reply(200, JSON.stringify({
          bundles: {
            'foo-/some/path': {
              id: 'foo',
              url: 'https://example.com/some/path',
              timeSlot: '1',
              weight: 10,
              events: [{
                checkpoint: 'top',
              }],
            },
            'bar-/some/other/path': {
              id: 'bar',
              url: 'https://example.com/some/other/path',
              timeSlot: '2',
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
              weight: 10,
              events: [],
            },
            'bar-/some/other/path': {
              id: 'bar',
              url: 'https://example.com/some/other/path',
              timeSlot: '4',
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

      const ctx = DEFAULT_CONTEXT({ pathInfo: { suffix: '/example.com/2024/03/01.json' } });

      const resp = await handleRequest(req, ctx);
      assert.strictEqual(resp.status, 200);

      const data = await resp.json();
      assert.deepStrictEqual(data, {
        rumBundles: [
          {
            id: 'foo',
            url: 'https://example.com/some/path',
            timeSlot: '1',
            weight: 10,
            events: [{ checkpoint: 'top' }],
          },
          {
            id: 'bar',
            url: 'https://example.com/some/other/path',
            timeSlot: '2',
            weight: 10,
            events: [{ checkpoint: 'top' }],
          },
          {
            id: 'foo',
            url: 'https://example.com/foo',
            timeSlot: '3',
            weight: 10,
            events: [],
          },
          {
            id: 'bar',
            url: 'https://example.com/some/other/path',
            timeSlot: '4',
            weight: 10,
            events: [{ checkpoint: 'top' }],
          },
        ],
      });
    });
  });

  describe('assertAuthorization()', () => {
    it('should throw 401 response on unauthorized requests', async () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' } };

      await assertRejectsWithResponse(async () => assertAuthorization(
        new Request('https://localhost/', { headers: {} }),
        ctx,
      ), 401, 'missing x-api-key');

      await assertRejectsWithResponse(async () => assertAuthorization(
        new Request('https://localhost/', { headers: { 'x-api-key': 'bar' } }),
        ctx,
      ), 403, 'invalid x-api-key');
    });

    it('allows x-api-key header', () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' } };

      assert.doesNotThrow(() => assertAuthorization(
        new Request('https://localhost/', { headers: { 'x-api-key': 'foo' } }),
        ctx,
      ));
    });

    it('allows domainkey param', () => {
      const ctx = { env: { TMP_SUPERUSER_API_KEY: 'foo' }, data: { domainkey: 'foo' } };

      assert.doesNotThrow(() => assertAuthorization(
        new Request('https://localhost/'),
        ctx,
      ));
    });
  });

  describe('parsePath()', () => {
    it('should throw 404 response on invalid paths', async () => {
      await assertRejectsWithResponse(async () => parsePath('/short.json'), 404, 'invalid path (short)');
      await assertRejectsWithResponse(async () => parsePath('/long/a/b/c/d/e/f/g/h.json'), 404, 'invalid path (long)');
      await assertRejectsWithResponse(async () => parsePath(''), 404, 'invalid path');
    });

    it('parses paths', () => {
      // with hour
      let parsed = parsePath('/domain/2024/01/01/0.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/1/1/0');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        domain: 'domain',
        year: 2024,
        month: 1,
        day: 1,
        hour: 0,
        toString: undefined,
      });

      const parsedNoJson = parsePath('/domain/2024/01/01/0');
      assert.deepStrictEqual(
        { ...parsed, toString: undefined },
        { ...parsedNoJson, toString: undefined },
      );

      // with day
      parsed = parsePath('/domain/2024/3/4.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/3/4');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        domain: 'domain',
        year: 2024,
        month: 3,
        day: 4,
        toString: undefined,
      });

      // with month
      parsed = parsePath('/domain/2024/12.json');
      assert.strictEqual(parsed.toString(), '/domain/2024/12');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        domain: 'domain',
        year: 2024,
        month: 12,
        toString: undefined,
      });

      // with year
      parsed = parsePath('/domain/2024.json');
      assert.strictEqual(parsed.toString(), '/domain/2024');
      assert.deepStrictEqual({ ...parsed, toString: undefined }, {
        domain: 'domain',
        year: 2024,
        toString: undefined,
      });
    });
  });

  describe('getCacheControl()', () => {
    const ogDate = Date;
    beforeEach(() => {
      global.Date = class extends Date {
        static _stubbed = [];

        constructor(...args) {
          // eslint-disable-next-line no-underscore-dangle
          super(...(Date._stubbed.shift() || args));
        }

        static stub(...args) {
          // eslint-disable-next-line no-underscore-dangle
          Date._stubbed.push(args);
          return Date;
        }
      };
    });
    afterEach(() => {
      global.Date = ogDate;
    });

    /**
     * NOTE: Date stub uses 0-index month (like the DateConstructor)
     * and the resource uses 1-index month (like the S3 folder structure, api)
     */
    it('daily/hourly bundles >1 year old should be cached forever', () => {
      Date.stub(2024, 0, 1);
      const resource = {
        year: 2023,
        month: 1,
        day: 1,
      };
      let val = getCacheControl(resource); // daily bundle
      assert.strictEqual(val, 'public, max-age=31536000');

      Date.stub(2024, 0, 1);
      resource.hour = 0;
      val = getCacheControl(resource); // hourly bundle
      assert.strictEqual(val, 'public, max-age=31536000');
    });

    it('daily/hourly bundles >1 month old should be cached forever', () => {
      Date.stub(2024, 1, 1);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
      };
      let val = getCacheControl(resource); // daily bundle
      assert.strictEqual(val, 'public, max-age=31536000');

      Date.stub(2024, 1, 1);
      resource.hour = 0;
      val = getCacheControl(resource); // hourly bundle
      assert.strictEqual(val, 'public, max-age=31536000');
    });

    it('daily bundles <25h old should be cached for 60min', () => {
      Date.stub(2024, 0, 2);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
      };
      const val = getCacheControl(resource);
      assert.strictEqual(val, 'public, max-age=3600000');
    });

    it('hourly bundles >=70m old should be cached forever', () => {
      Date.stub(2024, 0, 1, 2, 10, 1);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
        hour: 1,
      };
      const val = getCacheControl(resource);
      assert.strictEqual(val, 'public, max-age=31536000');
    });

    it('hourly bundles <70min old should be cached for 10min', () => {
      Date.stub(2024, 0, 1, 2, 0);
      const resource = {
        year: 2024,
        month: 1,
        day: 1,
        hour: 1,
      };
      const val = getCacheControl(resource);
      assert.strictEqual(val, 'public, max-age=600000');
    });
  });
});
