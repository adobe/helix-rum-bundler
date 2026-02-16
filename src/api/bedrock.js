/*
 * Copyright 2026 Adobe. All rights reserved.
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
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { assertAdminOrSuperuserAuthorized } from '../support/authorization.js';
import { errorWithResponse } from '../support/util.js';

/**
 * Proxy request to Bedrock Converse API.
 * Accepts the same request body format as direct Bedrock API calls.
 *
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function converse(req, ctx) {
  /** @type {any} */
  const body = ctx.data;

  if (!body || !body.messages) {
    throw errorWithResponse(400, 'missing messages in request body');
  }

  const region = ctx.env.BEDROCK_REGION || 'us-east-1';
  const client = new BedrockRuntimeClient({ region });

  // Use model from request body, env, or error
  const modelId = body.modelId || ctx.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw errorWithResponse(400, 'missing modelId in request body or environment');
  }

  const command = new ConverseCommand({
    modelId,
    messages: body.messages,
    system: body.system,
    inferenceConfig: body.inferenceConfig,
    toolConfig: body.toolConfig,
  });

  const response = await client.send(command);

  return new Response(JSON.stringify({
    output: response.output,
    stopReason: response.stopReason,
    usage: response.usage,
    metrics: response.metrics,
  }), {
    headers: {
      'content-type': 'application/json',
    },
  });
}

/**
 * Handle /bedrock route
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 * @returns {Promise<RResponse>}
 */
export default async function handleRequest(req, ctx) {
  await assertAdminOrSuperuserAuthorized(req, ctx);

  if (req.method === 'POST') {
    return converse(req, ctx);
  }

  return new Response('method not allowed', { status: 405 });
}
