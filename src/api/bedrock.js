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

const MAX_RETRIES = 3;
const RETRYABLE_ERRORS = ['ServiceUnavailableException', 'ThrottlingException', 'ModelStreamErrorException'];

/**
 * Format error details for logging and response headers
 * @param {Error & {$metadata?: any}} err
 * @param {number} attempt
 * @param {number} elapsed
 */
function formatErrorDetails(err, attempt, elapsed) {
  const requestId = err.$metadata?.requestId || 'unknown';
  const code = err.$metadata?.httpStatusCode || 'unknown';
  return `${err.name}: ${err.message} (requestId=${requestId}, code=${code}, attempt=${attempt}/${MAX_RETRIES}, elapsed=${elapsed}ms)`;
}

/**
 * Send command to Bedrock with retry logic for transient errors
 * @param {BedrockRuntimeClient} client
 * @param {InvokeModelWithResponseStreamCommand} command
 * @param {Function} log
 * @param {number} startTime
 * @param {number} attempt
 */
async function sendWithRetry(client, command, log, startTime, attempt = 1) {
  try {
    log.info(`[bedrock] invoking Bedrock API (attempt ${attempt}/${MAX_RETRIES})...`);
    const res = await client.send(command);
    log.info('[bedrock] stream started, processing chunks...');
    return res;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const details = formatErrorDetails(err, attempt, elapsed);
    if (RETRYABLE_ERRORS.includes(err.name) && attempt < MAX_RETRIES) {
      const delayMs = attempt * 2000;
      log.warn(`[bedrock] retryable error, waiting ${delayMs}ms: ${details}`);
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          sendWithRetry(client, command, log, startTime, attempt + 1)
            .then(resolve)
            .catch(reject);
        }, delayMs);
      });
    }
    log.error(`[bedrock] non-retryable or max retries reached: ${details}`);
    throw err;
  }
}

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
  const maxTokens = body.max_tokens || 4096;
  const msgCount = body.messages?.length || 0;
  const sysLen = body.system?.length || 0;

  ctx.log.info(`[bedrock] request: model=${modelId} messages=${msgCount} system_len=${sysLen} max_tokens=${maxTokens}`);

  const command = new InvokeModelWithResponseStreamCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      ...body,
      modelId: undefined,
    }),
  });

  const { log } = ctx;
  const startTime = Date.now();

  try {
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        // Send first byte IMMEDIATELY to satisfy Fastly first-byte timeout
        controller.enqueue(enc.encode(' '));
        // Keepalive: send whitespace every 3s to prevent CDN timeout during long operations
        const keepalive = setInterval(() => controller.enqueue(enc.encode(' ')), 3000);
        try {
          // Call Bedrock with retry INSIDE stream so keepalive protects the wait
          const bedrockResponse = await sendWithRetry(client, command, log, startTime);

          const content = [];
          let stopReason = '';
          let model = '';
          let inputTokens = 0;
          let outputTokens = 0;
          let lastKeepalive = Date.now();

          for await (const event of bedrockResponse.body) {
            // Send keepalive during stream processing to prevent timeout on long responses
            const now = Date.now();
            if (now - lastKeepalive > 3000) {
              controller.enqueue(enc.encode(' '));
              lastKeepalive = now;
            }
            if (event.chunk?.bytes) {
              try {
                const e = JSON.parse(dec.decode(event.chunk.bytes));
                switch (e.type) {
                  case 'message_start':
                    model = e.message?.model || '';
                    inputTokens = e.message?.usage?.input_tokens || 0;
                    break;
                  case 'content_block_start': {
                    const block = e.content_block || {};
                    const blockType = block.type;
                    // Detect tool_use by type OR presence of id/name fields
                    const isToolUse = blockType === 'tool_use'
                      || blockType === 'toolUse'
                      || (block.id && block.name);
                    log.info(`[bedrock] content_block_start: type="${blockType}" isToolUse=${isToolUse}`);
                    if (isToolUse) {
                      content[e.index] = {
                        type: 'tool_use',
                        id: block.id || block.toolUseId || '',
                        name: block.name || '',
                        input: '',
                      };
                    } else {
                      content[e.index] = { type: blockType || 'text', text: '' };
                    }
                    break;
                  }
                  case 'content_block_delta': {
                    // Ensure block exists (defensive: delta should follow start)
                    if (!content[e.index]) {
                      content[e.index] = { type: 'text', text: '' };
                    }
                    const curr = content[e.index];
                    if (e.delta?.type === 'input_json_delta') {
                      // Ensure input field exists for tool_use blocks
                      if (curr.input === undefined) curr.input = '';
                      curr.input += e.delta.partial_json || '';
                    } else if (e.delta?.text !== undefined) {
                      if (curr.text === undefined) curr.text = '';
                      curr.text += e.delta.text;
                    }
                    break;
                  }
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
          const elapsed = Date.now() - startTime;
          log.info(`[bedrock] stream complete: model=${model} input=${inputTokens} output=${outputTokens} stop=${stopReason} elapsed=${elapsed}ms`);

          // Parse accumulated JSON string for tool_use blocks
          for (let i = 0; i < content.length; i += 1) {
            const block = /** @type {any} */ (content[i]);
            if (block.type === 'tool_use' && typeof block.input === 'string') {
              try {
                block.input = JSON.parse(block.input || '{}');
              } catch (_e) {
                block.input = {};
              }
            }
          }

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
          const elapsed = Date.now() - startTime;
          log.error(`[bedrock] stream processing error after ${elapsed}ms: ${err.name} ${err.message}`);
          controller.error(err);
        }
      },
    });

    return new Response(Readable.fromWeb(stream), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    ctx.log.error(`[bedrock] response error: ${err.name} ${err.message}`);
    throw errorWithResponse(502, `bedrock error: ${err.name}`);
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
