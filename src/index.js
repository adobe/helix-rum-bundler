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
import wrap from '@adobe/helix-shared-wrap';
import bodyData from '@adobe/helix-shared-body-data';
import { logger } from '@adobe/helix-universal-logger';
import { helixStatus } from '@adobe/helix-status';
import { Response } from '@adobe/fetch';

/**
 * @param {import('@adobe/fetch').Request} request
 * @param {import('@adobe/helix-universal').Helix.UniversalContext} context
 * @returns {Response} a response
 */
async function run(request, context) {
  // if triggered by EventBridge, perform bundling

  return new Response('hello world');
}

export const main = wrap(run)
  .with(helixStatus)
  .with(logger.trace)
  .with(logger)
  .with(bodyData);
