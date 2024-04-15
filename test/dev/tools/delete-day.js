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
import { HelixStorage } from '../../../src/support/storage.js';
import { contextLike, parseDate } from './util.js';

(async () => {
  if (!process.env.DATE) {
    throw Error('missing env variable: DATE');
  }
  const ctx = contextLike();
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const prefixes = await bundleBucket.listFolders('');
  const { year, month, day } = parseDate(process.env.DATE);
  console.debug(`removing year=${year} month=${month} day=${day} from ${prefixes.length} domains`);
  const folders = prefixes.map((pre) => `${pre}${year}/${month}/${day}`);

  // slice folders array into chunks of 1000
  const chunks = folders.reduce((acc, cur, i) => {
    if (i % 1000 === 0) {
      acc.push([]);
    }
    acc[acc.length - 1].push(cur);
    return acc;
  }, []);

  await processQueue(
    chunks,
    async (chunk) => {
      await bundleBucket.remove(chunk);
    },
  );
})().catch((e) => console.error(e));
