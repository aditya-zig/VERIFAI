import test from 'node:test';
import assert from 'node:assert/strict';

export function registerRuntimeContract(label, factory, runRuntimeAudit) {
  test(label + ' successful audit preserves M5 semantic shape', async () => {
    const {provider, input} = factory('success');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Completed');
    assert.ok(run.repository?.fullName);
    assert.ok(run.repository?.commit);
    assert.equal(run.stages.execution.status, 'Completed');
    assert.equal(run.cleanup.status, 'Completed');
    assert.equal(run.finding.evidence.execution.stdout, 'ok');
    assert.notEqual(run.finding.evidence.execution.invented, true);
  });

  test(label + ' provider unavailable maps to truthful Incomplete', async () => {
    const {provider, input} = factory('provider-unavailable');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'analysis');
    assert.equal(run.failureCode, 'ProviderUnavailable');
  });

  test(label + ' command failure remains executed failure and incomplete run', async () => {
    const {provider, input} = factory('command-failure');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'execution');
    assert.equal(run.stages.execution.status, 'Failed');
    assert.equal(run.execution.exitCode, 1);
  });

  test(label + ' required browser unavailable maps to Incomplete', async () => {
    const {provider, input} = factory('browser-unavailable');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'browser');
    assert.equal(run.failureCode, 'BrowserUnavailable');
  });

  test(label + ' rejected repair never becomes verified repair', async () => {
    const {provider, input} = factory('repair-rejected');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'repair');
    assert.equal(run.repair.verdict, 'RejectedRepair');
  });

  test(label + ' missing artifact maps to Incomplete', async () => {
    const {provider, input} = factory('missing-artifact');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'artifact');
    assert.equal(run.failureCode, 'ArtifactMissing');
  });

  test(label + ' timeout maps to Incomplete timeout', async () => {
    const {provider, input} = factory('timeout');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'execution');
    assert.equal(run.failureCode, 'Timeout');
    assert.equal(run.execution.timedOut, true);
  });

  test(label + ' cancellation cannot report completion', async () => {
    const {provider, input} = factory('cancellation');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failureCode, 'Cancelled');
  });

  test(label + ' cleanup failure overrides otherwise successful work', async () => {
    const {provider, input} = factory('cleanup-failure');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'cleanup');
    assert.equal(run.failureCode, 'CleanupFailed');
    assert.equal(run.stages.cleanup.status, 'Incomplete');
  });

  test(label + ' stale approval cannot create PR', async () => {
    const {provider, input} = factory('stale-approval');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Incomplete');
    assert.equal(run.failedStage, 'approval');
    assert.equal(run.failureCode, 'StaleApproval');
    assert.equal(run.pullRequest, undefined);
  });
}
