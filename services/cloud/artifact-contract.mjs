import {posix} from 'node:path';

export function assertCloudRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('runId must be a stable path-safe identifier');
  }
  return runId;
}

export function cloudRunPrefix(runId) {
  return 'runs/' + assertCloudRunId(runId) + '/';
}

export function cloudArtifactKey(runId, relativePath) {
  const prefix = cloudRunPrefix(runId);
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/')) {
    throw new Error('artifact relative path is required');
  }
  const normalized = posix.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('artifact path escapes run prefix');
  return prefix + normalized;
}

export function cloudControlKeys(runId) {
  const prefix = cloudRunPrefix(runId);
  return {
    lock: prefix + 'control/lock.json',
    state: prefix + 'control/state.json',
    result: prefix + 'control/result.json',
    manifest: prefix + 'manifest.json',
  };
}

export function assertCloudArtifactDescriptor(value, runId) {
  if (!value || typeof value !== 'object') throw new Error('cloud artifact descriptor is required');
  if (value.runId !== runId) throw new Error('artifact runId mismatch');
  if (!value.manifest?.sha256 && !value.manifestSha256) throw new Error('artifact manifest hash missing');
  if (!Array.isArray(value.artifacts)) throw new Error('artifact list missing');
  return value;
}
