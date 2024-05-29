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

import { DEFAULT_CONTEXT, assertRejectsWithResponse } from '../util.js';
import { assertSuperuserAuthorized } from '../../src/support/authorization.js';

describe('support/authorization tests', () => {
  describe('assertSuperuserAuthorized()', () => {
    it('should throw 403 response on invalid auth', async () => {
      const req = new Request('https://example.com', { headers: { authorization: 'bearer badkey' } });
      const ctx = DEFAULT_CONTEXT({ env: { TMP_SUPERUSER_API_KEY: 'goodkey' } });
      await assertRejectsWithResponse(async () => assertSuperuserAuthorized(req, ctx), 403, 'invalid auth');
    });
  });
});
