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

configEnv();

/**
 * logs all domainkeys currently in storage
 */

(async () => {
  const ctx = contextLike();
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const domains = await getDomains(ctx);
  const entries = await processQueue(
    domains,
    async (domain) => {
      try {
        const buf = await bundleBucket.get(`${domain}/.domainkey`);
        if (!buf) {
          console.warn(`missing domainkey for ${domain}`);
          return [domain, '<MISSING>'];
        }
        const domainkey = new TextDecoder('utf8').decode(buf);
        if (!domainkey) {
          return [domain, '<OPEN>'];
        }
        return [domain, domainkey];
      } catch (e) {
        return [domain, `<ERROR: ${e.message}>`];
      }
    },
  );

  console.log(
    JSON.stringify(
      Object.fromEntries(entries),
      undefined,
      2,
    ),
  );
})().catch((e) => console.error(e));
