import {
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {cloudControlKeys} from './artifact-contract.mjs';

function jsonBody(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function notFound(error) {
  return error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;
}

function precondition(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;
}

async function bodyText(body) {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) return Buffer.from(body).toString('utf8');
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export class AwsS3RunStore {
  constructor({s3, bucket, environment = 'dev'} = {}) {
    if (!s3 || typeof s3.send !== 'function') throw new Error('S3 client is required');
    if (typeof bucket !== 'string' || !bucket) throw new Error('artifact bucket is required');
    this.s3 = s3;
    this.bucket = bucket;
    this.environment = environment;
  }

  async putJson(key, value, extra = {}) {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: jsonBody(value),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
      ...extra,
    }));
  }

  async getJson(key) {
    try {
      const response = await this.s3.send(new GetObjectCommand({Bucket: this.bucket, Key: key}));
      const text = await bodyText(response.Body);
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async acquire(runId, metadata) {
    const key = cloudControlKeys(runId).lock;
    try {
      await this.putJson(key, {
        runId,
        environment: this.environment,
        createdAt: new Date().toISOString(),
        ...metadata,
      }, {IfNoneMatch: '*'});
      return {acquired: true, key};
    } catch (error) {
      if (precondition(error)) return {acquired: false, key};
      throw error;
    }
  }

  async putState(runId, state) {
    const key = cloudControlKeys(runId).state;
    await this.putJson(key, state);
    return key;
  }

  async getState(runId) {
    return this.getJson(cloudControlKeys(runId).state);
  }

  async putResult(runId, result) {
    const key = cloudControlKeys(runId).result;
    await this.putJson(key, result);
    return key;
  }

  async getResult(runId) {
    return this.getJson(cloudControlKeys(runId).result);
  }
}
