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

import processQueue from '@adobe/helix-shared-process-queue';
import { config as configEnv } from 'dotenv';
import { HelixStorage } from '../../../src/support/storage.js';
import { contextLike } from './util.js';

configEnv();

/**
 * rotates all domainkeys
 */

(async () => {
  if (!process.env.DOMAINKEY_API_KEY) {
    throw Error('missing env variable: DOMAINKEY_API_KEY');
  }

  const { DOMAINKEY_API_KEY: apiKey } = process.env;
  const ctx = contextLike();
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const domains = await bundleBucket.listFolders('');
  await processQueue(
    domains,
    async (domain) => {
      const resp = await fetch(`https://rum.fastly-aem.page/domainkey/${domain}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
      if (!resp.ok) {
        console.warn(`failed to rotate domainkey for ${domain}: ${resp.status}`);
      } else {
        console.info(`rotated domainkey for ${domain}`);
      }
    },
  );
})().catch((e) => console.error(e));
