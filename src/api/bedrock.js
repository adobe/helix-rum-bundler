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

import { Readable } from 'stream';
import { Response } from '@adobe/fetch';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { assertAdminOrSuperuserAuthorized } from '../support/authorization.js';
import { errorWithResponse } from '../support/util.js';

/**
 * Proxy request to Bedrock API using streaming to prevent CDN timeouts.
 * Keepalive whitespace flows to Fastly while chunks are collected,
 * then the assembled JSON is sent. Client receives standard JSON.
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

  if (ctx.env.BEDROCK_ROLE_ARN) {
    const stsClient = new STSClient({ region });
    try {
      const sts = await stsClient.send(new AssumeRoleCommand({
        RoleArn: ctx.env.BEDROCK_ROLE_ARN,
        RoleSessionName: 'helix-rum-bundler',
        DurationSeconds: 900,
      }));
      credentials = {
        accessKeyId: sts.Credentials.AccessKeyId,
        secretAccessKey: sts.Credentials.SecretAccessKey,
        sessionToken: sts.Credentials.SessionToken,
      };
    } catch (err) {
      ctx.log.error('STS AssumeRole error', err.name, err.message);
      throw errorWithResponse(502, `sts error: ${err.name}`);
    }
  }

  const client = new BedrockRuntimeClient({ region, credentials });
  const command = new InvokeModelWithResponseStreamCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: body.max_tokens || 4096,
      ...body,
      modelId: undefined,
    }),
  });

  try {
    const res = await client.send(command);
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        const keepalive = setInterval(() => controller.enqueue(enc.encode(' ')), 10000);
        try {
          const content = [];
          let stopReason = '';
          let model = '';
          let inputTokens = 0;
          let outputTokens = 0;

          for await (const event of res.body) {
            if (event.chunk?.bytes) {
              try {
                const e = JSON.parse(dec.decode(event.chunk.bytes));
                switch (e.type) {
                  case 'message_start':
                    model = e.message?.model || '';
                    inputTokens = e.message?.usage?.input_tokens || 0;
                    break;
                  case 'content_block_start':
                    content[e.index] = { type: e.content_block?.type || 'text', text: '' };
                    break;
                  case 'content_block_delta':
                    if (e.delta?.text) content[e.index].text += e.delta.text;
                    break;
                  case 'message_delta':
                    stopReason = e.delta?.stop_reason || stopReason;
                    outputTokens = e.usage?.output_tokens || outputTokens;
                    break;
                  default: break;
                }
              } catch { /* skip non-JSON chunks */ }
            }
          }

          clearInterval(keepalive);
          const result = JSON.stringify({
            content,
            stop_reason: stopReason,
            model,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          controller.enqueue(enc.encode(result));
          controller.close();
        } catch (err) {
          clearInterval(keepalive);
          controller.error(err);
        }
      },
    });

    return new Response(Readable.fromWeb(stream), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    ctx.log.error('Bedrock API error', err.name, err.message);
    const sanitizedMessage = err.message?.replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7E]/g, '') || '';
    throw errorWithResponse(502, `bedrock error: ${err.name}: ${sanitizedMessage}`);
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
