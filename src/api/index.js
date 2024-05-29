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
import domainkey from './domainkey.js';
import bundles from './bundles.js';
import orgs from './orgs.js';
import { errorWithResponse } from '../support/util.js';
import { PathInfo } from '../support/PathInfo.js';

const handlers = {
  domainkey,
  bundles,
  orgs,
};

/**
 * Respond to HTTP request
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  const info = PathInfo.fromContext(ctx);
  const handler = handlers[info.route];
  /* c8 ignore next 3 */
  if (!handler) {
    throw errorWithResponse(404, 'not found');
  }
  if (req.method === 'OPTIONS') {
    return new Response('', {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET, POST, PUT, OPTIONS, DELETE',
        'access-control-allow-headers': 'Authorization, content-type',
        'access-control-max-age': '86400',
      },
    });
  }

  return handler(req, ctx);
}
