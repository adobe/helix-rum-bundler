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
/// <reference path="../types.d.ts" />
// @ts-check

import { Response } from '@adobe/fetch';
import domainkey from './domainkey.js';
import bundles from './bundles.js';
import { errorWithResponse } from '../util.js';

const handlers = {
  domainkey,
  bundles,
};

/**
 * Respond to HTTP request
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  const route = ctx.pathInfo.suffix.split('/')[1];
  const handler = handlers[route];
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
