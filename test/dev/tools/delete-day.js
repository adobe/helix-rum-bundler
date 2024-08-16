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
import { HelixStorage } from '../../../src/support/storage.js';
import { contextLike, parseDate } from './util.js';

/**
 * deletes a single date (`env.DATE`) from all domains, except for `env.IGNORED_DOMAINS`
 */

(async () => {
  if (!process.env.DATE) {
    throw Error('missing env variable: DATE');
  }
  const ignoreArr = process.env.IGNORE_DOMAINS ? process.env.IGNORE_DOMAINS.split(',') : [];
  const ignored = Object.fromEntries(ignoreArr.map((i) => [i, true]));
  const ctx = contextLike();
  const { bundleBucket } = HelixStorage.fromContext(ctx);

  const prefixes = (await bundleBucket.listFolders('')).folders.filter((p) => !ignored[p.slice(0, -1)]);
  const { year, month, day } = parseDate(process.env.DATE);
  console.debug(`removing year=${year} month=${month} day=${day} from ${prefixes.length} domains`);
  const folders = prefixes.map((pre) => `${pre}${year}/${month}/${day}/`);

  await processQueue(
    folders,
    async (folder) => {
      const { objects } = await bundleBucket.list(folder);
      if (!objects || !objects.length) {
        return;
      }

      console.debug(`removing ${objects.length} objects from ${folder}`);
      await bundleBucket.remove(objects.map((o) => o.key));
    },
  );
})().catch((e) => console.error(e));
