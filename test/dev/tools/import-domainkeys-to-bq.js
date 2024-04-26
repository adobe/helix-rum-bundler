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

/* eslint-disable no-console */

import processQueue from '@adobe/helix-shared-process-queue';
import { config as configEnv } from 'dotenv';
import { HelixStorage } from '../../../src/support/storage.js';
import { contextLike, getDomains } from './util.js';
import { addRunQueryDomainkey } from '../../../src/api/domainkey.js';

configEnv();

/**
 * adds all domainkeys to biquery
 */

(async () => {
  if (!process.env.DOMAINKEY_API_KEY) {
    throw Error('missing env variable: DOMAINKEY_API_KEY');
  }

  const ctx = contextLike({ env: { RUNQUERY_ROTATION_KEY: process.env.DOMAINKEY_API_KEY } });
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const domains = await getDomains(ctx);
  await processQueue(
    domains,
    async (domain) => {
      console.log('process: ', domain);
      const buf = await bundleBucket.get(`${domain}/.domainkey`);
      if (!buf) {
        return;
      }
      try {
        const domainkey = new TextDecoder('utf8').decode(buf);
        if (!domainkey) {
          return;
        }

        ctx.log.debug(`importing domainkey for ${domain}`);
        await addRunQueryDomainkey(ctx, domain, domainkey);
      } catch (e) {
        console.error(`failed to import domainkey for ${domain}: `, e);
      }
    },
  );
})().catch((e) => console.error(e));
