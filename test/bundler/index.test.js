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

import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import fs from 'fs/promises';
import zlib from 'zlib';
import { promisify } from 'util';
import bundleRUM, { sortRawEvents } from '../../src/bundler/index.js';
import { DEFAULT_CONTEXT, Nock, assertRejectsWithResponse } from '../util.js';

const gzip = promisify(zlib.gzip);

// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const makeEventFile = (...events) => events.map((e) => JSON.stringify(e)).join('\n');

const mockEventLogFile = (domain) => {
  const events = [
    {
      id: 0,
      url: `https://sub.${domain}`,
      time: 0,
      checkpoint: 0,
    },
    ...(
      new Array(9).fill(0).map((_, i) => ({
        id: i < 6 ? i : 'constid',
        // eslint-disable-next-line no-nested-ternary
        url: `https://${domain}${i < 6 ? (i % 2 === 0 ? '/even' : '/odd') : ''}`,
        time: i * 20 * 60 * 1000,
        checkpoint: i + 1,
      }))
    ),
  ];
  return makeEventFile(...events);
};

describe('bundler Tests', () => {
  describe('sortRawEvents()', () => {
    const log = console;

    it('ignores urls without host', () => {
      const sorted = sortRawEvents([{ url: '/some/absolute/path' }], log);
      assert.deepStrictEqual(sorted, { rawEventMap: {}, domains: [] });
    });

    it('sorts into domain/date keys', () => {
      const t1 = 0;
      const t2 = 61 * 60 * 1000;

      const { rawEventMap: sorted, domains } = sortRawEvents([
        { url: 'https://example.com', time: t1, checkpoint: 1 },
        { url: 'https://example.com', time: t2, checkpoint: 2 },
        { url: 'http://example.com:80', time: t1, checkpoint: 3 },
      ], log);

      assert.strictEqual(Object.keys(sorted).length, 2);
      assert.strictEqual(domains.length, 1);

      assert.strictEqual(domains[0], 'example.com');
      assert.deepStrictEqual(sorted['/example.com/1970/1/1/0.json'], {
        events: [
          {
            url: 'https://example.com/',
            time: 0,
            checkpoint: 1,
          },
          {
            url: 'http://example.com/',
            time: 0,
            checkpoint: 3,
          },
        ],
        info: {
          domain: 'example.com',
          year: 1970,
          month: 1,
          day: 1,
          hour: 0,
        },
      });
      assert.deepStrictEqual(sorted['/example.com/1970/1/1/1.json'], {
        events: [
          {
            url: 'https://example.com/',
            time: 3660000,
            checkpoint: 2,
          },
        ],
        info: {
          domain: 'example.com',
          year: 1970,
          month: 1,
          day: 1,
          hour: 1,
        },
      });
    });
  });

  describe('bundleRUM()', () => {
    /** @type {import('../util.js').Nocker} */
    let nock;
    let ogUUID;
    beforeEach(() => {
      nock = new Nock().env();
      ogUUID = crypto.randomUUID;
      crypto.randomUUID = () => 'test-new-key';
    });
    afterEach(() => {
      crypto.randomUUID = ogUUID;
      nock.done();
    });

    it('throws 409 if logs are locked', async () => {
      const ctx = DEFAULT_CONTEXT({
        attributes: {
          storage: {
            logBucket: {
              head: () => Promise.resolve({}),
            },
          },
        },
      });

      await assertRejectsWithResponse(bundleRUM(ctx), 409);
    });

    it('should bundle events', async () => {
      const logsBody = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-logs-single.xml'), 'utf-8');
      const mockEventResponseBody = mockEventLogFile('example.com');
      const bodies = {
        subdomain: {
          manifest: undefined,
          bundle: undefined,
          domainkey: undefined,
        },
        apex: {
          manifest: [],
          bundle: [],
        },
      };

      nock('https://helix-rum-logs.s3.us-east-1.amazonaws.com')
        // logs not locked
        .head('/.lock')
        .reply(404)
        // lock logs
        .put('/.lock?x-id=PutObject')
        .reply(200)
        // list logs
        .get('/?list-type=2&max-keys=100&prefix=raw%2F')
        .reply(200, logsBody)
        // get log file contents
        .get('/raw/2024-01-01T00_00_00.000-1.log?x-id=GetObject')
        .reply(200, mockEventResponseBody)
        // move log file to processed
        .put('/processed/2024-01-01T00_00_00.000-1.log?x-id=CopyObject')
        .reply(200, '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>2024-01-01T00:00:01.000Z</LastModified><ETag>"2"</ETag></CopyObjectResult>')
        .delete('/raw/2024-01-01T00_00_00.000-1.log?x-id=DeleteObject')
        .reply(200)
        // unlock
        .delete('/.lock?x-id=DeleteObject')
        .reply(200);

      // subdomain
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        // check if domain exists (no)
        .head('/sub.example.com/.domainkey')
        .reply(404)
        // create domainkey for new domain
        .put('/sub.example.com/.domainkey?x-id=PutObject')
        .reply(200, (_, body) => {
          bodies.subdomain.domainkey = body;
          return [200];
        })
        // get manifest
        .get('/sub.example.com/1970/1/1/.manifest.json?x-id=GetObject')
        .reply(404)
        // get yesterday's manifest
        .get('/sub.example.com/1969/12/31/.manifest.json?x-id=GetObject')
        .reply(404)
        // instantiate bundlegroup
        .get('/sub.example.com/1970/1/1/0.json?x-id=GetObject')
        .reply(404)
        // store manifest
        .put('/sub.example.com/1970/1/1/.manifest.json?x-id=PutObject')
        .reply((_, body) => {
          bodies.subdomain.manifest = body;
          return [200];
        })
        // store bundlegroup
        .put('/sub.example.com/1970/1/1/0.json?x-id=PutObject')
        .reply((_, body) => {
          bodies.subdomain.bundle = body;
          return [200];
        });
      // add domainkey to subdomain
      nock('https://helix-pages.anywhere.run')
        .post('/helix-services/run-query@v3/rotate-domainkeys')
        .query('url=sub.example.com&newkey=TEST-NEW-KEY&note=rumbundler')
        .reply(200);

      // apex
      nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
        // check if domain exists (yes)
        .head('/example.com/.domainkey')
        .reply(200)
        // get manifest
        .get('/example.com/1970/1/1/.manifest.json?x-id=GetObject')
        .reply(404)
        // get yesterday's manifest
        .get('/example.com/1969/12/31/.manifest.json?x-id=GetObject')
        .reply(404)
        // instantiate bundlegroups
        .get('/example.com/1970/1/1/0.json?x-id=GetObject')
        .reply(404)
        .get('/example.com/1970/1/1/1.json?x-id=GetObject')
        .reply(404)
        .get('/example.com/1970/1/1/2.json?x-id=GetObject')
        .reply(404)
        // store manifest
        .put('/example.com/1970/1/1/.manifest.json?x-id=PutObject')
        .times(3)
        .reply((_, body) => {
          bodies.apex.manifest.push(body);
          return [200];
        })
        // store bundlegroup (0th hour)
        .put('/example.com/1970/1/1/0.json?x-id=PutObject')
        .reply((_, body) => {
          bodies.apex.bundle[0] = body;
          return [200];
        })
        // store bundlegroup (1st hour)
        .put('/example.com/1970/1/1/1.json?x-id=PutObject')
        .reply((_, body) => {
          bodies.apex.bundle[1] = body;
          return [200];
        })
        // store bundlegroup (2nd hour)
        .put('/example.com/1970/1/1/2.json?x-id=PutObject')
        .reply((_, body) => {
          bodies.apex.bundle[2] = body;
          return [200];
        });

      const ctx = DEFAULT_CONTEXT();
      await bundleRUM(ctx);

      const { subdomain, apex } = bodies;
      // one manifest/bundle update for subdomain, since one event exists
      assert.deepStrictEqual(subdomain.manifest, { sessions: { '0--/': { hour: 0 } } });
      assert.deepStrictEqual(subdomain.bundle, {
        bundles: {
          '0--/': {
            id: 0,
            time: '1970-01-01T00:00:00.000Z',
            timeSlot: '1970-01-01T00:00:00.000Z',
            url: 'https://sub.example.com/',
            events: [
              {
                checkpoint: 0,
                timeDelta: 0,
              },
            ],
          },
        },
      });
      assert.strictEqual(subdomain.domainkey, (await gzip('TEST-NEW-KEY')).toString('hex'));

      // 3 manifest updates & 3 bundles for apex, since events were processed into 3 sessions
      // assert.deepStrictEqual(subdomain.manifest[0], { sessions: { '0--/': { hour: 0 } } });
      assert.deepEqual(apex.manifest.length, 3);
      assert.deepEqual(apex.bundle.length, 3);

      assert.deepStrictEqual(apex.manifest[0], {
        sessions: {
          '0--/even': {
            hour: 0,
          },
          '1--/odd': {
            hour: 0,
          },
          '2--/even': {
            hour: 0,
          },
        },
      });

      assert.deepStrictEqual(apex.manifest[1], {
        sessions: {
          '0--/even': {
            hour: 0,
          },
          '1--/odd': {
            hour: 0,
          },
          '2--/even': {
            hour: 0,
          },
          '3--/odd': {
            hour: 1,
          },
          '4--/even': {
            hour: 1,
          },
          '5--/odd': {
            hour: 1,
          },
        },
      });

      assert.deepStrictEqual(apex.manifest[2], {
        sessions: {
          '0--/even': {
            hour: 0,
          },
          '1--/odd': {
            hour: 0,
          },
          '2--/even': {
            hour: 0,
          },
          '3--/odd': {
            hour: 1,
          },
          '4--/even': {
            hour: 1,
          },
          '5--/odd': {
            hour: 1,
          },
          'constid--/': {
            hour: 2,
          },
        },
      });

      // first 3 bundles
      assert.deepStrictEqual(apex.bundle[0], {
        bundles: {
          '0--/even': {
            id: 0,
            time: '1970-01-01T00:00:00.000Z',
            timeSlot: '1970-01-01T00:00:00.000Z',
            url: 'https://example.com/even',
            events: [
              {
                checkpoint: 1,
                timeDelta: 0,
              },
            ],
          },
          '1--/odd': {
            id: 1,
            time: '1970-01-01T00:20:00.000Z',
            timeSlot: '1970-01-01T00:00:00.000Z',
            url: 'https://example.com/odd',
            events: [
              {
                checkpoint: 2,
                timeDelta: 1200000,
              },
            ],
          },
          '2--/even': {
            id: 2,
            time: '1970-01-01T00:40:00.000Z',
            timeSlot: '1970-01-01T00:00:00.000Z',
            url: 'https://example.com/even',
            events: [
              {
                checkpoint: 3,
                timeDelta: 2400000,
              },
            ],
          },
        },
      });

      // next 3 bundles
      assert.deepStrictEqual(apex.bundle[1], {
        bundles: {
          '3--/odd': {
            id: 3,
            time: '1970-01-01T01:00:00.000Z',
            timeSlot: '1970-01-01T01:00:00.000Z',
            url: 'https://example.com/odd',
            events: [
              {
                checkpoint: 4,
                timeDelta: 0,
              },
            ],
          },
          '4--/even': {
            id: 4,
            time: '1970-01-01T01:20:00.000Z',
            timeSlot: '1970-01-01T01:00:00.000Z',
            url: 'https://example.com/even',
            events: [
              {
                checkpoint: 5,
                timeDelta: 1200000,
              },
            ],
          },
          '5--/odd': {
            id: 5,
            time: '1970-01-01T01:40:00.000Z',
            timeSlot: '1970-01-01T01:00:00.000Z',
            url: 'https://example.com/odd',
            events: [
              {
                checkpoint: 6,
                timeDelta: 2400000,
              },
            ],
          },
        },
      });

      // last bundle has the constid events
      assert.deepStrictEqual(apex.bundle[2], {
        bundles: {
          'constid--/': {
            id: 'constid',
            time: '1970-01-01T02:00:00.000Z',
            timeSlot: '1970-01-01T02:00:00.000Z',
            url: 'https://example.com/',
            events: [
              {
                checkpoint: 7,
                timeDelta: 0,
              },
              {
                checkpoint: 8,
                timeDelta: 1200000,
              },
              {
                checkpoint: 9,
                timeDelta: 2400000,
              },
            ],
          },
        },
      });
    });

    describe('should bundle events to virtual destinations', () => {
      let ogRandom;
      beforeEach(() => {
        ogRandom = Math.random;
      });
      afterEach(() => {
        Math.random = ogRandom;
      });

      it('sidekick events are grouped to sidekick.aem.live', async () => {
        const logFileList = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-logs-single.xml'), 'utf-8');
        const mockEventResponseBody = makeEventFile({
          id: 'foo',
          checkpoint: 'sidekick:loaded',
          url: 'https://test.example',
          time: 1337,
        });
        const bodies = {
          apex: {},
          virtual: {},
        };

        nock('https://helix-rum-logs.s3.us-east-1.amazonaws.com')
          // logs not locked
          .head('/.lock')
          .reply(404)
          // lock logs
          .put('/.lock?x-id=PutObject')
          .reply(200)
          // list logs
          .get('/?list-type=2&max-keys=100&prefix=raw%2F')
          .reply(200, logFileList)
          // get log file contents
          .get('/raw/2024-01-01T00_00_00.000-1.log?x-id=GetObject')
          .reply(200, mockEventResponseBody)
          // move log file to processed
          .put('/processed/2024-01-01T00_00_00.000-1.log?x-id=CopyObject')
          .reply(200, '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>2024-01-01T00:00:01.000Z</LastModified><ETag>"2"</ETag></CopyObjectResult>')
          .delete('/raw/2024-01-01T00_00_00.000-1.log?x-id=DeleteObject')
          .reply(200)
          // unlock
          .delete('/.lock?x-id=DeleteObject')
          .reply(200);

        // domain bundling
        nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
          // check if domain exists (yes)
          .head('/test.example/.domainkey')
          .reply(200)
          // get manifest
          .get('/test.example/1970/1/1/.manifest.json?x-id=GetObject')
          .reply(404)
          // get yesterday's manifest
          .get('/test.example/1969/12/31/.manifest.json?x-id=GetObject')
          .reply(404)
          // instantiate bundlegroup
          .get('/test.example/1970/1/1/0.json?x-id=GetObject')
          .reply(404)
          // store manifest
          .put('/test.example/1970/1/1/.manifest.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.apex.manifest = body;
            return [200];
          })
          // store bundlegroup
          .put('/test.example/1970/1/1/0.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.apex.bundle = body;
            return [200];
          });

        // virtual domain bundling
        nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
          // get manifest
          .get('/sidekick.aem.live/1970/1/1/.manifest.json?x-id=GetObject')
          .reply(404)
          // get yesterday's manifest
          .get('/sidekick.aem.live/1969/12/31/.manifest.json?x-id=GetObject')
          .reply(404)
          // instantiate bundlegroup
          .get('/sidekick.aem.live/1970/1/1/0.json?x-id=GetObject')
          .reply(404)
          // store manifest
          .put('/sidekick.aem.live/1970/1/1/.manifest.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.virtual.manifest = body;
            return [200];
          })
          // store bundlegroup
          .put('/sidekick.aem.live/1970/1/1/0.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.virtual.bundle = body;
            return [200];
          });
        const ctx = DEFAULT_CONTEXT();
        await bundleRUM(ctx);

        assert.deepStrictEqual(bodies.apex.manifest, {
          sessions: {
            'foo--/': {
              hour: 0,
            },
          },
        });
        assert.deepStrictEqual(bodies.apex.bundle, {
          bundles: {
            'foo--/': {
              id: 'foo',
              time: '1970-01-01T00:00:01.337Z',
              timeSlot: '1970-01-01T00:00:00.000Z',
              url: 'https://test.example/',
              events: [
                {
                  checkpoint: 'sidekick:loaded',
                  timeDelta: 1337,
                },
              ],
            },
          },
        });

        assert.deepStrictEqual(bodies.virtual.manifest, {
          sessions: {
            'foo--test.example--/': {
              hour: 0,
            },
          },
        });
        assert.deepStrictEqual(bodies.virtual.bundle, {
          bundles: {
            'foo--test.example--/': {
              id: 'foo',
              time: '1970-01-01T00:00:01.337Z',
              timeSlot: '1970-01-01T00:00:00.000Z',
              url: 'https://test.example/',
              events: [
                {
                  checkpoint: 'sidekick:loaded',
                  timeDelta: 1337,
                },
              ],
            },
          },
        });
      });

      it.only('~1% of top events should be grouped to all.virtual.aem.live', async () => {
        const vals = [
          /** example.one doesn't hit threshold, excluded */
          1,
          /** example.two does hit threshold, included */
          0.001,
        ];
        Math.random = () => vals.shift();
        const logFileList = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-logs-single.xml'), 'utf-8');
        const mockEventResponseBody = makeEventFile({
          id: 'foo',
          checkpoint: 'top',
          url: 'https://test.one/1',
          time: 1337,
          weight: 100,
        }, {
          id: 'bar',
          checkpoint: 'top',
          url: 'https://test.two/2',
          time: 1338,
          weight: 100,
        });
        const bodies = {
          one: {},
          two: {},
          virtual: {},
        };

        nock('https://helix-rum-logs.s3.us-east-1.amazonaws.com')
          // logs not locked
          .head('/.lock')
          .reply(404)
          // lock logs
          .put('/.lock?x-id=PutObject')
          .reply(200)
          // list logs
          .get('/?list-type=2&max-keys=100&prefix=raw%2F')
          .reply(200, logFileList)
          // get log file contents
          .get('/raw/2024-01-01T00_00_00.000-1.log?x-id=GetObject')
          .reply(200, mockEventResponseBody)
          // move log file to processed
          .put('/processed/2024-01-01T00_00_00.000-1.log?x-id=CopyObject')
          .reply(200, '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>2024-01-01T00:00:01.000Z</LastModified><ETag>"2"</ETag></CopyObjectResult>')
          .delete('/raw/2024-01-01T00_00_00.000-1.log?x-id=DeleteObject')
          .reply(200)
          // unlock
          .delete('/.lock?x-id=DeleteObject')
          .reply(200);

        // domain bundling
        nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
          // check if domain exists (yes)
          .head('/test.one/.domainkey')
          .reply(200)
          .head('/test.two/.domainkey')
          .reply(200)
          // get manifest
          .get('/test.one/1970/1/1/.manifest.json?x-id=GetObject')
          .reply(404)
          .get('/test.two/1970/1/1/.manifest.json?x-id=GetObject')
          .reply(404)
          // get yesterday's manifest
          .get('/test.one/1969/12/31/.manifest.json?x-id=GetObject')
          .reply(404)
          .get('/test.two/1969/12/31/.manifest.json?x-id=GetObject')
          .reply(404)
          // instantiate bundlegroup
          .get('/test.one/1970/1/1/0.json?x-id=GetObject')
          .reply(404)
          .get('/test.two/1970/1/1/0.json?x-id=GetObject')
          .reply(404)
          // store manifest (one)
          .put('/test.one/1970/1/1/.manifest.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.one.manifest = body;
            return [200];
          })
          // store manifest (two)
          .put('/test.two/1970/1/1/.manifest.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.two.manifest = body;
            return [200];
          })
          // store bundlegroup (one)
          .put('/test.one/1970/1/1/0.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.one.bundle = body;
            return [200];
          })
          // store bundlegroup (two)
          .put('/test.two/1970/1/1/0.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.two.bundle = body;
            return [200];
          });

        // virtual domain bundling
        nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
          // get manifest
          .get('/all.virtual.aem.live/1970/1/1/.manifest.json?x-id=GetObject')
          .reply(404)
          // get yesterday's manifest
          .get('/all.virtual.aem.live/1969/12/31/.manifest.json?x-id=GetObject')
          .reply(404)
          // instantiate bundlegroup
          .get('/all.virtual.aem.live/1970/1/1/0.json?x-id=GetObject')
          .reply(404)
          // store manifest
          .put('/all.virtual.aem.live/1970/1/1/.manifest.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.virtual.manifest = body;
            return [200];
          })
          // store bundlegroup
          .put('/all.virtual.aem.live/1970/1/1/0.json?x-id=PutObject')
          .reply((_, body) => {
            bodies.virtual.bundle = body;
            return [200];
          });
        const ctx = DEFAULT_CONTEXT();
        await bundleRUM(ctx);

        assert.deepStrictEqual(bodies.one.manifest, {
          sessions: {
            'foo--/1': {
              hour: 0,
            },
          },
        });
        assert.deepStrictEqual(bodies.one.bundle, {
          bundles: {
            'foo--/1': {
              id: 'foo',
              time: '1970-01-01T00:00:01.337Z',
              timeSlot: '1970-01-01T00:00:00.000Z',
              url: 'https://test.one/1',
              weight: 100,
              events: [
                {
                  checkpoint: 'top',
                  timeDelta: 1337,
                },
              ],
            },
          },
        });

        assert.deepStrictEqual(bodies.two.manifest, {
          sessions: {
            'bar--/2': {
              hour: 0,
            },
          },
        });
        assert.deepStrictEqual(bodies.two.bundle, {
          bundles: {
            'bar--/2': {
              id: 'bar',
              time: '1970-01-01T00:00:01.338Z',
              timeSlot: '1970-01-01T00:00:00.000Z',
              url: 'https://test.two/2',
              weight: 100,
              events: [
                {
                  checkpoint: 'top',
                  timeDelta: 1338,
                },
              ],
            },
          },
        });

        assert.deepStrictEqual(bodies.virtual.manifest, {
          sessions: {
            'bar--test.two--/2': {
              hour: 0,
            },
          },
        });
        assert.deepStrictEqual(bodies.virtual.bundle, {
          bundles: {
            'bar--test.two--/2': {
              id: 'bar',
              time: '1970-01-01T00:00:01.338Z',
              timeSlot: '1970-01-01T00:00:00.000Z',
              url: 'https://test.two/2',
              weight: 10000,
              events: [
                {
                  checkpoint: 'top',
                  timeDelta: 1338,
                },
              ],
            },
          },
        });
      });
    });
  });
});
