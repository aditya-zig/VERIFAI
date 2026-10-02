import { open } from 'node:fs/promises';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';

export class ModelCallError extends Error {
  constructor(message, category, providerUnavailable = false) {
    super(message);
    this.category = category;
    this.providerUnavailable = providerUnavailable;
  }
}

// Compatibility seam for explicitly selected single-provider callers.
export function resolveModelConfig(env = process.env) {
  const provider = env.VERIFIAI_MODEL_PROVIDER || 'xkiro';
  const defaults = readSettingsSync(new URL('../config/local-models.json', import.meta.url), env);
  const profile = defaults.providers.find(p => p.id === provider);
  if (!profile) throw new Error('Unsupported model provider');
  const model = env.VERIFIAI_MODEL_ID || profile.defaultModel;
  if (!model) throw new Error('VERIFIAI_MODEL_ID is required for this provider');
  const apiKey = env[profile.apiKeyEnv];
  if (!apiKey) throw new Error(`Model not configured: set ${profile.apiKeyEnv}`);
  const baseUrl = env.VERIFIAI_MODEL_BASE_URL || profile.baseUrl;
  const secrets = credentialValues(defaults, env);
  if (typeof model !== 'string' || !modelId.test(model) || !validBaseUrl(baseUrl)
      || secrets.some(key => model.includes(key) || baseUrl.includes(key))) throw new Error('Invalid single-provider configuration');
  const config = { provider, model, baseUrl, apiKey,
    ...(profile.authHeader !== undefined ? { authHeader: profile.authHeader } : {}),
    ...(profile.authScheme !== undefined ? { authScheme: profile.authScheme } : {}),
  };
  Object.defineProperty(config, 'secretValues', { value: secrets });
  return config;
}

const modelId = /^[A-Za-z0-9][A-Za-z0-9/_.:\-]{0,199}$/;
const stableId = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const effortValues = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
function objectWithKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}
function validParameters(p = {}) {
  if (!objectWithKeys(p, ['temperature', 'top_p', 'reasoning_effort', 'reasoning', 'chat_template_kwargs'])) return false;
  if ('temperature' in p && !(typeof p.temperature === 'number' && p.temperature >= 0 && p.temperature <= 2)) return false;
  if ('top_p' in p && !(typeof p.top_p === 'number' && p.top_p > 0 && p.top_p <= 1)) return false;
  if ('reasoning_effort' in p && !effortValues.has(p.reasoning_effort)) return false;
  if ('reasoning' in p && (!objectWithKeys(p.reasoning, ['enabled', 'effort'])
      || ('enabled' in p.reasoning && typeof p.reasoning.enabled !== 'boolean')
      || ('effort' in p.reasoning && !effortValues.has(p.reasoning.effort)))) return false;
  if ('chat_template_kwargs' in p && (!objectWithKeys(p.chat_template_kwargs,
      ['enable_thinking', 'low_effort', 'clear_thinking', 'force_nonempty_content'])
      || Object.values(p.chat_template_kwargs).some(value => typeof value !== 'boolean'))) return false;
  return true;
}
function validBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
const reservedHeaders = new Set(['host', 'content-type', 'content-length', 'transfer-encoding', 'connection',
  'cache-control', 'x-request-id', 'cookie', 'set-cookie', 'proxy-authorization', 'proxy-connection',
  'accept', 'accept-encoding', 'user-agent', 'origin', 'referer', 'upgrade', 'trailer', 'te']);
function credentialValues(settings, env) {
  return [...new Set([
    ...settings.providers.map(p => env[p.apiKeyEnv]),
    ...Object.entries(env).filter(([name]) => /(?:^|_)(?:KEY|TOKEN|SECRET)$/.test(name)).map(([, value]) => value),
  ].filter(value => typeof value === 'string' && value.length))];
}
function validateSettings(settings, env) {
  const invalid = () => { throw new Error('Invalid model routing configuration'); };
  if (!objectWithKeys(settings, ['schemaVersion', 'timeoutMs', 'attemptTimeoutMs', 'maxAttempts', 'providers', 'routes'])
      || settings.schemaVersion !== 1
      || !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1 || settings.timeoutMs > 60000
      || !Number.isInteger(settings.attemptTimeoutMs) || settings.attemptTimeoutMs < 1 || settings.attemptTimeoutMs > settings.timeoutMs
      || !Number.isInteger(settings.maxAttempts) || settings.maxAttempts < 1 || settings.maxAttempts > 5
      || !Array.isArray(settings.providers) || settings.providers.length < 1 || settings.providers.length > 32
      || !Array.isArray(settings.routes) || settings.routes.length > 32) invalid();
  const providers = new Set();
  for (const p of settings.providers) {
    if (!objectWithKeys(p, ['id', 'baseUrl', 'apiKeyEnv', 'defaultModel', 'authHeader', 'authScheme']) || typeof p.id !== 'string' || !stableId.test(p.id)
        || providers.has(p.id) || typeof p.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(p.apiKeyEnv)
        || !validBaseUrl(p.baseUrl)
        || (p.authHeader !== undefined && (typeof p.authHeader !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(p.authHeader) || reservedHeaders.has(p.authHeader)))
        || (p.authScheme !== undefined && !['Bearer', 'Token', 'Basic', ''].includes(p.authScheme))
        || (p.defaultModel !== undefined && (typeof p.defaultModel !== 'string' || !modelId.test(p.defaultModel)))) invalid();
    providers.add(p.id);
  }
  const routes = new Set();
  for (const r of settings.routes) {
    if (!objectWithKeys(r, ['id', 'provider', 'model', 'enabled', 'reportedModels', 'parameters', 'jsonMode'])
        || typeof r.id !== 'string' || !stableId.test(r.id) || routes.has(r.id) || !providers.has(r.provider)
        || typeof r.model !== 'string' || !modelId.test(r.model) || typeof r.enabled !== 'boolean'
        || (r.jsonMode !== undefined && typeof r.jsonMode !== 'boolean')
        || !validParameters(r.parameters)
        || (r.reportedModels !== undefined && (!Array.isArray(r.reportedModels) || r.reportedModels.length > 8
          || r.reportedModels.some(id => typeof id !== 'string' || !modelId.test(id))))) invalid();
    routes.add(r.id);
  }
  const secrets = credentialValues(settings, env);
  if (secrets.some(key => JSON.stringify(settings).includes(key))) invalid();
  return settings;
}
async function readSettings(path, env) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) throw new Error('not a regular file');
    const bytes = Buffer.alloc(65537);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 65536) throw new Error('configuration size bound');
    return validateSettings(JSON.parse(bytes.subarray(0, offset).toString('utf8')), env);
  } catch { throw new Error('Invalid model routing configuration'); }
  finally { await file?.close(); }
}

// The legacy exported resolver is synchronous. Its registry reader has the
// same byte bound and generic errors, rather than a native JSON import that
// could disclose invalid input in a startup parse exception.
function readSettingsSync(path, env) {
  let file;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(file).isFile()) throw new Error('not a regular file');
    const bytes = Buffer.alloc(65537);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(file, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset > 65536) throw new Error('configuration size bound');
    return validateSettings(JSON.parse(bytes.subarray(0, offset).toString('utf8')), env);
  } catch { throw new Error('Invalid model routing configuration'); }
  finally { if (file !== undefined) closeSync(file); }
}

function invokeUntilAborted(invoke, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ModelCallError('Model attempt interrupted', 'timeout', true));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(invoke).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function runModelRoutes(env, invoke, { signal } = {}) {
  const legacy = env.VERIFIAI_MODEL_PROVIDER || env.VERIFIAI_MODEL_ID || env.VERIFIAI_MODEL_BASE_URL;
  if (!env.VERIFIAI_MODEL_CONFIG && legacy) {
    const config = resolveModelConfig(env);
    try {
      const result = await invoke(config);
      if (config.secretValues.some(key => JSON.stringify(result).includes(key))) throw new ModelCallError('Model returned sensitive content', 'invalid_response');
      return result;
    } catch (caught) {
      const candidate = caught instanceof Error ? caught : new ModelCallError('Model request failed', 'internal_error');
      const error = config.secretValues.some(key => candidate.message.includes(key))
        ? new ModelCallError('Model returned sensitive content', 'invalid_response') : candidate;
      error.model = { provider: config.provider, model: config.model, calls: 1,
        attempts: [{ provider: config.provider, model: config.model,
          outcome: signal?.aborted ? 'cancelled' : error instanceof ModelCallError ? error.category : 'invalid_response',
          ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) }],
      };
      throw error;
    }
  }
  const settings = await readSettings(env.VERIFIAI_MODEL_CONFIG || new URL('../config/local-models.json', import.meta.url), env);
  const secretValues = credentialValues(settings, env);
  const attempts = [];
  const unavailable = new Set();
  let calls = 0;
  const failure = message => {
    const error = new Error(message);
    error.model = { calls, attempts };
    return error;
  };
  const budget = new AbortController();
  const deadline = performance.now() + settings.timeoutMs;
  const timer = setTimeout(() => budget.abort(), settings.timeoutMs);
  const overall = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  const checkBudget = () => {
    if (signal?.aborted) throw failure('Model routing cancelled');
    if (budget.signal.aborted || performance.now() >= deadline) {
      budget.abort();
      throw failure('Model routing deadline exceeded');
    }
  };
  try {
    for (const route of settings.routes.filter(r => r.enabled)) {
      checkBudget();
      const profile = settings.providers.find(p => p.id === route.provider);
      const row = { route: route.id, provider: route.provider, model: route.model };
      if (unavailable.has(route.provider)) { attempts.push({ ...row, outcome: 'skipped_provider_unavailable' }); continue; }
      if (!env[profile.apiKeyEnv]) { attempts.push({ ...row, outcome: 'skipped_missing_key' }); continue; }
      if (calls >= settings.maxAttempts) throw failure('Model routing attempt limit reached');
      const timeout = new AbortController();
      const attemptSignal = AbortSignal.any([overall, timeout.signal]);
      const attemptTimer = setTimeout(() => timeout.abort(), settings.attemptTimeoutMs);
      const start = performance.now();
      calls += 1;
      try {
        const result = await invokeUntilAborted(() => invoke({ ...profile, provider: route.provider, model: route.model,
          apiKey: env[profile.apiKeyEnv], secretValues, route: route.id, strictIdentity: true,
          reportedModels: [route.model, ...(route.reportedModels || [])], parameters: route.parameters, jsonMode: route.jsonMode }, { signal: attemptSignal }), attemptSignal);
        checkBudget();
        if (secretValues.some(key => JSON.stringify(result).includes(key))) {
          throw new ModelCallError('Model returned sensitive content', 'invalid_response');
        }
        checkBudget();
        if (performance.now() - start >= settings.attemptTimeoutMs) {
          timeout.abort();
          throw new ModelCallError('Model attempt deadline exceeded', 'timeout', true);
        }
        attempts.push({ ...row, outcome: 'succeeded', httpStatus: result.model.httpStatus, durationMs: Math.round(performance.now() - start) });
        return { ...result, model: { ...result.model, route: route.id, calls, attempts } };
      } catch (error) {
        const outcome = signal?.aborted ? 'cancelled' : budget.signal.aborted ? 'deadline_exceeded'
          : timeout.signal.aborted ? 'timeout' : error instanceof ModelCallError ? error.category : 'internal_error';
        attempts.push({ ...row, outcome, ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}), durationMs: Math.round(performance.now() - start) });
        checkBudget();
        if (!(error instanceof ModelCallError)) throw failure('Model routing failed');
        if (error.providerUnavailable || timeout.signal.aborted) unavailable.add(route.provider);
      } finally {
        clearTimeout(attemptTimer);
      }
    }
    throw failure('No configured model route succeeded');
  } finally {
    clearTimeout(timer);
  }
}
