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
import { fileURLToPath } from 'url';
import assert from 'assert';
import fs from 'fs/promises';
import zlib from 'zlib';
import { promisify } from 'util';
import { DEFAULT_CONTEXT, mockDate, Nock } from '../util.js';
import processCloudflareEvents, { adaptCloudflareEvent } from '../../src/tasks/cloudflare.js';

const gunzip = promisify(zlib.gunzip);

// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const makeEventFile = (...events) => events.map((e) => JSON.stringify(e)).join('\n');

const toCloudflareEntry = (ev) => ({
  ScriptName: 'helix3--helix-rum-collector-prod',
  Logs: [
    { Level: 'log', Message: ['checking for cloudflare environment'], TimestampMs: 1715356661500 },
    { Level: 'log', Message: ['logging to Console.'], TimestampMs: 1715356661501 },
    { Level: 'log', Message: [JSON.stringify(ev)], TimestampMs: 1715356661501 },
  ],
});

const mockEventLogFile = (domain, type = 'aws') => {
  let events = [
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
  if (type === 'cloudflare') {
    events = events.map(toCloudflareEntry);
  }
  return makeEventFile(...events);
};

describe('cloudflare tests', () => {
  describe('processCloudflareEvents()', () => {
    /** @type {import('../util.js').Nocker} */
    let nock;
    let ogUUID;
    beforeEach(() => {
      nock = new Nock().env();
      ogUUID = crypto.randomUUID;
      crypto.randomUUID = () => 'test-new-key';
      mockDate();
    });
    afterEach(() => {
      crypto.randomUUID = ogUUID;
      nock.done();
      global.Date.reset();
    });

    it('should move events to default log bucket', async () => {
      const logsBody = await fs.readFile(path.resolve(__dirname, 'fixtures', 'cloudflare-list-logs-single.xml'), 'utf-8');
      const mockEventResponseBody = mockEventLogFile('example.com', 'cloudflare');
      const bodies = {
        put: undefined,
      };

      nock('https://helix-rum-logs-cloudflare.s3.us-east-1.amazonaws.com')
        // logs not locked
        .head('/.lock')
        .reply(404)
        // locks logs
        .put('/.lock?x-id=PutObject')
        .reply(200)
        // list logs
        .get('/?list-type=2&max-keys=100&prefix=raw%2F')
        .reply(200, logsBody)
        // get log file contents
        .get('/raw/20240101/20240101T000000.000-1.log?x-id=GetObject')
        .reply(200, mockEventResponseBody)
        // delete log file
        .delete('/raw/20240101/20240101T000000.000-1.log?x-id=DeleteObject')
        .reply(204)
        // delete lock
        .delete('/.lock?x-id=DeleteObject')
        .reply(204);

      nock('https://helix-rum-logs.s3.us-east-1.amazonaws.com')
        .put('/raw/2024-01-01T00%3A00%3A00.000-1.log?x-id=PutObject')
        .reply(200, async (_, body) => {
          bodies.put = body;
          return [200];
        });

      await processCloudflareEvents(DEFAULT_CONTEXT());
      const tranformed = (await gunzip(Buffer.from(bodies.put, 'hex'))).toString('utf-8');
      assert.strictEqual(tranformed, `{"id":0,"url":"https://sub.example.com","time":0,"checkpoint":0}
{"id":0,"url":"https://example.com/even","time":0,"checkpoint":1}
{"id":1,"url":"https://example.com/odd","time":1200000,"checkpoint":2}
{"id":2,"url":"https://example.com/even","time":2400000,"checkpoint":3}
{"id":3,"url":"https://example.com/odd","time":3600000,"checkpoint":4}
{"id":4,"url":"https://example.com/even","time":4800000,"checkpoint":5}
{"id":5,"url":"https://example.com/odd","time":6000000,"checkpoint":6}
{"id":"constid","url":"https://example.com","time":7200000,"checkpoint":7}
{"id":"constid","url":"https://example.com","time":8400000,"checkpoint":8}
{"id":"constid","url":"https://example.com","time":9600000,"checkpoint":9}`);
    });
  });

  describe.only('adaptCloudflareEvent()', () => {
    it('ignores missing JSON message', () => {
      const adapted = adaptCloudflareEvent(DEFAULT_CONTEXT(), { Logs: [{ Message: ['not json'] }] });
      assert.deepStrictEqual(adapted, null);
    });

    it('ignores events without required properties', () => {
      const adapted = adaptCloudflareEvent(DEFAULT_CONTEXT(), { Logs: [{ Message: ['{"checkpoint":"foo","id":null}'] }] });
      assert.deepStrictEqual(adapted, null);
    });

    it('ignores broken JSON message', () => {
      const adapted = adaptCloudflareEvent(DEFAULT_CONTEXT(), { Logs: [{ Message: ['{"checkpoint":"foo"'] }] });
      assert.deepStrictEqual(adapted, null);
    });

    it('ignores JSON message missing checkpoint', () => {
      const adapted = adaptCloudflareEvent(DEFAULT_CONTEXT(), { Logs: [{ Message: ['{"id":"bar"}'] }] });
      assert.deepStrictEqual(adapted, null);
    });

    it('ignores truncated JSON message', () => {
      const adapted = adaptCloudflareEvent(DEFAULT_CONTEXT(), { Logs: [{ Message: ['{"checkpoint":"foo","id":"bar","target":"someth<<<Logpush: message truncated>>>ing"}'] }] });
      assert.deepStrictEqual(adapted, null);
    });
  });
});
