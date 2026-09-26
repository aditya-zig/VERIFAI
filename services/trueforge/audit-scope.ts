import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  assertAgentWorkerLaunchBrief,
  type AgentWorkerLaunchBrief,
} from '../../packages/contracts/src/index.js';

interface AuditScopeEnvelope {
  v: 1;
  aud: 'verifiai-audit-tools';
  iat: number;
  exp: number;
  brief: AgentWorkerLaunchBrief;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function resolveAuditScopeSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.VERIFIAI_TRUEFORGE_MCP_SCOPE_SECRET ?? env.VERIFIAI_STATE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('VERIFIAI_TRUEFORGE_MCP_SCOPE_SECRET (or VERIFIAI_STATE_SECRET) must be at least 32 characters');
  }
  return secret;
}

export function signAuditScope(
  brief: AgentWorkerLaunchBrief,
  secret: string,
  ttlMs = Math.min(20 * 60_000, Math.max(60_000, brief.constraints.timeoutMs + 60_000)),
  now = Date.now(),
): string {
  assertAgentWorkerLaunchBrief(brief);
  if (secret.length < 32) throw new Error('audit scope secret must be at least 32 characters');
  const envelope: AuditScopeEnvelope = {
    v: 1,
    aud: 'verifiai-audit-tools',
    iat: now,
    exp: now + ttlMs,
    brief,
  };
  const payload = encode(JSON.stringify(envelope));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyAuditScope(
  token: string,
  secret: string,
  now = Date.now(),
): AgentWorkerLaunchBrief {
  if (secret.length < 32) throw new Error('audit scope secret must be at least 32 characters');
  const [payload, providedSignature, ...rest] = token.split('.');
  if (!payload || !providedSignature || rest.length) throw new Error('invalid audit scope token');

  const expected = Buffer.from(signature(payload, secret));
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error('invalid audit scope signature');
  }

  let envelope: AuditScopeEnvelope;
  try {
    envelope = JSON.parse(decode(payload)) as AuditScopeEnvelope;
  } catch {
    throw new Error('invalid audit scope payload');
  }
  if (envelope?.v !== 1 || envelope?.aud !== 'verifiai-audit-tools') throw new Error('invalid audit scope audience');
  if (!Number.isFinite(envelope.iat) || !Number.isFinite(envelope.exp)) throw new Error('invalid audit scope timestamps');
  if (envelope.exp < now) throw new Error('audit scope token expired');
  if (envelope.iat > now + 30_000) throw new Error('audit scope token issued in the future');
  assertAgentWorkerLaunchBrief(envelope.brief);
  return envelope.brief;
}
