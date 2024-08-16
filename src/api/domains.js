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

import { Response } from '@adobe/fetch';
import { PathInfo } from '../support/PathInfo.js';
import { assertSuperuserAuthorized } from '../support/authorization.js';
import { listDomains } from '../support/domains.js';

/**
 * Get list of domains.
 *
 * @param {UniversalContext} ctx
 */
async function getDomains(ctx) {
  const { limit, start } = ctx.data;
  const data = await listDomains(ctx, start, limit);
  return new Response(JSON.stringify(data), { status: 200 });
}

/**
 * Handle /domains route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  // eslint-disable-next-line no-new
  new PathInfo(ctx.pathInfo.suffix);
  assertSuperuserAuthorized(req, ctx);

  if (req.method === 'GET') {
    return getDomains(ctx);
  }
  return new Response('method not allowed', { status: 405 });
}
