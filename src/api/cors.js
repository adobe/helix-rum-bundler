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
import { Response, fetch } from '@adobe/fetch';
import { PathInfo } from '../support/PathInfo.js';
import { assertAuthorized } from './bundles.js';
/**
 * Handle /bundles route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  if (req.method === 'OPTIONS') {
    return new Response('', {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers': 'Authorization, content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  const info = PathInfo.fromContext(ctx);
  // only allow CORS requests to authorized domains
  await assertAuthorized(ctx, info.domain);

  const url = new URL(`https://${info.domain}/${info.subroute}`);
  try {
    const beresp = await fetch(url.href, {
      headers: {
        'user-agent': req.headers.get('user-agent'),
      },
      method: 'GET',
    });
    if (!beresp.ok) {
      return new Response('Error fetching URL', {
        status: 503,
        headers: {
          'content-type': 'text/plain',
          'x-error': beresp.statusText,
        },
      });
    }
    // only allow HTML and JSON responses
    const contentType = beresp.headers.get('content-type');
    if (!contentType || (!contentType.includes('application/json') && !contentType.includes('text/html'))) {
      return new Response('Invalid content-type', {
        status: 400,
        headers: {
          'content-type': 'text/plain',
          'x-error': 'Invalid content-type',
        },
      });
    }
    const body = await beresp.text();
    // copy headers
    const headers = Array.from(beresp.headers.entries())
      .filter(([key]) => key !== 'length')
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': 'x-error',
      });
    return new Response(body, {
      status: beresp.status,
      headers,
    });
  } catch (e) {
    return new Response('Error fetching URL', {
      status: 503,
      headers: {
        'content-type': 'text/plain',
        'x-error': e.message,
      },
    });
  }
}
