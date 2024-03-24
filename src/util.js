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

import { Response } from '@adobe/fetch';

class ErrorWithResponse extends Error {
  /**
   * @param {string} message used for logging
   * @param {RResponse} response used as response
   */
  constructor(message, response) {
    super(message);
    this.response = response;
  }
}

/**
 * @param {number} status status code
 * @param {string} xError public, returned as x-error header
 * @param {string} [message=''] private, logged and not returned to client
 * @returns {ErrorWithResponse}
 */
export function errorWithResponse(status, xError, message = '') {
  return new ErrorWithResponse(
    message,
    new Response('', {
      status,
      headers: {
        'x-error': xError,
      },
    }),
  );
}
