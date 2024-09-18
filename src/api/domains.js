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
import { assertSuperuserAuthorized, isSuperuserAuthorized } from '../support/authorization.js';
import { findTopDomains, listDomains } from '../support/domains.js';
import { HelixStorage } from '../support/storage.js';
import { retrieveOrg } from '../support/orgs.js';

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
 * Get a non-paginated list of domains for use in a datalist.
 *  For superuser: get top N domains last 7 days
 *  For adminkey (w/ `domainkey:read`): get top N domains last 7 days
 *  For orgkey: get all org domains
 *
 * Stores the top N in `<users-bucket>/domains/suggestions/top{N}.json`
 *
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function getDomainSuggestions(req, ctx) {
  const token = req.headers.get('authorization')?.slice(7); // bearer
  const { usersBucket } = HelixStorage.fromContext(ctx);
  const { top = '100' } = ctx.data;
  const topNum = parseInt(top, 10);
  if (Number.isNaN(topNum) || topNum <= 0) {
    return new Response('invalid top value', { status: 400 });
  }

  /** @type {string[]} */
  let domains;
  if (isSuperuserAuthorized(req, ctx)) {
    // check the top file
    const topFile = await usersBucket.get(`/domains/suggestions/top${topNum}.json`);
    if (topFile) {
      domains = JSON.parse(new TextDecoder('utf8').decode(topFile));
    } else {
    // determine top 100 domains from last week
      domains = await findTopDomains(ctx, 7, topNum);

      // store them for future requests with 24h expiry
      await usersBucket.put(
        `/domains/suggestions/top${topNum}.json`,
        JSON.stringify(domains),
        'application/json',
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      );
    }
  } else if (token.startsWith('org:')) {
    const org = await retrieveOrg(ctx, token.split(':')[1]);
    domains = org.domains;
  } else {
    domains = [];
  }

  // convert to html if preferred by client
  const acceptVal = req.headers.get('accept') ?? '';
  if (acceptVal.indexOf('text/html') > acceptVal.indexOf('application/json')) {
    return new Response(`\
<datalist id="rum-domain-suggestions">
${domains.map((d) => `  <option value="${d}">`).join('\n')}
</datalist>`, {
      status: 200,
      headers: {
        'content-type': 'text/html',
      },
    });
  }

  return new Response(JSON.stringify({ domains }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
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

  if (req.method === 'GET') {
    if (ctx.data.suggested) {
      return getDomainSuggestions(req, ctx);
    }

    assertSuperuserAuthorized(req, ctx);
    return getDomains(ctx);
  }
  return new Response('method not allowed', { status: 405 });
}
