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

import { execute } from './sendquery.js';
// import { cleanRequestParams } from './util.js';

const DEFAULT_LIMIT = 1_000_000;

/**
 * Execute run-query rum-bundle query
 * @param {UniversalContext} ctx
 * @param {string} domain
 * @param {string} domainKey
 * @param {string} date
 * @param {number} [limit]
 * @param {string} [after]
 * @returns {Promise<{results: any[]; truncated: boolean;}>}
 */
export default async function executeBundleQuery(ctx, domain, domainKey, date, limit, after) {
  const {
    results,
    truncated,
    // headers,
    // description,
    // requestParams,
    // responseDetails,
    // responseMetadata,
  } = await execute(
    ctx,
    process.env.GOOGLE_CLIENT_EMAIL,
    process.env.GOOGLE_PRIVATE_KEY,
    process.env.GOOGLE_PROJECT_ID,
    'rum-bundles',
    {
      url: domain,
      domainkey: domainKey,
      startdate: date,
      limit: limit || DEFAULT_LIMIT,
      ...(after ? { after } : {}),
    },
  );
  return {
    results,
    truncated,
  };
}
