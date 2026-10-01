import test from 'node:test';
import assert from 'node:assert/strict';

// Fix 3: central trusted failure assessment, no duplication or truncation.
test('finding module exposes only the central failure assessment', async () => {
  const mod = await import('../services/finding-evidence.mjs');
  assert.ok(!('isExecutedSuccess' in mod), 'dead isExecutedSuccess must be removed');
  assert.equal(typeof mod.isExecutedFailure, 'function');
});

test('explicit executed:false rejects admission even when sandboxStarted says true', async () => {
  const { repairAdmissionForAudit } = await import('../services/finding-evidence.mjs');
  const audit = { id: 'a', repository: { fullName: 'owner/repo', commit: 'abc123' }, selectedCommand: 'node --check broken.js', finding: { title: 't', severity: 'info', description: 'd', evidence: { file: 'broken.js' } }, execution: { status: 'Failed', exitCode: 1, command: 'node --check broken.js', executed: false, sandbox: { started: true, name: 's', removed: true } } };
  assert.equal(repairAdmissionForAudit(audit).eligible, false);
});

test('admission requires a nonempty exact command matching selectedCommand', async () => {
  const { repairAdmissionForAudit } = await import('../services/finding-evidence.mjs');
  const base = { id: 'a', repository: { fullName: 'owner/repo', commit: 'abc123' }, finding: { title: 't', severity: 'info', description: 'd', evidence: { file: 'broken.js' } } };
  for (const execution of [{ status: 'Failed', exitCode: 1, sandbox: { started: true } }, { status: 'Failed', exitCode: 1, command: '', sandbox: { started: true } }, { status: 'Failed', exitCode: 1, command: 'node --check other.js', sandbox: { started: true } }]) {
    const audit = { ...base, selectedCommand: 'node --check broken.js', execution };
    assert.equal(repairAdmissionForAudit(audit).eligible, false, JSON.stringify(execution));
  }
});

test('repair admission never clones on inconsistent command evidence', async () => {
  const { LocalRepairService } = await import('../services/local-repair-service.mjs');
  let clones = 0;
  const audit = { id: 'a', repository: { fullName: 'owner/repo', commit: 'abc123' }, selectedCommand: 'node --check broken.js', finding: { title: 't', severity: 'info', description: 'd', evidence: { file: 'broken.js' } }, execution: { status: 'Failed', exitCode: 1, command: 'node --check other.js', sandbox: { started: true, name: 's', removed: true } } };
  const service = new LocalRepairService({ async clone() { clones++; } }, { get: () => audit });
  await assert.rejects(service.repair('a', { files: [] }), /command/i);
  assert.equal(clones, 0);
});

test('model descriptions containing evidence-like prose are preserved verbatim', async () => {
  const { repairAdmissionForAudit, composeFinding } = await import('../services/finding-evidence.mjs');
  const description = 'Root cause analysis.\n\nExecuted evidence: this is model prose, not server bytes.';
  const out = composeFinding({ modelFinding: { title: 't', severity: 'info', description, evidence: { file: 'broken.js' } }, execution: { status: 'Failed', exitCode: 1, command: 'node --check broken.js', sandbox: { started: true, name: 's', removed: true } }, selectedCommand: 'node --check broken.js', repository: { fullName: 'owner/repo', commit: 'abc123' } });
  assert.equal(out.description, description);
  const audit = { id: 'a', repository: { fullName: 'owner/repo', commit: 'abc123' }, selectedCommand: 'node --check broken.js', finding: { title: 't', severity: 'info', description, evidence: { file: 'broken.js' } }, execution: { status: 'Failed', exitCode: 1, command: 'node --check broken.js', sandbox: { started: true, name: 's', removed: true } } };
  assert.equal(repairAdmissionForAudit(audit).composed.description, description);
});

// Fix 4: consistent verification statuses.
test('BEFORE Completed with nonzero exit can never verify', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runRepairVerification } = await import('../services/local-repair-verification.mjs');
  const root = await mkdtemp(join(tmpdir(), 'verifai-fix4-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'broken.js'), 'export const value = false;\n');
  const result = await runRepairVerification({ workspacePath: root, finding: { status: 'Confirmed' }, patch: { files: [{ path: 'broken.js', expected: 'value = false', replacement: 'value = true' }] }, verify: async () => ({ status: 'Completed', executed: true, exitCode: 1, command: 'check' }), timeoutMs: 500 });
  assert.notEqual(result.verdict, 'VerifiedRepair');
});

test('AFTER Failed with zero exit can never verify', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runRepairVerification } = await import('../services/local-repair-verification.mjs');
  const root = await mkdtemp(join(tmpdir(), 'verifai-fix4b-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'broken.js'), 'export const value = false;\n');
  let calls = 0;
  const result = await runRepairVerification({ workspacePath: root, finding: { status: 'Confirmed' }, patch: { files: [{ path: 'broken.js', expected: 'value = false', replacement: 'value = true' }] }, verify: async () => { calls++; return calls === 1 ? { status: 'Failed', executed: true, exitCode: 1, command: 'check' } : { status: 'Failed', executed: true, exitCode: 0, command: 'check' }; }, timeoutMs: 500 });
  assert.notEqual(result.verdict, 'VerifiedRepair');
});

test('verifiedTarget without execution provenance is rejected', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runRepairVerification } = await import('../services/local-repair-verification.mjs');
  const root = await mkdtemp(join(tmpdir(), 'verifai-fix4c-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'broken.js'), 'export const value = false;\n');
  const result = await runRepairVerification({ workspacePath: root, finding: { findingState: 'Unconfirmed', verifiedTarget: { status: 'Failed', exitCode: 1, command: 'check' } }, patch: { files: [{ path: 'broken.js', expected: 'false', replacement: 'true' }] }, verify: async () => ({ status: 'Failed', executed: true, exitCode: 1, command: 'check' }), timeoutMs: 500 });
  assert.notEqual(result.verdict, 'VerifiedRepair');
  assert.match(result.error || '', /provenance|failure required/i);
});

test('inconsistent verification statuses cannot reach a transport', async () => {
  const { createHash } = await import('node:crypto');
  const { createVerifiedRepairPullRequest, issuePrApproval } = await import('../services/verified-repair-pr.mjs');
  const secret = '0123456789abcdef0123456789abcdef';
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const patch = { files: [{ path: 'x', expected: 'a', replacement: 'b' }] };
  const proof = { manifest: { id: 'proof:r:manifest', sha256: 'a'.repeat(64) }, artifacts: ['run', 'repository', 'repair', 'repair-diff', 'before-verification', 'after-verification', 'regressions'].map((n, i) => ({ name: n, status: 'Present', path: `${n}.json`, sha256: String(i + 1).repeat(64).slice(0, 64) })) };
  for (const repair of [
    { verdict: 'VerifiedRepair', verifiedBaseCommitSha: 'abcdef1234567890', patch, patchDigest: hash(JSON.stringify(patch)), changedFiles: [{ path: 'x', beforeHash: hash('a'), afterHash: hash('b') }], before: { status: 'Completed', executed: true, exitCode: 1, command: 'c' }, after: { status: 'Completed', executed: true, exitCode: 0, command: 'c' }, regressions: [], originalUnchanged: true, cleanup: { candidateRemoved: true } },
    { verdict: 'VerifiedRepair', verifiedBaseCommitSha: 'abcdef1234567890', patch, patchDigest: hash(JSON.stringify(patch)), changedFiles: [{ path: 'x', beforeHash: hash('a'), afterHash: hash('b') }], before: { status: 'Failed', executed: true, exitCode: 1, command: 'c' }, after: { status: 'Failed', executed: true, exitCode: 0, command: 'c' }, regressions: [], originalUnchanged: true, cleanup: { candidateRemoved: true } },
  ]) {
    const calls = [];
    const transport = { async verifyRemoteBase() { calls.push('base'); }, async createBranch() { return {}; }, async commitVerifiedPatch() { return { commitSha: 's' }; }, async pushBranch() {}, async openPullRequest() { return { number: 1 }; } };
    await assert.rejects(createVerifiedRepairPullRequest({ transport, repository: 'owner/repo', baseBranch: 'main', runId: 'r', finding: { title: 't' }, repair, proof, approvalToken: 'x', approvalSecret: secret }), /BEFORE|AFTER|status/i);
    assert.deepEqual(calls, []);
  }
});

// Fix 5: snapshot inputs on entry.
test('mutating caller input during publication cannot poison the fingerprint cache', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { LocalArtifactService } = await import('../services/local-artifact-service.mjs');
  const root = await mkdtemp(join(tmpdir(), 'verifai-fix5-')); t.after(() => rm(root, { recursive: true, force: true }));
  const audit = { id: 'run-snap', status: 'Completed', stages: {}, repository: { fullName: 'owner/repo', commit: 'abc' }, finding: { title: 'original title', severity: 'info', description: 'd', evidence: { file: 'README.md' } }, execution: { status: 'Completed', exitCode: 0, command: 'node --version', stdout: 'v', stderr: '', sandbox: { started: true, name: 's', removed: true } }, cleanup: {}, model: { provider: 'stub', model: 'm' } };
  const browser = { status: 'Completed', screenshotRefs: ['/shot-during-publish.png'] };
  const service = new LocalArtifactService({ env: { VERIFIAI_ARTIFACT_DIR: root }, screenshotResolver: async () => { audit.finding.title = 'MUTATED DURING PUBLICATION'; await new Promise((r) => setTimeout(r, 20)); return undefined; } });
  const first = await service.getOrPublish(audit, { browser });
  const stored = JSON.parse(await readFile(join(root, 'run-snap', 'finding.json'), 'utf8'));
  assert.equal(stored.title, 'original title');
  assert.equal(audit.finding.title, 'MUTATED DURING PUBLICATION');
  const second = await service.getOrPublish(audit, { browser });
  assert.notEqual(second.manifest.sha256, first.manifest.sha256);
});

// Fix 6: failed replacement preserves the previous good bundle.
test('failed publication preserves old valid downloads and proof hash', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { LocalArtifactService } = await import('../services/local-artifact-service.mjs');
  const root = await mkdtemp(join(tmpdir(), 'verifai-fix6-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalArtifactService({ env: { VERIFIAI_ARTIFACT_DIR: root } });
  const good = { id: 'run-rollback', status: 'Completed', stages: {}, repository: { fullName: 'owner/repo', commit: 'abc' }, finding: { title: 'f', severity: 'info', description: 'd', evidence: { file: 'README.md' } }, execution: { status: 'Completed', exitCode: 0, command: 'node --version', stdout: 'v', stderr: '', sandbox: { started: true, name: 's', removed: true } }, cleanup: {}, model: { provider: 'stub', model: 'm' } };
  const first = await service.getOrPublish(good, {});
  const bad = { ...structuredClone(good), stages: { boom: { status: 'Completed', detail: 'y'.repeat(60 * 1024 * 1024) } } };
  await assert.rejects(service.getOrPublish(bad, {}), /exceed/i);
  const current = service.get('run-rollback');
  assert.equal(current.manifest.sha256, first.manifest.sha256);
  const { buffer, item } = await service.read('run-rollback', 'run.json');
  assert.ok(buffer.length > 0);
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(buffer).digest('hex'), item.sha256);
});

// Fix 7: replay label only with authoritative coverage.
test('PR body labels replay only with authoritative coverage metadata', async () => {
  const { createHash } = await import('node:crypto');
  const { createVerifiedRepairPullRequest, issuePrApproval } = await import('../services/verified-repair-pr.mjs');
  const secret = '0123456789abcdef0123456789abcdef';
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const patch = { files: [{ path: 'x', expected: 'a', replacement: 'b' }] };
  const proof = { manifest: { id: 'proof:r:manifest', sha256: 'a'.repeat(64) }, artifacts: ['run', 'repository', 'repair', 'repair-diff', 'before-verification', 'after-verification', 'regressions'].map((n, i) => ({ name: n, status: 'Present', path: `${n}.json`, sha256: String(i + 1).repeat(64).slice(0, 64) })) };
  const baseRepair = { verdict: 'VerifiedRepair', verifiedBaseCommitSha: 'abcdef1234567890', patch, patchDigest: hash(JSON.stringify(patch)), changedFiles: [{ path: 'x', beforeHash: hash('a'), afterHash: hash('b') }], before: { status: 'Failed', executed: true, exitCode: 1, command: 'check-one' }, after: { status: 'Completed', executed: true, exitCode: 0, command: 'check-one' }, regressions: [{ status: 'Completed', executed: true, exitCode: 0, command: 'check-two' }], originalUnchanged: true, cleanup: { candidateRemoved: true } };
  const bodies = [];
  const transportFor = () => ({ async verifyRemoteBase() {}, async createBranch() {}, async commitVerifiedPatch() { return { commitSha: 's' }; }, async pushBranch() {}, async openPullRequest(input) { bodies.push(input.body); return { number: 1, url: 'https://example.test/1' }; } });
  const withReplay = { ...structuredClone(baseRepair), coverage: { kind: 'same-command-replay', label: 'SAME-COMMAND REPLAY / limited coverage' }, verifiedTarget: { command: 'check-one', exitCode: 1 }, modelHypothesis: { title: 'Model claim' } };
  const tokenA = issuePrApproval({ secret, runId: 'r', repository: 'owner/repo', baseBranch: 'main', repair: withReplay, proof });
  await createVerifiedRepairPullRequest({ transport: transportFor(), repository: 'owner/repo', baseBranch: 'main', runId: 'r', finding: { title: 'Model claim' }, repair: withReplay, proof, approvalToken: tokenA, approvalSecret: secret });
  assert.match(bodies[0], /SAME-COMMAND REPLAY/);
  assert.match(bodies[0], /Unconfirmed/);
  const generic = structuredClone(baseRepair);
  const tokenB = issuePrApproval({ secret, runId: 'r', repository: 'owner/repo', baseBranch: 'main', repair: generic, proof });
  await createVerifiedRepairPullRequest({ transport: transportFor(), repository: 'owner/repo', baseBranch: 'main', runId: 'r', finding: { title: 'Model claim' }, repair: generic, proof, approvalToken: tokenB, approvalSecret: secret });
  assert.doesNotMatch(bodies[1], /SAME-COMMAND REPLAY/);
  assert.match(bodies[1], /Unconfirmed/);
});
