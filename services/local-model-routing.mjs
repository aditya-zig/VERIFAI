import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';

export class ModelCallError extends Error {
  constructor(message, category, providerUnavailable = false) {
    super(message);
    this.category = category;
    this.providerUnavailable = providerUnavailable;
  }
}

export function resolveModelConfig(env = process.env) {
  if (env.VERIFIAI_MODEL_PROVIDER && env.VERIFIAI_MODEL_PROVIDER !== 'bedrock') {
    throw new Error('Unsupported model provider: use AWS Bedrock');
  }
  if (['VERIFIAI_MODEL_BASE_URL', 'VERIFIAI_AGENT_HARNESS', 'VERIFIAI_MODEL_SECRET_ID', 'VERIFIAI_MODEL_SECRET_FIELD'].some(name => env[name])) {
    throw new Error('AWS Bedrock uses the AWS SDK; remove retired endpoint/harness overrides');
  }
  const path = env.VERIFIAI_MODEL_CONFIG || new URL('../config/local-models.json', import.meta.url);
  let fd;
  let settings;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('configuration bound');
    const bytes = Buffer.alloc(65537);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 65536) throw new Error('configuration bound');
    settings = JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } catch { throw new Error('Invalid Bedrock model configuration'); }
  finally { if (fd !== undefined) closeSync(fd); }
  const keys = ['schemaVersion', 'modelId', 'region', 'timeoutMs', 'maxTokens'];
  if (!settings || Array.isArray(settings) || settings.schemaVersion !== 2
      || Object.keys(settings).some(key => !keys.includes(key))
      || !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1 || settings.timeoutMs > 60000
      || !Number.isInteger(settings.maxTokens) || settings.maxTokens < 1 || settings.maxTokens > 500) {
    throw new Error('Invalid Bedrock model configuration');
  }
  const model = env.VERIFIAI_BEDROCK_MODEL_ID || env.VERIFIAI_MODEL_ID || settings.modelId;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || settings.region;
  if (!model) throw new Error('VERIFIAI_BEDROCK_MODEL_ID (or VERIFIAI_MODEL_ID) is required');
  if (!region) throw new Error('AWS_REGION (or AWS_DEFAULT_REGION) is required');
  const secrets = [...new Set([
    env.AWS_ACCESS_KEY_ID,
    ...Object.entries(env).filter(([name]) => /(?:^|_)(?:KEY|TOKEN|SECRET)$/.test(name)).map(([, value]) => value),
    env.AWS_BEARER_TOKEN_BEDROCK,
  ].filter(value => typeof value === 'string' && value.length))];
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_.:\-]{0,2047}$/.test(model)
      || typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)
      || secrets.some(value => model.includes(value) || region.includes(value))) throw new Error('Invalid Bedrock model configuration');
  const config = { provider: 'bedrock', model, region, timeoutMs: settings.timeoutMs, maxTokens: settings.maxTokens };
  // Credentials stay in the AWS SDK chain, never in serializable run metadata.
  Object.defineProperty(config, 'secretValues', { value: secrets });
  return config;
}

export async function runModelRoutes(env, invoke, { signal } = {}) {
  const config = resolveModelConfig(env);
  if (signal?.aborted) throw new ModelCallError('Model routing cancelled', 'cancelled');
  try {
    const result = await invoke(config, { signal });
    if (signal?.aborted) throw new ModelCallError('Model routing cancelled', 'cancelled');
    if (config.secretValues.some(value => JSON.stringify(result).includes(value))) {
      throw new ModelCallError('Model returned sensitive content', 'invalid_response');
    }
    return result;
  } catch (caught) {
    const error = config.secretValues.some(value => String(caught?.message).includes(value))
      ? new ModelCallError('Model returned sensitive content', 'invalid_response')
      : caught instanceof Error ? caught : new ModelCallError('Bedrock model invocation unavailable', 'provider_unavailable', true);
    error.model = { provider: 'bedrock', model: config.model, region: config.region, calls: 1,
      attempts: [{ provider: 'bedrock', model: config.model, outcome: signal?.aborted ? 'cancelled' : error.category || 'invalid_response' }] };
    throw error;
  }
}
