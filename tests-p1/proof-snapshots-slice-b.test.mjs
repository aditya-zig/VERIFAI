import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalArtifactService } from '../services/local-artifact-service.mjs';

function audit(id = 'run-stable') {
  return { id, status: 'Completed', startedAt: 'a', finishedAt: 'b', durationMs: 1, stages: {}, repository: { fullName: 'owner/repo', commit: 'abc123' }, finding: { title: 'f', severity: 'info', description: 'd', evidence: { file: 'README.md' } }, execution: { status: 'Completed', exitCode: 0, command: 'node --version', stdout: 'v22', stderr: '', sandbox: { started: true, name: 's', removed: true } }, cleanup: { repositoryRemoved: true, sandboxRemoved: true }, model: { provider: 'stub', model: 'm' } };
}

test('first terminal publication creates a real filesystem bundle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifai-slice-b-first-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalArtifactService({ env: { VERIFIAI_ARTIFACT_DIR: root } });
  const proof = await service.getOrPublish(audit(), {});
  assert.equal(proof.runId, 'run-stable');
  assert.ok(proof.manifest.sha256);
  const manifest = JSON.parse(await readFile(join(root, 'run-stable', 'manifest.json'), 'utf8'));
  assert.equal(manifest.runId, 'run-stable');
});

test('stable unchanged repeated reads do not rewrite the bundle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifai-slice-b-stable-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalArtifactService({ env: { VERIFIAI_ARTIFACT_DIR: root } });
  const a = audit('run-repeat');
  const first = await service.getOrPublish(a, {});
  const before = await stat(join(root, 'run-repeat', 'manifest.json'));
  await new Promise((r) => setTimeout(r, 15));
  const second = await service.getOrPublish(a, {});
  const after = await stat(join(root, 'run-repeat', 'manifest.json'));
  assert.equal(second.manifest.sha256, first.manifest.sha256);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('changed repair evidence publishes fresh descriptor and stale approval is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifai-slice-b-change-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { issuePrApproval, verifyPrApproval } = await import('../services/verified-repair-pr.mjs');
  const { createHash } = await import('node:crypto');
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const service = new LocalArtifactService({ env: { VERIFIAI_ARTIFACT_DIR: root } });
  const a = audit('run-change');
  const repairA = { verdict: 'VerifiedRepair', verifiedBaseCommitSha: 'abcdef1234567890', patch: { files: [{ path: 'x', expected: 'a', replacement: 'b' }] }, patchDigest: hash(JSON.stringify({ files: [{ path: 'x', expected: 'a', replacement: 'b' }] })), changedFiles: [{ path: 'x', beforeHash: hash('a'), afterHash: hash('b') }], diff: '--- a/x\n-a\n+b\n', before: { status: 'Failed', executed: true, exitCode: 1, command: 'c' }, after: { status: 'Completed', executed: true, exitCode: 0, command: 'c' }, regressions: [{ status: 'Completed', executed: true, exitCode: 0, command: 'c' }], originalUnchanged: true, cleanup: { candidateRemoved: true } };
  const first = await service.getOrPublish(a, { repair: repairA });
  const secret = '0123456789abcdef0123456789abcdef';
  const token = issuePrApproval({ secret, runId: 'run-change', repository: 'owner/repo', baseBranch: 'main', repair: repairA, proof: { manifest: first.manifest, artifacts: first.artifacts } });
  const repairB = structuredClone(repairA);
  repairB.after = { status: 'Completed', executed: true, exitCode: 0, command: 'c', stdout: 'changed' };
  const second = await service.getOrPublish(a, { repair: repairB });
  assert.notEqual(second.manifest.sha256, first.manifest.sha256);
  await assert.rejects(async () => verifyPrApproval({ token, secret, runId: 'run-change', repository: 'owner/repo', baseBranch: 'main', repair: repairB, proof: { manifest: second.manifest, artifacts: second.artifacts } }), /stale/i);
});

test('concurrent same-run readers do not interleave and return identical descriptors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifai-slice-b-conc-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalArtifactService({ env: { VERIFIAI_ARTIFACT_DIR: root } });
  const a = audit('run-concurrent');
  const results = await Promise.all([service.getOrPublish(a, {}), service.getOrPublish(a, {}), service.getOrPublish(a, {}), service.getOrPublish(a, {})]);
  for (const r of results) assert.equal(r.manifest.sha256, results[0].manifest.sha256);
  const manifest = JSON.parse(await readFile(join(root, 'run-concurrent', 'manifest.json'), 'utf8'));
  assert.ok(manifest.artifacts.length > 0);
});

test('tampered download bytes are rejected, not returned as verified evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifai-slice-b-tamper-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalArtifactService({ env: { VERIFIAI_ARTIFACT_DIR: root } });
  await service.getOrPublish(audit('run-tamper'), {});
  await writeFile(join(root, 'run-tamper', 'run.json'), '{"tampered":true}');
  await assert.rejects(service.read('run-tamper', 'run.json'), /integrity/i);
});

test('Missing vs Present artifacts are labelled and only Present files download', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifai-slice-b-missing-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalArtifactService({ env: { VERIFIAI_ARTIFACT_DIR: root } });
  const proof = await service.getOrPublish(audit('run-missing'), { browser: { status: 'Incomplete', screenshotRefs: ['/api/local/browser-shots/missing.png'] } });
  const missing = proof.artifacts.find((x) => x.name === 'screenshot-1');
  assert.equal(missing.status, 'Missing');
  const present = proof.artifacts.find((x) => x.name === 'run');
  assert.equal(present.status, 'Present');
  const { buffer } = await service.read('run-missing', 'run.json');
  assert.ok(buffer.length > 0);
  await assert.rejects(service.read('run-missing', 'repair.diff'), /not found/i);
});
