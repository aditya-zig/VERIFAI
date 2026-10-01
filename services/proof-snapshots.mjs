import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

// Fingerprint of the terminal inputs that decide proof bytes. Unchanged
// terminal state must not rewrite the bundle. Any repair/browser change
// yields a new fingerprint, so a fresh descriptor makes old approval stale.
export function proofFingerprint({ audit, repair, browser } = {}) {
  const payload = canonical({
    run: { id: audit?.id, status: audit?.status, startedAt: audit?.startedAt, finishedAt: audit?.finishedAt, durationMs: audit?.durationMs, failedStage: audit?.failedStage, error: audit?.error, stages: audit?.stages },
    repository: audit?.repository,
    finding: audit?.finding,
    specialists: audit?.specialists,
    execution: audit?.execution,
    browser: browser || null,
    repair: repair || null,
    cleanup: audit?.cleanup,
    model: audit?.model,
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
