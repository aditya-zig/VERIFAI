import {createHmac, timingSafeEqual} from 'node:crypto';

const TOOL_CAPABILITIES = Object.freeze({
  repo_read: 'repository:read',
  repo_tree: 'repository:read',
  bounded_execution: 'execution:bounded',
  browser_journey: 'browser:run',
  repair_candidate: 'repair:write',
  artifact_handoff: 'artifact:write',
});

function b64(value) {
  return Buffer.from(value).toString('base64url');
}

function unb64(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('runtime scope secret must be at least 32 characters');
}

export function issueRuntimeScope({
  secret,
  runId,
  workerId = 'trueforge-runtime',
  repository,
  capabilities = [],
  maxToolCalls = 8,
  repairAuthorized = false,
  ttlMs = 120000,
  now = Date.now(),
} = {}) {
  assertSecret(secret);
  if (typeof runId !== 'string' || !runId) throw new Error('runId is required');
  if (!repository?.fullName || !repository?.commit) throw new Error('exact repository identity is required');
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 64) throw new Error('maxToolCalls must be between 1 and 64');
  const payload = {
    v: 1,
    runId,
    workerId,
    repository: {fullName: repository.fullName, commit: repository.commit},
    capabilities: [...new Set(capabilities)].sort(),
    maxToolCalls,
    repairAuthorized: repairAuthorized === true,
    exp: now + Math.max(1000, Math.min(ttlMs, 20 * 60 * 1000)),
  };
  const encoded = b64(JSON.stringify(payload));
  return encoded + '.' + sign(encoded, secret);
}

export function verifyRuntimeScope(token, secret, now = Date.now()) {
  assertSecret(secret);
  if (typeof token !== 'string' || !token.includes('.')) throw new Error('invalid runtime scope token');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid runtime scope token');
  const encoded = parts[0];
  const signature = parts[1];
  const expected = sign(encoded, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('invalid runtime scope signature');
  const payload = JSON.parse(unb64(encoded));
  if (payload?.v !== 1 || typeof payload?.exp !== 'number') throw new Error('invalid runtime scope payload');
  if (now > payload.exp) throw new Error('runtime scope expired');
  return payload;
}

export function createScopedToolGate({secret, token, state = {calls: 0}} = {}) {
  const scope = verifyRuntimeScope(token, secret);
  return {
    scope: structuredClone(scope),
    authorize(toolName, request = {}) {
      const capability = TOOL_CAPABILITIES[toolName];
      if (!capability) throw new Error('tool not in VERIFAI runtime scope');
      if (!scope.capabilities.includes(capability)) throw new Error('tool capability not authorized');
      if (request.runId && request.runId !== scope.runId) throw new Error('runId scope mismatch');
      if (request.repository?.fullName && request.repository.fullName !== scope.repository.fullName) {
        throw new Error('repository scope mismatch');
      }
      if (request.repository?.commit && request.repository.commit !== scope.repository.commit) {
        throw new Error('repository commit scope mismatch');
      }
      if (toolName === 'repair_candidate' && scope.repairAuthorized !== true) {
        throw new Error('repair mutation not authorized');
      }
      state.calls += 1;
      if (state.calls > scope.maxToolCalls) throw new Error('runtime tool-call limit exceeded');
      return {
        runId: scope.runId,
        workerId: scope.workerId,
        repository: structuredClone(scope.repository),
        capability,
        call: state.calls,
      };
    },
  };
}

export const scopedRuntimeTools = Object.freeze(Object.keys(TOOL_CAPABILITIES));
