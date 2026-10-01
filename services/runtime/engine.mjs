import {randomUUID} from 'node:crypto';
import {
  RuntimeIncompleteError,
  assertRuntimeResult,
  createRuntimeRun,
  finishPendingStages,
  markRuntimeStage,
} from './contract.mjs';

function message(error) {
  return String(error?.message || error || 'runtime operation failed');
}

function incomplete(stage, error, code) {
  if (error instanceof RuntimeIncompleteError) return error;
  return new RuntimeIncompleteError(stage, message(error), code);
}

function requireProvider(provider) {
  const required = ['repository', 'model', 'execute', 'cleanup'];
  for (const name of required) {
    if (typeof provider?.[name] !== 'function') throw new Error('runtime provider missing operation: ' + name);
  }
}

function artifactPresent(value) {
  return Boolean(value?.manifest?.sha256 || value?.manifestSha256 || value?.manifest?.id);
}

export async function runRuntimeAudit(provider, input = {}) {
  requireProvider(provider);
  const run = createRuntimeRun({
    runId: input.runId || randomUUID(),
    runtime: provider.name || 'unknown',
  });
  const started = performance.now();
  let record;
  let activeStage = 'clone';
  let terminal = 'Completed';

  const fail = (stage, error, code) => {
    terminal = 'Incomplete';
    run.failedStage = stage;
    run.error = message(error);
    if (code) run.failureCode = code;
  };

  try {
    input.signal?.throwIfAborted();

    activeStage = 'clone';
    markRuntimeStage(run, 'clone', 'Running');
    record = await provider.repository(input, {run, signal: input.signal});
    if (!record?.repository?.fullName || !record?.repository?.commit) {
      throw incomplete('clone', 'repository identity did not include exact commit', 'RepositoryIdentityMissing');
    }
    run.repository = structuredClone(record.repository);
    if (record.clone) run.clone = structuredClone(record.clone);
    if (record.files) run.files = structuredClone(record.files);
    markRuntimeStage(run, 'clone', 'Completed', 'Exact repository identity bound to run');

    activeStage = 'analysis';
    markRuntimeStage(run, 'analysis', 'Running');
    let analysis;
    try {
      analysis = await provider.model(record, input, {run, signal: input.signal});
    } catch (error) {
      throw incomplete('analysis', error, 'ProviderUnavailable');
    }
    if (!analysis?.model?.provider || !analysis?.model?.model || !analysis?.finding) {
      throw incomplete('analysis', 'model result missing provider/model/finding', 'ModelResultMissing');
    }
    run.model = {...analysis.model};
    markRuntimeStage(run, 'analysis', 'Completed', run.model.provider + ' / ' + run.model.model);

    activeStage = 'sandbox';
    markRuntimeStage(run, 'sandbox', 'Running');
    activeStage = 'execution';
    markRuntimeStage(run, 'execution', 'Running');
    let execution;
    try {
      execution = await provider.execute(record, input, {run, signal: input.signal});
    } catch (error) {
      throw incomplete('execution', error, 'ExecutionFailed');
    }
    if (!execution || !['Completed', 'Failed', 'Incomplete'].includes(execution.status)) {
      throw incomplete('execution', 'bounded execution returned invalid status', 'ExecutionResultInvalid');
    }
    run.execution = structuredClone(execution);
    if (execution.command) run.selectedCommand = execution.command;
    if (execution.sandbox) run.sandbox = structuredClone(execution.sandbox);

    if (execution.sandbox?.started === false) {
      markRuntimeStage(run, 'sandbox', 'Incomplete', 'Sandbox did not start');
      throw incomplete('sandbox', 'sandbox did not start', 'SandboxUnavailable');
    }
    markRuntimeStage(run, 'sandbox', 'Completed', execution.sandbox?.name ? 'Sandbox: ' + execution.sandbox.name : 'Bounded runtime started');

    markRuntimeStage(run, 'execution', execution.status, Number.isInteger(execution.exitCode) ? 'Exit ' + execution.exitCode : execution.status);
    if (execution.status === 'Incomplete') {
      throw incomplete('execution', execution.timedOut ? 'command timed out' : 'command incomplete', execution.timedOut ? 'Timeout' : 'ExecutionIncomplete');
    }

    activeStage = 'finding';
    markRuntimeStage(run, 'finding', 'Running');
    run.finding = {
      ...structuredClone(analysis.finding),
      evidence: {
        ...(analysis.finding.evidence ? structuredClone(analysis.finding.evidence) : {}),
        execution: structuredClone(execution),
      },
    };
    markRuntimeStage(run, 'finding', 'Completed', 'Finding attached to executed evidence');

    if (execution.status === 'Failed') {
      fail('execution', 'executed command failed', 'CommandFailed');
    }

    if (input.requireBrowser) {
      if (typeof provider.browser !== 'function') {
        throw incomplete('browser', 'required browser capability unavailable', 'BrowserUnavailable');
      }
      const browser = await provider.browser(record, input, {run, signal: input.signal});
      run.browser = structuredClone(browser);
      if (!browser || browser.status !== 'Completed') {
        throw incomplete('browser', browser?.error || 'required browser capability unavailable', 'BrowserUnavailable');
      }
    }

    if (input.requireSpecialist) {
      if (typeof provider.specialist !== 'function') {
        throw incomplete('specialist', 'required specialist unavailable', 'SpecialistUnavailable');
      }
      const specialist = await provider.specialist(record, input, {run, signal: input.signal});
      run.specialists = structuredClone(specialist);
      if (!specialist || specialist.status !== 'Completed') {
        throw incomplete('specialist', specialist?.error || 'specialist incomplete', 'SpecialistIncomplete');
      }
    }

    if (input.repair) {
      if (typeof provider.repair !== 'function') {
        throw incomplete('repair', 'repair runtime unavailable', 'RepairUnavailable');
      }
      const repair = await provider.repair(record, input, {run, signal: input.signal});
      run.repair = structuredClone(repair);
      if (repair?.verdict !== 'VerifiedRepair') {
        throw incomplete('repair', repair?.reason || 'repair rejected', 'RepairRejected');
      }
    }

    if (input.requireArtifact) {
      if (typeof provider.artifact !== 'function') {
        throw incomplete('artifact', 'artifact runtime unavailable', 'ArtifactUnavailable');
      }
      const artifact = await provider.artifact(record, input, {run, signal: input.signal});
      run.proof = structuredClone(artifact);
      if (!artifactPresent(artifact)) {
        throw incomplete('artifact', 'required artifact manifest missing', 'ArtifactMissing');
      }
    }

    if (input.createPullRequest) {
      if (typeof provider.pullRequest !== 'function') {
        throw incomplete('approval', 'pull request runtime unavailable', 'ApprovalUnavailable');
      }
      let pr;
      try {
        pr = await provider.pullRequest(record, input, {run, signal: input.signal});
      } catch (error) {
        const stale = /stale|approval/i.test(message(error));
        throw incomplete('approval', error, stale ? 'StaleApproval' : 'PullRequestFailed');
      }
      run.pullRequest = structuredClone(pr);
      if (!pr?.pullRequest?.url && !pr?.url) {
        throw incomplete('approval', 'pull request result missing URL', 'PullRequestMissing');
      }
    }
  } catch (error) {
    const stage = error?.stage || activeStage;
    const code = error?.code || (input.signal?.aborted ? 'Cancelled' : undefined);
    if (run.stages[stage] && ['Pending', 'Running'].includes(run.stages[stage].status)) {
      markRuntimeStage(run, stage, 'Incomplete', message(error));
    }
    fail(stage, error, code);
  } finally {
    activeStage = 'cleanup';
    try {
      if (run.stages.cleanup.status === 'Pending') markRuntimeStage(run, 'cleanup', 'Running');
      const cleanup = await provider.cleanup(record, input, {run, signal: input.signal});
      run.cleanup = cleanup ? structuredClone(cleanup) : {status: 'Completed'};
      const cleanupOk = cleanup?.status ? cleanup.status === 'Completed' : cleanup?.ok !== false;
      if (!cleanupOk) throw new Error(cleanup?.error || 'cleanup not proven');
      markRuntimeStage(run, 'cleanup', 'Completed', 'Owned runtime resources cleaned');
    } catch (error) {
      if (run.stages.cleanup.status !== 'Incomplete') markRuntimeStage(run, 'cleanup', 'Incomplete', message(error));
      fail('cleanup', error, 'CleanupFailed');
      run.cleanup = {status: 'Incomplete', error: message(error)};
    }

    finishPendingStages(run);
    run.status = terminal;
    run.durationMs = Math.round(performance.now() - started);
    run.finishedAt = new Date().toISOString();
    if (input.signal?.aborted && run.status !== 'Completed') {
      run.failureCode = 'Cancelled';
      run.error = message(input.signal.reason || 'cancelled');
    }
  }

  return assertRuntimeResult(run);
}
