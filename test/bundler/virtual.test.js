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
    Math.random = () => 1; // always skip the random all bundle
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

  it('~1% of top & cwv events should be grouped to "aem.live:all" virtual domain', async () => {
    Math.random = () => 1; // always skip the random all bundle
    const logFileList = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-logs-single.xml'), 'utf-8');
    const mockEventResponseBody = makeEventFile({
      id: 'included204',
      checkpoint: 'top',
      url: 'https://test.one/1',
      time: 1337,
      weight: 100,
    }, {
      id: 'included204',
      checkpoint: 'cwv',
      LCP: 1,
      url: 'https://test.one/1',
      time: 1337,
      weight: 100,
    }, {
      id: 'included204',
      checkpoint: 'foo',
      url: 'https://test.one/1',
      time: 1337,
      weight: 100,
    }, {
      id: 'excluded',
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
      .get('/aem.live%3Aall/1970/1/1/.manifest.json?x-id=GetObject')
      .reply(404)
      // get yesterday's manifest
      .get('/aem.live%3Aall/1969/12/31/.manifest.json?x-id=GetObject')
      .reply(404)
      // instantiate bundlegroup
      .get('/aem.live%3Aall/1970/1/1/0.json?x-id=GetObject')
      .reply(404)
      // store manifest
      .put('/aem.live%3Aall/1970/1/1/.manifest.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.virtual.manifest = body;
        return [200];
      })
      // store bundlegroup
      .put('/aem.live%3Aall/1970/1/1/0.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.virtual.bundle = body;
        return [200];
      });
    const ctx = DEFAULT_CONTEXT();
    await bundleRUM(ctx);

    assert.deepStrictEqual(bodies.one.manifest, {
      sessions: {
        'included204--/1': {
          hour: 0,
        },
      },
    });
    assert.deepStrictEqual(bodies.one.bundle, {
      bundles: {
        'included204--/1': {
          id: 'included204',
          time: '1970-01-01T00:00:01.337Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://test.one/1',
          weight: 100,
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1337,
            },
            {
              checkpoint: 'cwv-lcp',
              timeDelta: 1337,
              value: 1,
            },
            {
              checkpoint: 'foo',
              timeDelta: 1337,
            },
          ],
        },
      },
    });

    assert.deepStrictEqual(bodies.two.manifest, {
      sessions: {
        'excluded--/2': {
          hour: 0,
        },
      },
    });
    assert.deepStrictEqual(bodies.two.bundle, {
      bundles: {
        'excluded--/2': {
          id: 'excluded',
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
        'included204--test.one--/1': {
          hour: 0,
        },
      },
    });
    assert.deepStrictEqual(bodies.virtual.bundle, {
      bundles: {
        'included204--test.one--/1': {
          id: 'included204',
          time: '1970-01-01T00:00:01.337Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://test.one/1',
          weight: 10000,
          domain: 'test.one',
          hostType: 'helix',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1337,
            },
            {
              checkpoint: 'cwv-lcp',
              value: 1,
              timeDelta: 1337,
            },
          ],
        },
      },
    });
  });

  it('(hlx|aem).(page|live) should be bundled to org/site virtual', async () => {
    Math.random = () => 1; // always skip the random all bundle
    const logFileList = await fs.readFile(path.resolve(__dirname, 'fixtures', 'list-logs-single.xml'), 'utf-8');
    const mockEventResponseBody = makeEventFile({
      id: 'hlxpage',
      checkpoint: 'top',
      url: 'https://main--helix-website--adobe.hlx.page/1',
      time: 1337,
      weight: 100,
    }, {
      id: 'hlxlive',
      checkpoint: 'top',
      url: 'https://foo--helix-website--adobe.hlx.live/2',
      time: 1338,
      weight: 100,
    }, {
      id: 'aempage',
      checkpoint: 'top',
      url: 'https://bar--helix-website--adobe.aem.page/3',
      time: 1339,
      weight: 100,
    }, {
      id: 'aemlive',
      checkpoint: 'top',
      url: 'https://qux--helix-website--adobe.aem.live/4',
      time: 1310,
      weight: 100,
    });
    const bodies = {
      hlxpage: {},
      hlxlive: {},
      aempage: {},
      aemlive: {},
      virtual: {
        site: {},
        org: {},
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
      .head('/main--helix-website--adobe.hlx.page/.domainkey')
      .reply(200)
      .head('/foo--helix-website--adobe.hlx.live/.domainkey')
      .reply(200)
      .head('/bar--helix-website--adobe.aem.page/.domainkey')
      .reply(200)
      .head('/qux--helix-website--adobe.aem.live/.domainkey')
      .reply(200)
      // get manifest
      .get('/main--helix-website--adobe.hlx.page/1970/1/1/.manifest.json?x-id=GetObject')
      .reply(404)
      .get('/foo--helix-website--adobe.hlx.live/1970/1/1/.manifest.json?x-id=GetObject')
      .reply(404)
      .get('/bar--helix-website--adobe.aem.page/1970/1/1/.manifest.json?x-id=GetObject')
      .reply(404)
      .get('/qux--helix-website--adobe.aem.live/1970/1/1/.manifest.json?x-id=GetObject')
      .reply(404)
      // get yesterday's manifest
      .get('/main--helix-website--adobe.hlx.page/1969/12/31/.manifest.json?x-id=GetObject')
      .reply(404)
      .get('/foo--helix-website--adobe.hlx.live/1969/12/31/.manifest.json?x-id=GetObject')
      .reply(404)
      .get('/bar--helix-website--adobe.aem.page/1969/12/31/.manifest.json?x-id=GetObject')
      .reply(404)
      .get('/qux--helix-website--adobe.aem.live/1969/12/31/.manifest.json?x-id=GetObject')
      .reply(404)
      // instantiate bundlegroup
      .get('/main--helix-website--adobe.hlx.page/1970/1/1/0.json?x-id=GetObject')
      .reply(404)
      .get('/foo--helix-website--adobe.hlx.live/1970/1/1/0.json?x-id=GetObject')
      .reply(404)
      .get('/bar--helix-website--adobe.aem.page/1970/1/1/0.json?x-id=GetObject')
      .reply(404)
      .get('/qux--helix-website--adobe.aem.live/1970/1/1/0.json?x-id=GetObject')
      .reply(404)

      // store manifest (hlxpage)
      .put('/main--helix-website--adobe.hlx.page/1970/1/1/.manifest.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.hlxpage.manifest = body;
        return [200];
      })
      // store manifest (hlxlive)
      .put('/foo--helix-website--adobe.hlx.live/1970/1/1/.manifest.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.hlxlive.manifest = body;
        return [200];
      })
      // store manifest (aempage)
      .put('/bar--helix-website--adobe.aem.page/1970/1/1/.manifest.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.aempage.manifest = body;
        return [200];
      })
      // store manifest (aemlive)
      .put('/qux--helix-website--adobe.aem.live/1970/1/1/.manifest.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.aemlive.manifest = body;
        return [200];
      })

      // store bundlegroup (hlxpage)
      .put('/main--helix-website--adobe.hlx.page/1970/1/1/0.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.hlxpage.bundle = body;
        return [200];
      })
      // store bundlegroup (hlxlive)
      .put('/foo--helix-website--adobe.hlx.live/1970/1/1/0.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.hlxlive.bundle = body;
        return [200];
      })
      // store bundlegroup (aempage)
      .put('/bar--helix-website--adobe.aem.page/1970/1/1/0.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.aempage.bundle = body;
        return [200];
      })
      // store bundlegroup (aemlive)
      .put('/qux--helix-website--adobe.aem.live/1970/1/1/0.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.aemlive.bundle = body;
        return [200];
      });

    // virtual domain bundling
    nock('https://helix-rum-bundles.s3.us-east-1.amazonaws.com')
      // get manifest (org)
      .get('/adobe--hlxsites.aem.live/1970/1/1/.manifest.json?x-id=GetObject')
      .reply(404)
      // get manifest (site)
      .get('/helix-website--adobe.aem.live/1970/1/1/.manifest.json?x-id=GetObject')
      .reply(404)

      // instantiate bundlegroup (org)
      .get('/adobe--hlxsites.aem.live/1970/1/1/0.json?x-id=GetObject')
      .reply(404)
      // instantiate bundlegroup (site)
      .get('/helix-website--adobe.aem.live/1970/1/1/0.json?x-id=GetObject')
      .reply(404)

      // get yesterday's manifest (org)
      .get('/adobe--hlxsites.aem.live/1969/12/31/.manifest.json?x-id=GetObject')
      .reply(404)
      // get yeterday's manifest (site)
      .get('/helix-website--adobe.aem.live/1969/12/31/.manifest.json?x-id=GetObject')
      .reply(404)

      // store manifest (org)
      .put('/adobe--hlxsites.aem.live/1970/1/1/.manifest.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.virtual.org.manifest = body;
        return [200];
      })
      // store manifest (site)
      .put('/helix-website--adobe.aem.live/1970/1/1/.manifest.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.virtual.site.manifest = body;
        return [200];
      })

      // store bundlegroup (org)
      .put('/adobe--hlxsites.aem.live/1970/1/1/0.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.virtual.org.bundle = body;
        return [200];
      })
      // store bundlegroup (site)
      .put('/helix-website--adobe.aem.live/1970/1/1/0.json?x-id=PutObject')
      .reply((_, body) => {
        bodies.virtual.site.bundle = body;
        return [200];
      });
    const ctx = DEFAULT_CONTEXT();
    await bundleRUM(ctx);

    // manifests
    assert.deepStrictEqual(bodies.hlxpage.manifest, {
      sessions: {
        'hlxpage--/1': {
          hour: 0,
        },
      },
    });
    assert.deepStrictEqual(bodies.hlxlive.manifest, {
      sessions: {
        'hlxlive--/2': {
          hour: 0,
        },
      },
    });
    assert.deepStrictEqual(bodies.aempage.manifest, {
      sessions: {
        'aempage--/3': {
          hour: 0,
        },
      },
    });
    assert.deepStrictEqual(bodies.aemlive.manifest, {
      sessions: {
        'aemlive--/4': {
          hour: 0,
        },
      },
    });

    // bundles
    assert.deepStrictEqual(bodies.hlxpage.bundle, {
      bundles: {
        'hlxpage--/1': {
          id: 'hlxpage',
          time: '1970-01-01T00:00:01.337Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://main--helix-website--adobe.hlx.page/1',
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
    assert.deepStrictEqual(bodies.hlxlive.bundle, {
      bundles: {
        'hlxlive--/2': {
          id: 'hlxlive',
          time: '1970-01-01T00:00:01.338Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://foo--helix-website--adobe.hlx.live/2',
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
    assert.deepStrictEqual(bodies.aempage.bundle, {
      bundles: {
        'aempage--/3': {
          id: 'aempage',
          time: '1970-01-01T00:00:01.339Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://bar--helix-website--adobe.aem.page/3',
          weight: 100,
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1339,
            },
          ],
        },
      },
    });
    assert.deepStrictEqual(bodies.aemlive.bundle, {
      bundles: {
        'aemlive--/4': {
          id: 'aemlive',
          time: '1970-01-01T00:00:01.310Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://qux--helix-website--adobe.aem.live/4',
          weight: 100,
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1310,
            },
          ],
        },
      },
    });

    // virtual manifests
    assert.deepStrictEqual(bodies.virtual.org.manifest, {
      sessions: {
        'hlxpage--main--helix-website--adobe.hlx.page--/1': {
          hour: 0,
        },
        'hlxlive--foo--helix-website--adobe.hlx.live--/2': {
          hour: 0,
        },
        'aempage--bar--helix-website--adobe.aem.page--/3': {
          hour: 0,
        },
        'aemlive--qux--helix-website--adobe.aem.live--/4': {
          hour: 0,
        },
      },
    });
    assert.deepStrictEqual(bodies.virtual.site.manifest, {
      sessions: {
        'hlxpage--main--helix-website--adobe.hlx.page--/1': {
          hour: 0,
        },
        'hlxlive--foo--helix-website--adobe.hlx.live--/2': {
          hour: 0,
        },
        'aempage--bar--helix-website--adobe.aem.page--/3': {
          hour: 0,
        },
        'aemlive--qux--helix-website--adobe.aem.live--/4': {
          hour: 0,
        },
      },
    });

    // virtual bundles
    assert.deepStrictEqual(bodies.virtual.org.bundle, {
      bundles: {
        'hlxpage--main--helix-website--adobe.hlx.page--/1': {
          id: 'hlxpage',
          time: '1970-01-01T00:00:01.337Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://main--helix-website--adobe.hlx.page/1',
          weight: 100,
          domain: 'main--helix-website--adobe.hlx.page',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1337,
            },
          ],
        },
        'hlxlive--foo--helix-website--adobe.hlx.live--/2': {
          id: 'hlxlive',
          time: '1970-01-01T00:00:01.338Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://foo--helix-website--adobe.hlx.live/2',
          weight: 100,
          domain: 'foo--helix-website--adobe.hlx.live',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1338,
            },
          ],
        },
        'aempage--bar--helix-website--adobe.aem.page--/3': {
          id: 'aempage',
          time: '1970-01-01T00:00:01.339Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://bar--helix-website--adobe.aem.page/3',
          weight: 100,
          domain: 'bar--helix-website--adobe.aem.page',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1339,
            },
          ],
        },
        'aemlive--qux--helix-website--adobe.aem.live--/4': {
          id: 'aemlive',
          time: '1970-01-01T00:00:01.310Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://qux--helix-website--adobe.aem.live/4',
          weight: 100,
          domain: 'qux--helix-website--adobe.aem.live',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1310,
            },
          ],
        },
      },
    });
    assert.deepStrictEqual(bodies.virtual.site.bundle, {
      bundles: {
        'hlxpage--main--helix-website--adobe.hlx.page--/1': {
          id: 'hlxpage',
          time: '1970-01-01T00:00:01.337Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://main--helix-website--adobe.hlx.page/1',
          weight: 100,
          domain: 'main--helix-website--adobe.hlx.page',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1337,
            },
          ],
        },
        'hlxlive--foo--helix-website--adobe.hlx.live--/2': {
          id: 'hlxlive',
          time: '1970-01-01T00:00:01.338Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://foo--helix-website--adobe.hlx.live/2',
          weight: 100,
          domain: 'foo--helix-website--adobe.hlx.live',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1338,
            },
          ],
        },
        'aempage--bar--helix-website--adobe.aem.page--/3': {
          id: 'aempage',
          time: '1970-01-01T00:00:01.339Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://bar--helix-website--adobe.aem.page/3',
          weight: 100,
          domain: 'bar--helix-website--adobe.aem.page',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1339,
            },
          ],
        },
        'aemlive--qux--helix-website--adobe.aem.live--/4': {
          id: 'aemlive',
          time: '1970-01-01T00:00:01.310Z',
          timeSlot: '1970-01-01T00:00:00.000Z',
          url: 'https://qux--helix-website--adobe.aem.live/4',
          weight: 100,
          domain: 'qux--helix-website--adobe.aem.live',
          events: [
            {
              checkpoint: 'top',
              timeDelta: 1310,
            },
          ],
        },
      },
    });
  });
});
