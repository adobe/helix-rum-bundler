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
import { HelixStorage } from './support/storage.js';

/**
 * Process RUM event files into bundles
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
async function bundleRUM(ctx) {
  const { logBucket, bundleBucket } = HelixStorage.fromContext(ctx);

  // list files in log bucket
  const objects = await logBucket.list('raw/');
  const files = await Promise.all(
    objects
      .filter((o) => !!o.contentType)
      .map(async ({ key }) => {
        const buf = await logBucket.get(key);
        const txt = new TextDecoder('utf8').decode(buf);
        return txt;
      }),
  );
  const rawEvents = files
    .filter((e) => !!e)
    .reduce((events, txt) => {
      const lines = txt.split('\n');
      lines.forEach((line) => {
        try {
          events.push(JSON.parse(line));
        } catch { /* invalid, ignored */ }
      });
      return events;
    }, []);

  // sort raw event into map (storageKey => event[])
  const rawEventMap = {};
  rawEvents.forEach((event) => {
    const date = new Date(event.time);
    const domain = event.host;
    const key = `/${domain}/${date.getUTCFullYear()}/${date.getUTCMonth()}/${date.getUTCDate()}/${date.getUTCHours()}`;
    if (!rawEventMap[key]) {
    // eslint-disable-next-line no-param-reassign
      rawEventMap[key] = [];
    }
    rawEventMap[key].push(event);
  });

  await Promise.allSettled(
    Object.entries(rawEventMap)
      .forEach(async ([key, events]) => {
        // if bundle exists, append, otherwise create
        const existing = await bundleBucket.get(key);

        /** @type {RUMBundle} */
        let bundle;
        if (existing) {
          const txt = new TextDecoder('utf8').decode(existing);
          bundle = JSON.parse(txt);
        } else {
          bundle = [];
        }

        // convert bundle to map (id => event[])
        /** @type {Record<string, RUMEventGroup>} */
        const bundleMap = bundle.reduce((acc, group) => {
          acc[group.id] = group;
          return acc;
        }, {});

        // add events to associated group
        events.forEach((event) => {
          if (!bundleMap[event.id]) {
            bundleMap[event.id] = {
              ...event,
              events: [],
            };
            bundleMap[event.id].events.push(event);
          }
        });

        // convert back to bundle and store
        bundle = Object.values(bundleMap);
        await bundleBucket.put(key, JSON.stringify(bundle));
      }),
  );

  // move all events into processed folder
  await Promise.allSettled(
    objects.map(async ({ key }) => {
      await logBucket.move(key, key.replace('raw/', 'processed/'));
    }),
  );

  return new Response('rum bundled');
}

/**
 * Respond to HTTP request
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
// eslint-disable-next-line no-unused-vars
async function handleRequest(req, ctx) {
  // TODO
  return new Response('request handled');
}

/**
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {boolean}
 */
function shouldBundleRUM(ctx) {
  return ctx.invocation.event.source === 'aws.events' || (ctx.runtime.name === 'simulate' && ctx.data.bundle);
}

/**
 * @param {RRequest} request
 * @param {UniversalContext} context
 * @returns {Promise<RResponse>}
 */
async function run(request, context) {
  const { log } = context;

  let resp;
  try {
    if (shouldBundleRUM(context)) {
      resp = await bundleRUM(context);
    } else {
      resp = await handleRequest(request, context);
    }
  } catch (e) {
    if (e?.response) {
      resp = e.response;
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

export const main = wrap(run)
  .with(helixStatus)
  .with(logger.trace)
  .with(logger)
  .with(bodyData);
