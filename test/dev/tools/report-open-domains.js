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

import { config as configEnv } from 'dotenv';
import { contextLike, findOpenDomains } from './util.js';

configEnv();

/**
 * report all domains without domainkey
 * display missing/empty `.domainkey` files separately
 */

(async () => {
  const ctx = contextLike();
  const { missing, empty } = await findOpenDomains(ctx);

  console.group('missing domainkeys: ');
  console.table(missing);
  console.groupEnd();

  console.log('');

  console.group('open domains: ');
  console.table(empty);
  console.groupEnd();
})().catch((e) => console.error(e));
