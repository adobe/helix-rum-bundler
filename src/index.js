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
import secrets from '@adobe/helix-shared-secrets';
import { helixStatus } from '@adobe/helix-status';
import { Response } from '@adobe/fetch';
import bundleRUM from './bundler/index.js';
import handleRequest from './api/index.js';

/**
 * Perform bundling process if any:
 * 1. invoked by scheduler event
 * 2. bundle param set & running locally
 * 3. bundle param set & x-bundler-authorization is allowed
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {boolean}
 */
function shouldBundleRUM(req, ctx) {
  const { log } = ctx;
  const invokedByEvent = ctx.invocation?.event?.source === 'aws.scheduler';

  if (invokedByEvent) {
    log.debug('invoked by scheduler, performing bundling');
    return true;
  }
  if (!ctx.data.bundle) {
    return false;
  }

  const isDevMode = ctx.runtime?.name === 'simulate';
  if (isDevMode) {
    return true;
  }

  const invokeAllowed = ctx.env.INVOKE_BUNDLER_KEY && req.headers.get('x-bundler-authorization') === ctx.env.INVOKE_BUNDLER_KEY;
  /* c8 ignore next */
  log.debug(`invoked manually, ${invokeAllowed ? '' : 'not'} performing bundling`);
  return invokeAllowed;
}

/**
 * @param {RRequest} request
 * @param {UniversalContext} context
 * @returns {Promise<RResponse>}
 */
async function run(request, context) {
  const { log } = context;
  context.attributes.stats = {};
  context.attributes.start = new Date();

  let resp;
  try {
    if (shouldBundleRUM(request, context)) {
      resp = await bundleRUM(context);
    } else {
      resp = await handleRequest(request, context);
    }
  } catch (e) {
    if (e?.response) {
      resp = e.response;
      if (e.message) {
        log.info(e.message);
      }
    } else {
      log.error(e);
      resp = new Response('Internal Server Error', {
        status: 500,
        headers: {
          'x-error': e.message,
        },
      });
    }
  }

  return resp;
}

/**
 * Wrapper to add common Response headers
 * @param {(...args: any[])  => Promise<RResponse>} fn
 * @returns {(req: RRequest, ctx: UniversalContext) => Promise<RResponse>}
 */
function addCommonResponseHeadersWrapper(fn) {
  return async (req, context) => {
    const res = await fn(req, context);
    if (!res.headers.has('cache-control')) {
      res.headers.set('cache-control', 'no-store, private, must-revalidate');
    }

    res.headers.set('access-control-allow-origin', '*');
    res.headers.set('access-control-allow-credentials', 'true');
    res.headers.set('access-control-expose-headers', 'x-error');
    return res;
  };
}

/** @type {(...args: any[]) => Promise<RResponse>} */
export const main = wrap(run)
  .with(addCommonResponseHeadersWrapper)
  .with(bodyData)
  .with(secrets)
  .with(helixStatus);
