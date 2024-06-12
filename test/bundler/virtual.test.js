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

import path from 'path';
import assert from 'assert';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import bundleRUM from '../../src/bundler/index.js';
import { DEFAULT_CONTEXT, Nock } from '../util.js';
import { makeEventFile } from './index.test.js';

// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('should bundle events to virtual destinations', () => {
  /** @type {import('../util.js').Nocker} */
  let nock;
  let ogRandom;
  let ogUUID;
  beforeEach(() => {
    nock = new Nock().env();
    ogUUID = crypto.randomUUID;
    crypto.randomUUID = () => 'test-new-key';
    ogRandom = Math.random;
  });
  afterEach(() => {
    crypto.randomUUID = ogUUID;
    nock.done();
    Math.random = ogRandom;
  });

  async function simpleVirtualCase(virtualDomain, mockEvent, expectedEvents) {
    const logFileList = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-logs-single.xml'), 'utf-8');
    const mockEventResponseBody = makeEventFile(mockEvent);
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
      .post('/?delete=')
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
      .get(`/${virtualDomain}/1970/1/1/.manifest.json?x-id=GetObject`)
      .reply(404)
      // get yesterday's manifest
      .get(`/${virtualDomain}/1969/12/31/.manifest.json?x-id=GetObject`)
      .reply(404)
      // instantiate bundlegroup
      .get(`/${virtualDomain}/1970/1/1/0.json?x-id=GetObject`)
      .reply(404)
      // store manifest
      .put(`/${virtualDomain}/1970/1/1/.manifest.json?x-id=PutObject`)
      .reply((_, body) => {
        bodies.virtual.manifest = body;
        return [200];
      })
      // store bundlegroup
      .put(`/${virtualDomain}/1970/1/1/0.json?x-id=PutObject`)
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
          events: expectedEvents,
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
          domain: 'test.example',
          events: expectedEvents,
        },
      },
    });
  }

  it('sidekick events are grouped to "sidekick" virtual domain', async () => {
    const event = {
      id: 'foo',
      checkpoint: 'sidekick:loaded',
      url: 'https://test.example',
      time: 1337,
    };
    const expectedEvents = [{
      checkpoint: 'sidekick:loaded',
      timeDelta: 1337,
    }];

    await simpleVirtualCase('sidekick', event, expectedEvents);
  });

  it('sidekick library events are grouped to "sidekick.library" virtual domain', async () => {
    const event = {
      id: 'foo',
      checkpoint: 'library:opened',
      url: 'https://test.example',
      time: 1337,
    };
    const expectedEvents = [{
      checkpoint: 'library:opened',
      timeDelta: 1337,
    }];

    await simpleVirtualCase('sidekick.library', event, expectedEvents);
  });

  it('crosswalk events are grouped to "crosswalk" virtual domain', async () => {
    const event = {
      id: 'foo',
      checkpoint: 'crosswalk:loaded',
      url: 'https://test.example',
      time: 1337,
    };
    const expectedEvents = [{
      checkpoint: 'crosswalk:loaded',
      timeDelta: 1337,
    }];

    await simpleVirtualCase('crosswalk', event, expectedEvents);
  });

  it('~1% of top events should be grouped to "all" virtual domain', async () => {
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
      .post('/?delete=')
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
      .get('/all/1970/1/1/.manifest.json?x-id=GetObject')
      .reply(404)
      // get yesterday's manifest
      .get('/all/1969/12/31/.manifest.json?x-id=GetObject')
      .reply(404)
      // instantiate bundlegroup
      .get('/all/1970/1/1/0.json?x-id=GetObject')
      .reply(404)
      // store manifest
      .put('/all/1970/1/1/.manifest.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.virtual.manifest = body;
        return [200];
      })
      // store bundlegroup
      .put('/all/1970/1/1/0.json?x-id=PutObject')
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
          domain: 'test.two',
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
