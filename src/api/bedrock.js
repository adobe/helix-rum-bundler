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
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { assertAdminOrSuperuserAuthorized } from '../support/authorization.js';
import { errorWithResponse } from '../support/util.js';
import { PathInfo } from '../support/PathInfo.js';

const JOBS_BUCKET = 'helix-rum-logs';
const JOBS_PREFIX = 'bedrock-jobs';

function getRegion(ctx) {
  return ctx.env.BEDROCK_REGION || 'us-east-1';
}

function validateRequest(ctx) {
  const body = ctx.data;
  if (!body?.messages) {
    throw errorWithResponse(400, 'missing messages in request body');
  }
  const modelId = body.modelId || ctx.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw errorWithResponse(400, 'missing modelId in request body or environment');
  }
  return { body, modelId };
}

/**
 * Get AWS credentials via STS AssumeRole
 * @param {UniversalContext} ctx
 * @param {string} region
 */
async function getCredentials(ctx, region) {
  if (!ctx.env.BEDROCK_ROLE_ARN) return undefined;

  const stsClient = new STSClient({ region });
  try {
    const sts = await stsClient.send(new AssumeRoleCommand({
      RoleArn: ctx.env.BEDROCK_ROLE_ARN,
      RoleSessionName: 'helix-rum-bundler',
      DurationSeconds: 900,
    }));
    return {
      accessKeyId: sts.Credentials.AccessKeyId,
      secretAccessKey: sts.Credentials.SecretAccessKey,
      sessionToken: sts.Credentials.SessionToken,
    };
  } catch (err) {
    ctx.log.error('STS AssumeRole error', err.name, err.message);
    throw errorWithResponse(502, `sts error: ${err.name}`);
  }
}

/**
 * Call Bedrock API synchronously (non-streaming)
 * @param {BedrockRuntimeClient} client
 * @param {object} body
 * @param {Function} log
 */
async function callBedrock(client, body, log) {
  const { modelId } = body;
  const maxTokens = body.max_tokens || 4096;

  log.info(`[bedrock] invoking model=${modelId} max_tokens=${maxTokens}`);

  const command = new InvokeModelCommand({
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

  const startTime = Date.now();
  const response = await client.send(command);
  const elapsed = Date.now() - startTime;

  const result = JSON.parse(new TextDecoder().decode(response.body));
  log.info(`[bedrock] completed in ${elapsed}ms, stop_reason=${result.stop_reason}`);

  return result;
}

/**
 * Handle sync POST /bedrock - direct invocation for quick requests
 * Note: Will timeout for long-running requests. Use /bedrock/jobs for those.
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function invokeModelSync(req, ctx) {
  const { body, modelId } = validateRequest(ctx);
  const region = getRegion(ctx);
  const credentials = await getCredentials(ctx, region);
  const client = new BedrockRuntimeClient({ region, credentials });

  try {
    const result = await callBedrock(client, { ...body, modelId }, ctx.log);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    ctx.log.error(`[bedrock] error: ${err.name} ${err.message}`);
    throw errorWithResponse(502, `bedrock error: ${err.name}`);
  }
}

// ============ Async Job API ============

function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getJobKey(jobId) {
  return `${JOBS_PREFIX}/${jobId}.json`;
}

async function saveJob(s3, jobId, data) {
  await s3.send(new PutObjectCommand({
    Bucket: JOBS_BUCKET,
    Key: getJobKey(jobId),
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

async function getJob(s3, jobId) {
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: JOBS_BUCKET,
      Key: getJobKey(jobId),
    }));
    const body = await result.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

/**
 * Process job - called from async Lambda invocation
 * @param {UniversalContext} ctx
 * @param {string} jobId
 * @param {object} requestBody
 */
async function processJob(ctx, jobId, requestBody) {
  const { log } = ctx;
  const region = getRegion(ctx);
  const s3 = new S3Client({ region });
  const startTime = Date.now();

  log.info(`[bedrock-job] processing ${jobId}`);

  try {
    const credentials = await getCredentials(ctx, region);
    const client = new BedrockRuntimeClient({ region, credentials });
    const result = await callBedrock(client, requestBody, log);

    const elapsed = Date.now() - startTime;
    log.info(`[bedrock-job] ${jobId} completed in ${elapsed}ms`);

    await saveJob(s3, jobId, {
      status: 'completed',
      result,
      completedAt: new Date().toISOString(),
      elapsed,
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log.error(`[bedrock-job] ${jobId} failed after ${elapsed}ms: ${err.name} ${err.message}`);

    await saveJob(s3, jobId, {
      status: 'failed',
      error: { name: err.name, message: err.message },
      failedAt: new Date().toISOString(),
      elapsed,
    });
  }
}

/**
 * Submit async job - POST /bedrock/jobs
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function submitJob(req, ctx) {
  const { body, modelId } = validateRequest(ctx);
  const region = getRegion(ctx);
  const s3 = new S3Client({ region });
  const jobId = generateJobId();

  ctx.log.info(`[bedrock-job] submitting ${jobId}`);

  // Save initial state
  await saveJob(s3, jobId, {
    status: 'processing',
    createdAt: new Date().toISOString(),
    request: { modelId, max_tokens: body.max_tokens || 4096 },
  });

  // Invoke Lambda asynchronously
  const lambdaClient = new LambdaClient({ region });
  const functionName = ctx.env.AWS_LAMBDA_FUNCTION_NAME || 'helix3--rum-bundler';

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        source: 'bedrock-job',
        jobId,
        request: { ...body, modelId },
      }),
    }));
    ctx.log.info(`[bedrock-job] ${jobId} async invocation triggered`);
  } catch (err) {
    ctx.log.error(`[bedrock-job] ${jobId} invoke failed: ${err.message}`);
    await saveJob(s3, jobId, {
      status: 'failed',
      error: { name: 'InvocationError', message: 'Failed to start job' },
      failedAt: new Date().toISOString(),
    });
    throw errorWithResponse(502, 'failed to start job');
  }

  return new Response(JSON.stringify({ jobId, status: 'processing' }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Get job status - GET /bedrock/jobs/{jobId}
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function getJobStatus(req, ctx) {
  const info = PathInfo.fromContext(ctx);
  const { jobId } = info;

  if (!jobId) throw errorWithResponse(400, 'missing jobId');

  const region = getRegion(ctx);
  const s3 = new S3Client({ region });
  const job = await getJob(s3, jobId);

  if (!job) throw errorWithResponse(404, 'job not found');

  return new Response(JSON.stringify(job), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Process bedrock job from async Lambda invocation
 * @param {UniversalContext} ctx
 * @param {object} event
 */
export async function processBedrockJob(ctx, event) {
  const { jobId, request } = event;
  await processJob(ctx, jobId, request);
  return new Response(JSON.stringify({ jobId, status: 'processed' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Log usage summary - POST /bedrock/usage
 * Called by client after report generation completes
 * Logs to Coralogix via log.info for usage tracking
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
async function logUsage(req, ctx) {
  const body = ctx.data;

  // Validate required fields
  if (!body?.reportId) {
    throw errorWithResponse(400, 'missing reportId');
  }
  if (typeof body.inputTokens !== 'number' || typeof body.outputTokens !== 'number') {
    throw errorWithResponse(400, 'missing or invalid token counts');
  }

  const user = ctx.attributes.adminId || 'unknown';
  const model = body.model || 'unknown';
  const totalTokens = body.inputTokens + body.outputTokens;

  ctx.log.info('[bedrock-usage]', {
    user,
    model,
    inputTokens: body.inputTokens,
    outputTokens: body.outputTokens,
    totalTokens,
    reportId: body.reportId,
  });

  return new Response(JSON.stringify({ status: 'recorded' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Handle /bedrock routes
 * @param {RRequest} req
 * @param {UniversalContext} ctx
 */
export default async function handleRequest(req, ctx) {
  await assertAdminOrSuperuserAuthorized(req, ctx);

  const info = PathInfo.fromContext(ctx);

  // POST /bedrock/jobs - submit async job
  if (info.subroute === 'jobs' && req.method === 'POST') {
    return submitJob(req, ctx);
  }

  // GET /bedrock/jobs/{jobId} - get job status
  if (info.subroute === 'job' && req.method === 'GET') {
    return getJobStatus(req, ctx);
  }

  // POST /bedrock - sync invocation (for quick requests only)
  if (info.subroute === 'sync' && req.method === 'POST') {
    return invokeModelSync(req, ctx);
  }

  // POST /bedrock/usage - log usage summary
  if (info.subroute === 'usage' && req.method === 'POST') {
    return logUsage(req, ctx);
  }

  return new Response('method not allowed', { status: 405 });
}
