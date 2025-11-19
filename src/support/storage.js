/*
 * Copyright 2022 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-disable max-classes-per-file,no-param-reassign */
import { Agent } from 'node:https';
import { promisify } from 'util';
import zlib from 'zlib';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';

import { Response } from '@adobe/fetch';
import mime from 'mime';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * @typedef {import('@aws-sdk/client-s3').CommandInput} CommandInput
 */

/**
 * @typedef ObjectInfo
 * @property {string} key
 * @property {string} path the path to the object, w/o the prefix
 * @property {string} lastModified
 * @property {number} contentLength
 * @property {string} contentType
 */

/**
 * @callback ObjectFilter
 * @param {ObjectInfo} info of the object to filter
 * @returns {boolean} {@code true} if the object is accepted
 */

/**
 * Header names that AWS considers system defined.
 */
const AWS_S3_SYSTEM_HEADERS = [
  'cache-control',
  'content-type',
  'expires',
];

/**
 * result object headers
 */
const AWS_META_HEADERS = [
  'CacheControl',
  'ContentType',
  'ContentEncoding',
  'Expires',
];

/**
 * Response header names that need a different metadata name.
 */
const METADATA_HEADER_MAP = new Map([
  ['last-modified', 'x-source-last-modified'],
]);

/**
 * Sanitizes the input key or path and returns a bucket relative key (without leading / ).
 * @param {string} keyOrPath
 * @returns {string}
 */
function sanitizeKey(keyOrPath) {
  if (keyOrPath.charAt(0) === '/') {
    return keyOrPath.substring(1);
  }
  return keyOrPath;
}

/**
 * Bucket class
 */
class Bucket {
  constructor(opts) {
    Object.assign(this, {
      _s3: opts.s3,
      _r2: opts.r2,
      _log: opts.log,
      _clients: [opts.s3],
      _bucket: opts.bucketId,
    });
    if (opts.r2) {
      this._clients.push(opts.r2);
    }
  }

  /** @type {S3Client} */
  get client() {
    return this._s3;
  }

  /** @type {string} */
  get bucket() {
    return this._bucket;
  }

  /** @type {Console} */
  get log() {
    return this._log;
  }

  /**
   * Return an object contents.
   *
   * @param {string} key object key
   * @param {object} [meta] output object to receive metadata if specified
   * @returns object contents as a Buffer or null if no found.
   * @throws an error if the object could not be loaded due to an unexpected error.
   */
  async get(key, meta = null, { quiet = false } = {}) {
    const { log } = this;
    const input = {
      Bucket: this.bucket,
      Key: sanitizeKey(key),
    };

    try {
      const result = await this.client.send(new GetObjectCommand(input));
      log[quiet ? 'debug' : 'info'](`object downloaded from: ${input.Bucket}/${input.Key}`);

      if (new Date() > new Date(result.ExpiresString)) {
        log.debug(`object expired: ${input.Bucket}/${input.Key}`);
        return null;
      }

      const buf = await new Response(result.Body, {}).buffer();
      if (meta) {
        Object.assign(meta, result.Metadata);
        for (const name of AWS_META_HEADERS) {
          if (name in result) {
            meta[name] = result[name];
          }
        }
      }
      if (result.ContentEncoding === 'gzip') {
        return await gunzip(buf);
      }
      return buf;
    } catch (e) {
      /* c8 ignore next 3 */
      if (e.$metadata.httpStatusCode !== 404) {
        throw e;
      }
      return null;
    }
  }

  async head(path) {
    const input = {
      Bucket: this._bucket,
      Key: sanitizeKey(path),
    };
    try {
      const result = await this.client.send(new HeadObjectCommand(input));
      this.log.info(`Object metadata downloaded from: ${input.Bucket}/${input.Key}`);
      return result;
    } catch (e) {
      /* c8 ignore next 3 */
      if (e.$metadata.httpStatusCode !== 404) {
        throw e;
      }
      return null;
    }
  }

  /**
   * Return an object's metadata.
   *
   * @param {string} key object key
   * @returns object metadata or null
   * @throws an error if the object could not be loaded due to an unexpected error.
   */
  async metadata(key) {
    const res = await this.head(key);
    return res?.Metadata;
  }

  /**
   * Internal helper for sending a command to both S3 and R2 clients.
   * @param {function} CommandConstructor constructor of command to send to the client
   * @param {CommandInput} input command input
   * @returns {Promise<*>} the command result
   */
  async sendToS3andR2(CommandConstructor, input) {
    // send cmd to s3 and r2 (mirror) in parallel
    const tasks = this._clients.map((c) => c.send(new CommandConstructor(input)));
    const result = await Promise.allSettled(tasks);

    const rejected = result.filter(({ status }) => status === 'rejected');
    if (!rejected.length) {
      return result[0].value;
    } else {
      // at least 1 cmd failed
      /* c8 ignore next */
      const type = result[0].status === 'rejected' ? 'S3' : 'R2';
      const err = rejected[0].reason;
      err.message = `[${type}] ${err.message}`;
      throw err;
    }
  }

  /**
   * Store an object contents, along with headers.
   *
   * @param {string} key object key
   * @param {Response} res response to store
   * @returns result obtained from S3
   */
  async store(key, res, { quiet = false } = {}) {
    const { log } = this;
    const body = await res.buffer();
    const zipped = await gzip(body);

    const input = {
      Body: zipped,
      Bucket: this.bucket,
      ContentEncoding: 'gzip',
      Metadata: {},
      Key: sanitizeKey(key),
    };

    Array.from(res.headers.entries()).forEach(([name, value]) => {
      if (AWS_S3_SYSTEM_HEADERS.includes(name)) {
        // system headers are stored in the command itself, e.g.
        // `content-type` header is stored as `ContentType` property
        const property = name.split('-').map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1)).join('');
        input[property] = value;
      } else {
        // use preferred name in metadata if any
        input.Metadata[METADATA_HEADER_MAP.get(name) || name] = value;
      }
    });

    // write to s3 and r2 (mirror) in parallel
    await this.sendToS3andR2(PutObjectCommand, input);
    log[quiet ? 'debug' : 'info'](`object uploaded to: ${input.Bucket}/${input.Key}`);
  }

  /**
   * Store an object contents, along with metadata.
   *
   * @param {string} path object key
   * @param {Buffer|string} body data to store
   * @param {string} [contentType] content type. defaults to 'application/octet-stream'
   * @param {Date} [expiresOn] expiration date
   * @param {object} [meta] metadata to store with the object. defaults to '{}'
   * @param {boolean} [compress = true]
   * @returns result obtained from S3
   */
  async put(path, body, contentType = 'application/octet-stream', expiresOn = undefined, meta = {}, compress = true, { quiet = false } = {}) {
    const input = {
      Body: body,
      Bucket: this.bucket,
      ContentType: contentType,
      Metadata: meta,
      Key: sanitizeKey(path),
      Expires: expiresOn,
    };
    if (compress) {
      input.ContentEncoding = 'gzip';
      input.Body = await gzip(body);
    }
    // write to s3 and r2 (mirror) in parallel
    const res = await this.sendToS3andR2(PutObjectCommand, input);
    this.log[quiet ? 'debug' : 'info'](`object uploaded to: ${input.Bucket}/${input.Key}`);
    return res;
  }

  /**
   * Copy an object in the same bucket.
   *
   * @param {string} src source key
   * @param {string} dst destination key
   * @returns result obtained from S3
   */
  async copy(src, dst) {
    const input = {
      Bucket: this.bucket,
      CopySource: `${this.bucket}/${sanitizeKey(src)}`,
      Key: sanitizeKey(dst),
    };

    try {
      // write to s3 and r2 (mirror) in parallel
      await this.sendToS3andR2(CopyObjectCommand, input);
      this.log.info(`object copied from ${input.CopySource} to: ${input.Bucket}/${input.Key}`);
    } catch (e) {
      /* c8 ignore next 3 */
      if (e.Code !== 'NoSuchKey') {
        throw e;
      }
      const e2 = new Error(`source does not exist: ${input.CopySource}`);
      e2.status = 404;
      throw e2;
    }
  }

  /**
   * Move an object in the same bucket.
   *
   * @param {string} src source key
   * @param {string} dst destination key
   * @returns {Promise<void>}
   */
  async move(src, dest) {
    await this.copy(src, dest);
    await this.remove(src);
  }

  /**
   * Remove object(s)
   *
   * @param {string|string[]} path source key(s)
   * @returns result obtained from S3
   */
  async remove(path) {
    if (Array.isArray(path)) {
      const input = {
        Bucket: this.bucket,
        Delete: {
          Objects: path.map((p) => ({ Key: sanitizeKey(p) })),
        },
      };
      // delete on s3 and r2 (mirror) in parallel
      try {
        const result = await this.sendToS3andR2(DeleteObjectsCommand, input);
        this.log.info(`${result.Deleted?.length} objects deleted from bucket ${input.Bucket}.`);
        return result;
      } catch (e) {
        const msg = `removing ${input.Delete.length} objects from bucket ${input.Bucket} failed: ${e.message}`;
        this.log.error(msg);
        const e2 = new Error(msg);
        e2.status = e.$metadata.httpStatusCode;
        throw e2;
      }
    }

    const input = {
      Bucket: this.bucket,
      Key: sanitizeKey(path),
    };
    // delete on s3 and r2 (mirror) in parallel
    try {
      const result = await this.sendToS3andR2(DeleteObjectCommand, input);
      this.log.info(`object deleted: ${input.Bucket}/${input.Key}`);
      return result;
    } catch (e) {
      const msg = `removing ${input.Bucket}/${input.Key} from storage failed: ${e.message}`;
      this.log.error(msg);
      const e2 = new Error(msg);
      e2.status = e.$metadata.httpStatusCode;
      throw e2;
    }
  }

  /**
   * Returns a list of object below the given prefix
   * @param {string} prefix
   * @param {{ limit?: number, byteLimit?: number, startAfter?: string }} [options]
   * @returns {Promise<{ isTruncated: boolean; objects: ObjectInfo[] }>}
   */
  async list(prefix, { limit, byteLimit, startAfter } = { limit: Infinity }) {
    let ContinuationToken;
    let truncated = false;
    const objects = [];
    let totalBytes = 0;
    do {
      /** @type {import('@aws-sdk/client-s3').ListObjectsV2CommandOutput} */
      // eslint-disable-next-line no-await-in-loop
      const result = await this.client.send(new ListObjectsV2Command({
        StartAfter: startAfter && !truncated ? `${prefix}${startAfter}` : undefined,
        Bucket: this.bucket,
        ContinuationToken,
        Prefix: prefix,
        MaxKeys: limit === Infinity ? 1000 : limit,
      }));
      ContinuationToken = result.IsTruncated ? result.NextContinuationToken : '';
      for (const content of (result.Contents || [])) {
        const key = content.Key;
        objects.push({
          key,
          lastModified: content.LastModified,
          contentLength: content.Size,
          contentType: mime.getType(key),
          path: `${key.substring(prefix.length)}`,
        });
        if (objects.length >= limit) {
          this.log.debug(`reached limit of ${limit} objects, stopping list (${totalBytes} bytes)`);
          truncated = true;
          break;
        }
        totalBytes += content.Size;
        if (byteLimit && totalBytes > byteLimit) {
          this.log.debug(`reached limit of ${byteLimit} bytes, stopping list (${objects.length} objects)`);
          truncated = true;
          break;
        }
      }
    } while (ContinuationToken && objects.length < limit && totalBytes < byteLimit);
    return {
      objects,
      isTruncated: truncated || !!ContinuationToken,
    };
  }

  /**
   * List folders, return array of folder names
   * @param {string} prefix
   * @param {{ limit?: number; start?: string; filter?: string; }} [options]
   * @returns {Promise<{ next?: string; folders: string[] }>}
   */
  async listFolders(prefix, { limit, start, filter } = {}) {
    limit = limit || Infinity;
    let ContinuationToken = start;
    const folders = [];
    do {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        ContinuationToken,
        Prefix: prefix,
        Delimiter: '/',
        MaxKeys: limit === Infinity ? 1000 : limit,
      }));
      ContinuationToken = result.IsTruncated ? result.NextContinuationToken : '';
      (result.CommonPrefixes || []).forEach(({ Prefix }) => {
        if (!filter || Prefix.includes(filter)) {
          folders.push(Prefix);
        }
      });
    } while (ContinuationToken && folders.length < limit);
    return {
      folders,
      next: ContinuationToken || undefined,
    };
  }
}

/**
 * The Helix Storage provides a factory for simplified bucket operations to S3 and R2
 */
export class HelixStorage {
  /**
   * @param {UniversalContext} context
   * @returns {HelixStorage}
   */
  static fromContext(context) {
    if (!context.attributes.storage) {
      const {
        // REGION: region,
        // AWS_ACCESS_KEY_ID: accessKeyId,
        // AWS_SECRET_ACCESS_KEY: secretAccessKey,
        // AWS_SESSION_TOKEN: sessionToken,
        HELIX_HTTP_CONNECTION_TIMEOUT: connectionTimeout = 5000,
        HELIX_HTTP_SOCKET_TIMEOUT: socketTimeout = 15000,
      } = context.env;

      context.attributes.storage = new HelixStorage({
        // region,
        // accessKeyId,
        // secretAccessKey,
        // sessionToken,
        connectionTimeout,
        socketTimeout,
        log: context.log,
      });
    }
    return context.attributes.storage;
  }

  static AWS_S3_SYSTEM_HEADERS = {
    'content-type': 'ContentType',
    'content-disposition': 'ContentDisposition',
    'content-encoding': 'ContentEncoding',
    'content-language': 'ContentLanguage',
  };

  /** @type {string} */
  logBucketName = 'helix-rum-logs';

  /** @type {string} */
  cloudflareLogBucketName = 'helix-rum-logs-cloudflare';

  /** @type {string} */
  bundleBucketName = 'helix-rum-bundles';

  /** @type {string} */
  usersBucketName = 'helix-rum-users';

  /**
   * Create an instance
   *
   * @param {{
   *  region?: string;
   *  accessKeyId?: string;
   *  secretAccessKey?: string;
   *  sessionToken?: string;
   *  log?: import('@adobe/helix-universal').Logger;
   *  logBucket?: string;
   *  bundleBucket?: string;
   *  usersBucket?: string;
   *  connectionTimeout?: number|string;
   *  socketTimeout?: number|string;
   * }} [opts] options
   */
  constructor(opts = {}) {
    const {
      region,
      accessKeyId,
      secretAccessKey,
      connectionTimeout,
      socketTimeout,
      logBucket,
      bundleBucket,
      sessionToken,
      usersBucket,
      log = console,
    } = opts;

    if (logBucket) {
      log.debug('Using log bucket', logBucket);
      this.logBucketName = logBucket;
    }
    if (bundleBucket) {
      log.debug('Using bundle bucket', bundleBucket);
      this.bundleBucketName = bundleBucket;
    }
    if (usersBucket) {
      log.debug('Using users bucket', usersBucket);
      this.usersBucketName = usersBucket;
    }

    if (region && accessKeyId && secretAccessKey) {
      log.debug('Creating S3Client with credentials', region, accessKeyId, secretAccessKey);
      this._s3 = new S3Client({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
          sessionToken,
        },
        requestHandler: new NodeHttpHandler({
          httpsAgent: new Agent({
            keepAlive: true,
          }),
          connectionTimeout,
          socketTimeout,
        }),
      });
    } else {
      log.debug('Creating S3Client without credentials');
      this._s3 = new S3Client({
        requestHandler: new NodeHttpHandler({
          httpsAgent: new Agent({
            keepAlive: true,
          }),
          connectionTimeout,
          socketTimeout,
        }),
      });
    }
    this._log = log;
  }

  s3() {
    return this._s3;
  }

  get logBucket() {
    return this.bucket(this.logBucketName);
  }

  get cloudflareLogBucket() {
    return this.bucket(this.cloudflareLogBucketName);
  }

  get bundleBucket() {
    return this.bucket(this.bundleBucketName);
  }

  get usersBucket() {
    return this.bucket(this.usersBucketName);
  }

  /**
   * creates a bucket instance that allows to perform storage related operations.
   * @param bucketId
   * @returns {Bucket}
   */
  bucket(bucketId) {
    if (!this._s3) {
      throw new Error('storage already closed.');
    }
    if (!bucketId) {
      throw new Error('bucketId is required.');
    }
    return new Bucket({
      bucketId,
      s3: this._s3,
      // r2: this._r2,
      log: this._log,
    });
  }

  /**
   * Close this storage. Destroys the S3 client used.
   */
  close() {
    this._s3?.destroy();
    this._r2?.destroy();
    delete this._s3;
    delete this._r2;
  }
}
