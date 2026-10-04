import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MasterAuditService} from '../services/master-audit.mjs';

function completedExecution() {
  return {status: 'Completed', exitCode: 0, command: 'node --version', stdout: 'v22\n', stderr: '',
    sandbox: {name: 'controlled-execution', started: true, removed: true}};
}

async function auditWith(t, execution) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'verifai-master-evidence-'));
  t.after(() => rm(workspacePath, {recursive: true, force: true}));
  const repositories = {
    async clone() {
      return {id: 'repo', repository: {fullName: 'owner/repo', commit: 'abc123'},
        clone: {workspacePath}, files: {count: 1, items: ['README.md']}};
    },
    async cleanup() { await rm(workspacePath, {recursive: true, force: true}); },
  };
  // Only the external model and Docker boundaries are controlled. The audit,
  // finding policy, filesystem cleanup and final status are production code.
  const service = new MasterAuditService(repositories, {
    env: {},
    analyze: async () => ({finding: {title: 'Model hypothesis', severity: 'info', description: 'Opinion only',
      evidence: {file: 'README.md'}}, model: {provider: 'controlled', model: 'fixture'}}),
    select: async () => ({executable: 'node', args: ['--version'], source: 'fixture'}),
    execute: async () => execution,
  });
  const {id} = service.start('https://github.com/owner/repo');
  await service.waitForIdle();
  await assert.rejects(access(workspacePath), {code: 'ENOENT'});
  return service.get(id);
}

for (const [name, overrides] of [
  ['a timeout despite zero exit', {timedOut: true}],
  ['cancellation despite zero exit', {aborted: true}],
  ['an explicit unexecuted record', {executed: false}],
  ['Failed status with zero exit', {status: 'Failed'}],
  ['Completed status with nonzero exit', {exitCode: 1}],
  ['an unknown execution status', {status: 'Success'}],
  ['a missing exit code', {exitCode: undefined}],
  ['a different executed command', {command: 'node other.js'}],
  ['a missing executed command', {command: undefined}],
  ['an unstarted sandbox', {sandbox: {name: 's', started: false, removed: true}}],
]) {
  test(`master audit rejects ${name} before publishing a finding`, async (t) => {
    const execution = {...completedExecution(), ...overrides};
    const run = await auditWith(t, execution);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'execution');
    assert.equal(run.stages.execution.status, 'Incomplete');
    assert.equal(run.stages.finding.status, 'Skipped');
    assert.equal(run.finding, undefined);
    assert.equal(run.execution.command, execution.command);
    assert.ok(run.error);
  });
}

for (const removed of [false, undefined]) {
  test(`master audit requires a sandbox cleanup receipt when removed is ${removed}`, async (t) => {
    const execution = completedExecution();
    execution.sandbox.removed = removed;
    const run = await auditWith(t, execution);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'cleanup');
    assert.equal(run.stages.cleanup.status, 'Incomplete');
    assert.equal(run.cleanup.repositoryRemoved, true);
    assert.equal(run.cleanup.sandboxRemoved, false);
  });
}

test('consistent completed execution and proven cleanup still complete', async (t) => {
  const run = await auditWith(t, completedExecution());
  assert.equal(run.status, 'Completed');
  assert.equal(run.stages.execution.status, 'Completed');
  assert.equal(run.stages.cleanup.status, 'Completed');
  assert.deepEqual(run.cleanup, {repositoryRemoved: true, sandboxRemoved: true});
  assert.equal(run.finding.assessment.findingState, 'Unconfirmed');
  assert.equal(run.finding.verifiedTarget, null);
});

test('a consistent command failure keeps command-scoped evidence without completing', async (t) => {
  const run = await auditWith(t, {...completedExecution(), status: 'Failed', exitCode: 1});
  assert.equal(run.status, 'Incomplete');
  assert.equal(run.failedStage, 'execution');
  assert.equal(run.stages.execution.status, 'Failed');
  assert.equal(run.stages.finding.status, 'Completed');
  assert.equal(run.finding.assessment.findingState, 'Unconfirmed');
  assert.equal(run.finding.verifiedTarget.command, 'node --version');
  assert.equal(run.finding.verifiedTarget.exitCode, 1);
});
