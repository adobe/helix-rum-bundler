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
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { assertAdminOrSuperuserAuthorized } from '../support/authorization.js';
import { errorWithResponse } from '../support/util.js';

/**
 * Proxy request to Bedrock InvokeModel API (Claude Messages format).
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function invokeModel(req, ctx) {
  const body = ctx.data;
  if (!body?.messages) {
    throw errorWithResponse(400, 'missing messages in request body');
  }

  const modelId = body.modelId || ctx.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw errorWithResponse(400, 'missing modelId in request body or environment');
  }

  const region = ctx.env.BEDROCK_REGION || 'us-east-1';
  let credentials;

  // If cross-account role is configured, assume it first
  if (ctx.env.BEDROCK_ROLE_ARN) {
    const stsClient = new STSClient({ region });
    let assumeRoleResponse;
    try {
      assumeRoleResponse = await stsClient.send(new AssumeRoleCommand({
        RoleArn: ctx.env.BEDROCK_ROLE_ARN,
        RoleSessionName: 'helix-rum-bundler',
        DurationSeconds: 900,
      }));
    } catch (err) {
      ctx.log.error('STS AssumeRole error', err.name, err.message);
      throw errorWithResponse(502, `sts error: ${err.name}`);
    }
    credentials = {
      accessKeyId: assumeRoleResponse.Credentials.AccessKeyId,
      secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey,
      sessionToken: assumeRoleResponse.Credentials.SessionToken,
    };
  }

  const client = new BedrockRuntimeClient({ region, credentials });
  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: body.max_tokens || 4096,
      ...body,
      modelId: undefined, // exclude from request body
    }),
  });

  try {
    const response = await client.send(command);
    return new Response(new TextDecoder().decode(response.body), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    ctx.log.error('Bedrock API error', err.name, err.message);
    throw errorWithResponse(502, `bedrock error: ${err.name}: ${err.message}`);
  }
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
    return invokeModel(req, ctx);
  }

  return new Response('method not allowed', { status: 405 });
}
