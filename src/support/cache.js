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

import { getFetch } from '../util.js';

/**
 * Purge Fastly cache by surrogate key
 * @param {UniversalContext} ctx
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function purgeSurrogateKey(ctx, key) {
  const { FASTLY_API_KEY, FASTLY_SERVICE_ID } = ctx.env;
  const fetch = getFetch(ctx);
  const resp = await fetch(`https://api.fastly.com/service/${FASTLY_SERVICE_ID}/purge/${key}`, {
    headers: {
      'Fastly-Key': FASTLY_API_KEY,
    },
  });
  if (!resp.ok) {
    ctx.log.warn(`Failed to purge Fastly cache for key ${key}: ${resp.status}`);
  }
}
