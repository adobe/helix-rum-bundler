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
import { assertRejectsWithResponse } from '../util.js';
import { PathInfo } from '../../src/support/PathInfo.js';
import { pruneUndefined } from '../../src/support/util.js';

describe('support/PathInfo tests', () => {
  it('should throw 404 response on invalid paths', async () => {
    await assertRejectsWithResponse(async () => new PathInfo(''), 404);
    await assertRejectsWithResponse(async () => new PathInfo('/bundles/domain/notanumber'), 404);
  });

  it('parses paths', () => {
    // with hour
    let parsed = new PathInfo('/bundles/domain/2024/01/01/0.json');
    assert.strictEqual(parsed.toString(), '/domain/2024/1/1/0');
    assert.deepStrictEqual(pruneUndefined({
      ...parsed,
      toString: undefined,
      segments: undefined,
    }), {
      route: 'bundles',
      domain: 'domain',
      year: 2024,
      month: 1,
      day: 1,
      hour: 0,
    });

    const parsedNoJson = new PathInfo('/bundles/domain/2024/01/01/0');
    assert.deepStrictEqual(
      { ...parsed, toString: undefined },
      { ...parsedNoJson, toString: undefined },
    );

    // with day
    parsed = new PathInfo('/bundles/domain/2024/3/4.json');
    assert.strictEqual(parsed.toString(), '/domain/2024/3/4');
    assert.deepStrictEqual(pruneUndefined({
      ...parsed,
      toString: undefined,
      segments: undefined,
    }), {
      route: 'bundles',
      domain: 'domain',
      year: 2024,
      month: 3,
      day: 4,
    });

    // with month
    parsed = new PathInfo('/bundles/domain/2024/12.json');
    assert.strictEqual(parsed.toString(), '/domain/2024/12');
    assert.deepStrictEqual(pruneUndefined({
      ...parsed,
      toString: undefined,
      segments: undefined,
    }), {
      route: 'bundles',
      domain: 'domain',
      year: 2024,
      month: 12,
    });

    // with year
    parsed = new PathInfo('/bundles/domain/2024.json');
    assert.strictEqual(parsed.toString(), '/domain/2024');
    assert.deepStrictEqual(pruneUndefined({
      ...parsed,
      toString: undefined,
      segments: undefined,
    }), {
      route: 'bundles',
      domain: 'domain',
      year: 2024,
    });
  });
});
