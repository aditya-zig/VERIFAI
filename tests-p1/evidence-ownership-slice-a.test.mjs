import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFinding, isExecutedFailure, describeRegressionCoverage } from '../services/finding-evidence.mjs';

function modelFinding() {
  return { title: 'Arbitrary allegation', severity: 'high', description: 'Model claims tests are broken.', evidence: { file: 'README.md' } };
}
function readmeSuccess() {
  return { status: 'Completed', exitCode: 0, command: 'git -c core.fsmonitor=false ls-files --error-unmatch -- README.md', stdout: 'README.md\n', stderr: '', durationMs: 5, sandbox: { started: true, name: 's', removed: true }, source: 'tracked README check (not a test suite)' };
}
function readmeFailure() {
  return { ...readmeSuccess(), status: 'Failed', exitCode: 1, stderr: 'error: pathspec' };
}

test('unrelated successful tracked-README evidence does not confirm arbitrary allegation', () => {
  const out = composeFinding({ modelFinding: modelFinding(), execution: readmeSuccess(), selectedCommand: 'git -c core.fsmonitor=false ls-files --error-unmatch -- README.md', repository: { fullName: 'owner/repo', commit: 'abc123' } });
  assert.equal(out.assessment.findingState, 'Unconfirmed');
  assert.equal(out.assessment.canAdmitRepair, false);
  assert.match(out.assessment.scope, /not a test suite/i);
});

test('unrelated executed failure does not confirm allegation either, but admits command-scoped repair', () => {
  const out = composeFinding({ modelFinding: modelFinding(), execution: readmeFailure(), selectedCommand: readmeFailure().command, repository: { fullName: 'owner/repo', commit: 'abc123' } });
  assert.equal(out.assessment.findingState, 'Unconfirmed');
  assert.equal(out.assessment.canAdmitRepair, true);
  assert.equal(out.verifiedTarget.command, readmeFailure().command);
  assert.equal(out.verifiedTarget.exitCode, 1);
});

test('missing/unstarted/invalid evidence never admits repair', () => {
  for (const execution of [undefined, null, { status: 'Incomplete', exitCode: null, sandbox: { started: false } }, { status: 'Failed', exitCode: undefined, sandbox: { started: true } }, { status: 'Failed', exitCode: 1.5, sandbox: { started: true } }, { status: 'Failed', exitCode: 1, sandbox: { started: false } }, { status: 'Completed', exitCode: 1, sandbox: { started: true } }]) {
    const out = composeFinding({ modelFinding: modelFinding(), execution, selectedCommand: 'node --check broken.js', repository: { fullName: 'owner/repo', commit: 'abc123' } });
    assert.equal(out.assessment.canAdmitRepair, false, JSON.stringify(execution));
    assert.equal(isExecutedFailure(execution), false);
  }
});

test('model description is preserved verbatim and executed evidence is structural', () => {
  const mf = modelFinding();
  const out = composeFinding({ modelFinding: mf, execution: readmeSuccess(), selectedCommand: readmeSuccess().command, repository: { fullName: 'owner/repo', commit: 'abc123' } });
  assert.equal(out.description, mf.description);
  assert.equal(out.title, mf.title);
  assert.equal(out.hypothesis.description, mf.description);
  assert.ok(out.evidence.execution);
  assert.doesNotMatch(out.description, /Executed evidence/);
});

test('verification coverage correctly identifies same-command replay', () => {
  const cov = describeRegressionCoverage({ count: 1, command: 'node --check broken.js' });
  assert.match(cov.label, /SAME-COMMAND REPLAY/i);
  assert.match(cov.label, /limited coverage/i);
  assert.equal(cov.kind, 'same-command-replay');
});

test('repair admits only strict executed failure and records replay coverage with separate hypothesis', async () => {
  const { LocalRepairService } = await import('../services/local-repair-service.mjs');
  const audit = { id: 'a', repository: { fullName: 'owner/repo', commit: 'abc123' }, finding: { title: 'Model allegation', severity: 'high', description: 'Model text.', evidence: { file: 'broken.js' } }, execution: { status: 'Failed', exitCode: 1, command: 'node --check broken.js', sandbox: { started: true, name: 's', removed: true } }, selectedCommand: 'node --check broken.js' };
  const record = { id: 'r', repository: { fullName: 'owner/repo', commit: 'abc123' }, clone: { workspacePath: '/tmp/fake' }, files: { items: ['broken.js'] } };
  let runInput;
  const service = new LocalRepairService({ async clone() { return record; }, async cleanup() {} }, { get: () => audit }, {
    select: async () => ({ executable: 'node', args: ['--check', 'broken.js'], source: 'fixture' }),
    execute: async () => ({ status: 'Failed', exitCode: 1, sandbox: { started: true } }),
    runRepair: async (input) => { runInput = input; return { verdict: 'VerifiedRepair', cleanup: { candidateRemoved: true } }; },
  });
  const result = await service.repair('a', { files: [{ path: 'broken.js', expected: 'x', replacement: 'y' }] });
  assert.equal(result.coverage.kind, 'same-command-replay');
  assert.match(result.coverage.label, /SAME-COMMAND REPLAY/);
  assert.equal(result.modelHypothesis.title, 'Model allegation');
  assert.equal(result.verifiedTarget.command, 'node --check broken.js');
  assert.equal(runInput.finding.findingState, 'Unconfirmed');
  assert.equal(runInput.finding.verifiedTarget.exitCode, 1);
});

test('unstarted sandbox evidence cannot clone for repair', async () => {
  const { LocalRepairService } = await import('../services/local-repair-service.mjs');
  let clones = 0;
  const audit = { id: 'a', repository: { fullName: 'owner/repo', commit: 'abc123' }, execution: { status: 'Failed', exitCode: 1, command: 'node --check broken.js', sandbox: { started: false } }, selectedCommand: 'node --check broken.js' };
  const service = new LocalRepairService({ async clone() { clones++; } }, { get: () => audit });
  await assert.rejects(service.repair('a', { files: [] }), /real failed execution|not admitted/i);
  assert.equal(clones, 0);
});

test('Unconfirmed hypothesis with verified executed target still runs real before-failure after-pass', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runRepairVerification } = await import('../services/local-repair-verification.mjs');
  const root = await mkdtemp(join(tmpdir(), 'verifai-slice-a-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'broken.js'), 'export const value = false;\n');
  const verify = async ({ workspacePath }) => {
    const text = await readFile(join(workspacePath, 'broken.js'), 'utf8');
    const ok = text.includes('value = true');
    return { status: ok ? 'Completed' : 'Failed', executed: true, exitCode: ok ? 0 : 1, command: 'node check', provenance: { kind: 'fixture' } };
  };
  const result = await runRepairVerification({
    workspacePath: root,
    finding: { findingState: 'Unconfirmed', modelHypothesis: { title: 'Model allegation' }, verifiedTarget: { status: 'Failed', exitCode: 1, command: 'node check', executed: true } },
    patch: { files: [{ path: 'broken.js', expected: 'value = false', replacement: 'value = true' }] },
    verify, regressions: [verify], timeoutMs: 500, baseCommitSha: 'abc123',
  });
  assert.equal(result.verdict, 'VerifiedRepair');
  assert.equal(result.verifiedBaseCommitSha, 'abc123');
  assert.ok(result.patchDigest);
});
