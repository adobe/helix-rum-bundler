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
 * wipes all aggregate files for all domains,
 * or just domains in `DOMAINS` env var
 */

(async () => {
  const ctx = contextLike();
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  let { DOMAINS: domains } = process.env;
  if (domains) {
    domains = domains.split(',');
  } else {
    domains = await getDomains(ctx);
  }
  const domainCount = domains.length;
  console.info(`wiping aggregates for ${domainCount} domains: `, domains.join(', '));

  const affected = [];
  let removed = 0;
  await processQueue(
    domains,
    async (domain) => {
      const toRemove = (await bundleBucket.list(`${domain}/`))
        .objects
        .filter(({ key }) => key.endsWith('/aggregate.json') || key.endsWith('/aggregate-test.json'))
        .map(({ key }) => key);

      if (!toRemove.length) {
        return;
      }

      affected.push(domain);
      removed += toRemove.length;

      // batch remove in sets of up to 1000
      const ps = [];
      for (let i = 0; i < toRemove.length; i += 1000) {
        ps.push(bundleBucket.remove(toRemove.slice(i, i + 1000)));
      }
      await Promise.allSettled(ps);
    },
  );

  console.info(`wiped ${removed} aggregates files from ${domainCount} domains: `, `\n\t${affected.join('\n\t')}`);
})().catch((e) => console.error(e));
