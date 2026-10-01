import test from 'node:test';
import assert from 'node:assert/strict';
import {runRuntimeAudit} from '../services/runtime/engine.mjs';
import {LocalRuntimeProvider} from '../services/runtime/local-runtime.mjs';
import {TrueForgeRuntimeProvider} from '../services/runtime/trueforge-runtime.mjs';
import {
  createScopedToolGate,
  issueRuntimeScope,
  verifyRuntimeScope,
} from '../services/runtime/trueforge-scope.mjs';

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';
const REPOSITORY = {
  owner: 'owner',
  name: 'repo',
  fullName: 'owner/repo',
  url: 'https://github.com/owner/repo.git',
  commit: 'abcdef0123456789abcdef0123456789abcdef01',
};

function execution(status = 'Completed', extra = {}) {
  return {
    status,
    exitCode: status === 'Completed' ? 0 : status === 'Failed' ? 1 : null,
    command: 'node check',
    stdout: status === 'Completed' ? 'ok' : '',
    stderr: status === 'Failed' ? 'failed' : '',
    durationMs: 2,
    sandbox: {started: true, removed: true, name: 'runtime-fixture'},
    ...extra,
  };
}

function finding() {
  return {
    title: 'Fixture observation',
    severity: 'info',
    description: 'Fixture model observation.',
    evidence: {file: 'package.json', execution: {invented: true}},
  };
}

function scenarioInput(name) {
  const input = {
    runId: 'runtime-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    repositoryUrl: 'https://github.com/owner/repo',
    repository: REPOSITORY,
    objective: 'Check runtime parity',
    requireArtifact: name === 'missing-artifact',
    requireBrowser: name === 'browser-unavailable',
    repair: name === 'repair-rejected' ? {files: []} : undefined,
    createPullRequest: name === 'stale-approval',
    approval: name === 'stale-approval' ? {token: 'old'} : undefined,
  };
  if (name === 'cancellation') {
    const controller = new AbortController();
    controller.abort(new Error('cancel requested'));
    input.signal = controller.signal;
  }
  return input;
}

function localFactory(name) {
  const repositories = {
    async clone() {
      if (name === 'cancellation') throw new Error('clone should not start after cancellation');
      return {
        id: 'local-record',
        repository: structuredClone(REPOSITORY),
        clone: {success: true, workspacePath: '/tmp/runtime-fixture'},
        files: {count: 1, items: ['package.json'], truncated: false, languages: ['JavaScript']},
      };
    },
    async cleanup() {
      if (name === 'cleanup-failure') throw new Error('owned cleanup failed');
      return true;
    },
  };

  const provider = new LocalRuntimeProvider({
    repositories,
    analyze: async () => {
      if (name === 'provider-unavailable') throw new Error('provider unavailable');
      return {model: {provider: 'fixture', model: 'local-model'}, finding: finding()};
    },
    select: async () => ({executable: 'node', args: ['check']}),
    execute: async () => {
      if (name === 'command-failure') return execution('Failed');
      if (name === 'timeout') return execution('Incomplete', {timedOut: true});
      return execution('Completed');
    },
    browser: async () => ({status: 'Incomplete', error: 'browser unavailable'}),
    repair: async () => ({verdict: 'RejectedRepair', reason: 'candidate did not pass verification'}),
    artifact: async () => ({runId: 'x', artifacts: []}),
    pullRequest: async () => { throw new Error('stale approval binding'); },
  });
  return {provider, input: scenarioInput(name)};
}

function fakeTrueForgeClient(name, capture) {
  return {
    async health() {
      if (name === 'provider-unavailable') throw new Error('provider unavailable');
      return true;
    },
    async createSession(spec) {
      capture.spec = spec;
      return 'tf-session';
    },
    async runTurn(_id, prompt) {
      capture.prompt = prompt;
      return {
        status: 'done',
        turnId: 'tf-turn',
        answer: JSON.stringify({
          model: {ignored: true},
          finding: {
            ...finding(),
            evidence: {
              execution: {status: 'Completed', exitCode: 0, stdout: 'invented'},
              screenshot: 'invented.png',
            },
          },
        }),
      };
    },
  };
}

function trueForgeFactory(name) {
  const capture = {};
  const tools = {
    async repoTree() {
      return {
        clone: {success: true, remote: true},
        files: {count: 1, items: ['package.json'], truncated: false, languages: ['JavaScript']},
      };
    },
    async boundedExecution() {
      if (name === 'command-failure') return execution('Failed');
      if (name === 'timeout') return execution('Incomplete', {timedOut: true});
      return execution('Completed');
    },
    async browserJourney() {
      return {status: 'Incomplete', error: 'browser unavailable'};
    },
    async repairCandidate() {
      return {verdict: 'RejectedRepair', reason: 'candidate did not pass verification'};
    },
    async artifactHandoff() {
      return {runId: 'x', artifacts: []};
    },
    async pullRequest() {
      throw new Error('stale approval binding');
    },
    async cleanup() {
      if (name === 'cleanup-failure') throw new Error('owned cleanup failed');
      return {status: 'Completed', remote: true};
    },
  };
  const provider = new TrueForgeRuntimeProvider({
    client: fakeTrueForgeClient(name, capture),
    model: 'fixture/model',
    scopeSecret: SECRET,
    tools,
    maxToolCalls: 8,
  });
  return {provider, input: scenarioInput(name), capture};
}

function registerRuntimeContract(label, factory) {
  test(label + ' successful audit preserves M5 semantic shape', async () => {
    const {provider, input} = factory('success');
    const run = await runRuntimeAudit(provider, input);
    assert.equal(run.status, 'Completed');
    assert.equal(run.repository.fullName, REPOSITORY.fullName);
    assert.equal(run.repository.commit, REPOSITORY.commit);
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

registerRuntimeContract('LocalRuntime fixture:', localFactory);
registerRuntimeContract('TrueForgeRuntime fixture:', trueForgeFactory);

test('TrueForge scope binds run/repo, blocks mutation without repair approval, and caps tool calls', () => {
  const token = issueRuntimeScope({
    secret: SECRET,
    runId: 'scope-run',
    repository: REPOSITORY,
    capabilities: ['repository:read', 'execution:bounded'],
    maxToolCalls: 2,
  });
  const parsed = verifyRuntimeScope(token, SECRET);
  assert.equal(parsed.runId, 'scope-run');
  assert.equal(parsed.repository.commit, REPOSITORY.commit);

  const gate = createScopedToolGate({secret: SECRET, token});
  gate.authorize('repo_read', {runId: 'scope-run', repository: REPOSITORY});
  gate.authorize('bounded_execution', {runId: 'scope-run', repository: REPOSITORY});
  assert.throws(() => gate.authorize('repo_tree', {runId: 'scope-run', repository: REPOSITORY}), /tool-call limit/);

  const fresh = createScopedToolGate({secret: SECRET, token});
  assert.throws(() => fresh.authorize('repo_read', {runId: 'other', repository: REPOSITORY}), /runId/);
  assert.throws(() => fresh.authorize('repo_read', {runId: 'scope-run', repository: {...REPOSITORY, commit: '1234567'}}), /commit/);
  assert.throws(() => fresh.authorize('repair_candidate', {runId: 'scope-run', repository: REPOSITORY}), /not authorized|capability/);
  assert.throws(() => verifyRuntimeScope(token + 'x', SECRET), /signature|token/);
});

test('TrueForge adapter never exposes scope secret or authorization token to the model prompt', async () => {
  const {provider, input, capture} = trueForgeFactory('success');
  const run = await runRuntimeAudit(provider, input);
  assert.equal(run.status, 'Completed');
  assert.ok(capture.prompt);
  assert.ok(capture.spec);
  assert.equal(capture.prompt.includes(SECRET), false);
  assert.equal(JSON.stringify(capture.spec).includes(SECRET), false);
  assert.equal(/scopeToken|authorization/i.test(capture.prompt), false);
});
