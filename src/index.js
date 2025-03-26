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
import processCloudflareEvents from './cloudflare.js';

const EVENT_HANDLERS = {
  'bundle-rum': bundleRUM,
  'process-cloudflare-events': processCloudflareEvents,
};

/**
 * Check if the invocation is done by scheduler event
 * @param {UniversalContext} ctx
 * @returns {boolean}
 */
function wasInvokedByEvent(ctx) {
  const event = ctx.invocation?.event;
  return event?.source === 'aws.scheduler';
}

/**
 * Perform handler process if any:
 * 1. invoked by scheduler event & `task` is known
 * 2. `task` param set & running locally
 * 3. `task` param set & x-bundler-authorization is allowed
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {boolean}
 */
function shouldRunEventHandler(req, ctx) {
  const { log } = ctx;
  const event = ctx.invocation?.event;
  const invokedByEvent = wasInvokedByEvent(ctx);

  if (invokedByEvent && EVENT_HANDLERS[event?.task]) {
    return true;
  }

  /* c8 ignore next 10 */
  if (!ctx.data.task || !EVENT_HANDLERS[ctx.data.task]) {
    return false;
  }
  const isDevMode = ctx.runtime?.name === 'simulate';
  if (isDevMode) {
    // simulate task if needed
    // @ts-ignore
    ctx.invocation.event.task = ctx.invocation.event.task || ctx.data.task;
    return true;
  }

  const invokeAllowed = ctx.env.INVOKE_BUNDLER_KEY && req.headers.get('x-bundler-authorization') === ctx.env.INVOKE_BUNDLER_KEY;
  /* c8 ignore next 5 */
  log.debug(`invoked manually, ${invokeAllowed ? '' : 'not'} invoking handler`);
  if (invokeAllowed) {
    // @ts-ignore
    event.task = event.task || ctx.data.task;
  }
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
    if (shouldRunEventHandler(request, context)) {
      resp = await EVENT_HANDLERS[context.invocation.event.task](context);
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
  } finally {
    if (context.attributes.storage) {
      context.attributes.storage.close();
      delete context.attributes.storage;
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
// @ts-ignore
export const main = wrap(run)
  .with(addCommonResponseHeadersWrapper)
  .with(bodyData)
  .with(secrets)
  .with(helixStatus);
