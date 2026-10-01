import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {AwsCloudControlPlane, assertOwnedCloudTask} from '../services/cloud/aws-control-plane.mjs';
import {AwsS3RunStore} from '../services/cloud/s3-run-store.mjs';
import {checkCloudBudget} from '../services/cloud/budget-guard.mjs';
import {cloudArtifactKey, cloudControlKeys} from '../services/cloud/artifact-contract.mjs';
import {CloudRuntime} from '../services/runtime/cloud-runtime.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REPO = {
  fullName: 'owner/repo',
  url: 'https://github.com/owner/repo',
  commit: 'abcdef0123456789abcdef0123456789abcdef01',
};

function job(overrides = {}) {
  return {
    runId: 'cloud-run-1',
    repository: REPO,
    model: {provider: 'xkiro', name: 'mistralai/ministral-8b'},
    capabilities: ['repository:read', 'execution:bounded'],
    deadlineMs: 60_000,
    maxModelCalls: 1,
    retries: 0,
    estimatedSpendUsd: 0.05,
    ...overrides,
  };
}

class MemoryStore {
  constructor() {
    this.locks = new Set();
    this.states = new Map();
    this.results = new Map();
  }
  async acquire(runId) {
    if (this.locks.has(runId)) return {acquired: false};
    this.locks.add(runId);
    return {acquired: true};
  }
  async putState(runId, value) {
    this.states.set(runId, structuredClone(value));
  }
  async getState(runId) {
    const value = this.states.get(runId);
    return value ? structuredClone(value) : null;
  }
  async putResult(runId, value) {
    this.results.set(runId, structuredClone(value));
  }
  async getResult(runId) {
    const value = this.results.get(runId);
    return value ? structuredClone(value) : null;
  }
}

class FakeEcs {
  constructor({tags, stopped = true, launchError, launchFailure} = {}) {
    this.calls = [];
    this.tags = tags || [
      {key: 'project', value: 'verifiai'},
      {key: 'runId', value: 'cloud-run-1'},
      {key: 'environment', value: 'test'},
    ];
    this.stopped = stopped;
    this.launchError = launchError;
    this.launchFailure = launchFailure;
  }
  async send(command) {
    const name = command.constructor.name;
    this.calls.push({name, input: command.input});
    if (name === 'RunTaskCommand') {
      if (this.launchError) throw new Error(this.launchError);
      if (this.launchFailure) return {tasks: [], failures: [{reason: this.launchFailure}]};
      return {tasks: [{taskArn: 'arn:aws:ecs:ap-south-1:123456789012:task/cluster/task-1'}], failures: []};
    }
    if (name === 'ListTagsForResourceCommand') return {tags: this.tags};
    if (name === 'StopTaskCommand') return {task: {taskArn: command.input.task}};
    if (name === 'DescribeTasksCommand') {
      return {tasks: [{taskArn: command.input.tasks[0], lastStatus: this.stopped ? 'STOPPED' : 'RUNNING', stoppedReason: 'fixture'}]};
    }
    throw new Error('unexpected ECS command ' + name);
  }
}

function control({ecs = new FakeEcs(), store = new MemoryStore(), budgetLimits} = {}) {
  return {
    ecs,
    store,
    plane: new AwsCloudControlPlane({
      ecs,
      store,
      cluster: 'cluster',
      taskDefinition: 'taskdef:1',
      subnets: ['subnet-public'],
      securityGroups: ['sg-runtime'],
      environment: 'test',
      budgetLimits,
      sleep: async () => {},
    }),
  };
}

test('cloud budget guard blocks launch deterministically before ECS', async () => {
  const {ecs, plane} = control();
  const state = await plane.start(job({maxModelCalls: 99}));
  assert.equal(state.status, 'Incomplete');
  assert.equal(state.failureCode, 'BudgetLimit');
  assert.equal(ecs.calls.filter((x) => x.name === 'RunTaskCommand').length, 0);
});

test('same runId submitted twice launches at most one Fargate task and recovers state', async () => {
  const {ecs, plane} = control();
  const first = await plane.start(job());
  const second = await plane.start(job());
  assert.equal(first.status, 'Running');
  assert.equal(second.taskArn, first.taskArn);
  assert.equal(ecs.calls.filter((x) => x.name === 'RunTaskCommand').length, 1);
  const launch = ecs.calls.find((x) => x.name === 'RunTaskCommand').input;
  assert.equal(launch.count, 1);
  assert.equal(launch.launchType, 'FARGATE');
  assert.equal(launch.platformVersion, '1.4.0');
  assert.equal(launch.enableExecuteCommand, false);
  assert.equal(launch.networkConfiguration.awsvpcConfiguration.assignPublicIp, 'ENABLED');
  const workerEnv = launch.overrides.containerOverrides[0].environment;
  const envNames = workerEnv.map((item) => item.name);
  assert.equal(envNames.some((name) => /API_KEY|SECRET|PASSWORD/i.test(name)), false);
  assert.equal(workerEnv.some((item) => /Bearer\s|ghp_|sk-/i.test(String(item.value))), false);
});

test('cloud cancellation verifies ownership, stops task, observes terminal stop, preserves artifacts', async () => {
  const {ecs, plane} = control();
  await plane.start(job());
  const result = await plane.cancel('cloud-run-1');
  assert.equal(result.status, 'Incomplete');
  assert.equal(result.failureCode, 'Cancelled');
  assert.equal(result.cleanup.taskStopped, true);
  assert.equal(result.cleanup.artifactsPreserved, true);
  assert.equal(ecs.calls.some((x) => x.name === 'StopTaskCommand'), true);
});

test('cloud cancellation refuses task with wrong ownership tags', async () => {
  const ecs = new FakeEcs({tags: [
    {key: 'project', value: 'verifiai'},
    {key: 'runId', value: 'other-run'},
    {key: 'environment', value: 'test'},
  ]});
  const {plane} = control({ecs});
  await plane.start(job());
  await assert.rejects(plane.cancel('cloud-run-1'), /ownership runId mismatch/);
  assert.equal(ecs.calls.some((x) => x.name === 'StopTaskCommand'), false);
});

test('stale reaper stops only exact owned task and marks truthful Incomplete', async () => {
  const {store, ecs, plane} = control();
  await plane.start(job());
  const state = await store.getState('cloud-run-1');
  state.startedAt = '2020-01-01T00:00:00.000Z';
  await store.putState('cloud-run-1', state);
  const result = await plane.reap('cloud-run-1', {olderThanMs: 1, now: Date.now()});
  assert.equal(result.reaped, true);
  assert.equal(result.state.failureCode, 'StaleTaskReaped');
  assert.equal(result.state.cleanup.artifactsPreserved, true);
  assert.equal(ecs.calls.some((x) => x.name === 'StopTaskCommand'), true);
});

test('task launch failure maps to Incomplete without retry loop', async () => {
  const ecs = new FakeEcs({launchError: 'capacity unavailable'});
  const {plane} = control({ecs});
  const state = await plane.start(job());
  assert.equal(state.status, 'Incomplete');
  assert.equal(state.failureCode, 'TaskLaunchFailed');
  assert.equal(ecs.calls.filter((x) => x.name === 'RunTaskCommand').length, 1);
});

test('stopped worker without result maps to truthful Incomplete', async () => {
  const {plane} = control();
  await plane.start(job());
  const state = await plane.refresh('cloud-run-1');
  assert.equal(state.status, 'Incomplete');
  assert.equal(state.failureCode, 'WorkerStoppedWithoutResult');
});

test('cloud refresh preserves worker terminal states including provider, timeout, artifact and cleanup failures', async () => {
  for (const fixture of [
    {failureCode: 'ProviderUnavailable', failedStage: 'analysis'},
    {failureCode: 'Timeout', failedStage: 'execution'},
    {failureCode: 'ArtifactUploadFailed', failedStage: 'artifact'},
    {failureCode: 'CleanupFailed', failedStage: 'cleanup'},
  ]) {
    const store = new MemoryStore();
    const {plane} = control({store});
    const runId = 'cloud-' + fixture.failureCode.toLowerCase();
    await plane.start(job({runId}));
    await store.putResult(runId, {
      id: runId,
      status: 'Incomplete',
      ...fixture,
      repository: REPO,
      provenance: {runtime: 'cloud', contractVersion: 1},
    });
    const state = await plane.refresh(runId);
    assert.equal(state.status, 'Incomplete');
    assert.equal(state.failureCode, fixture.failureCode);
    assert.equal(state.failedStage, fixture.failedStage);
  }
});

test('invalid repo never reaches ECS', async () => {
  const {ecs, plane} = control();
  await assert.rejects(plane.start(job({repository: {...REPO, commit: 'not-a-sha'}})), /exact repository/);
  assert.equal(ecs.calls.length, 0);
});

test('artifact keys stay in owned run prefix', () => {
  assert.equal(cloudArtifactKey('run-1', 'manifest.json'), 'runs/run-1/manifest.json');
  assert.equal(cloudControlKeys('run-1').state, 'runs/run-1/control/state.json');
  assert.throws(() => cloudArtifactKey('run-1', '../escape'), /escapes/);
});

test('ownership helper requires project, runId and environment', () => {
  assert.equal(assertOwnedCloudTask({
    project: 'verifiai', runId: 'r', environment: 'dev',
  }, {runId: 'r', environment: 'dev'}), true);
  assert.throws(() => assertOwnedCloudTask({
    project: 'other', runId: 'r', environment: 'dev',
  }, {runId: 'r', environment: 'dev'}), /project/);
});

test('S3 run store uses conditional create for idempotency and no public ACL', async () => {
  const objects = new Map();
  const fakeS3 = {
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      if (name === 'PutObjectCommand') {
        if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
          const error = new Error('exists');
          error.name = 'PreconditionFailed';
          error.$metadata = {httpStatusCode: 412};
          throw error;
        }
        assert.equal(input.ACL, undefined);
        assert.equal(input.ServerSideEncryption, 'AES256');
        objects.set(input.Key, Buffer.from(input.Body));
        return {};
      }
      if (name === 'GetObjectCommand') {
        if (!objects.has(input.Key)) {
          const error = new Error('missing');
          error.name = 'NoSuchKey';
          throw error;
        }
        const body = objects.get(input.Key);
        return {Body: {async transformToString() { return body.toString('utf8'); }}};
      }
      throw new Error('unexpected S3 command ' + name);
    },
  };
  const store = new AwsS3RunStore({s3: fakeS3, bucket: 'bucket', environment: 'test'});
  assert.equal((await store.acquire('run-1', {})).acquired, true);
  assert.equal((await store.acquire('run-1', {})).acquired, false);
  await store.putState('run-1', {id: 'run-1', status: 'Running'});
  assert.equal((await store.getState('run-1')).status, 'Running');
});

test('CloudRuntime exposes start/get/cancel/reap without changing cloud state shape', async () => {
  const {plane} = control();
  const runtime = new CloudRuntime(plane);
  const started = await runtime.start(job());
  assert.equal(started.id, 'cloud-run-1');
  assert.equal(started.status, 'Running');
  const current = await runtime.get('cloud-run-1');
  assert.equal(current.id, 'cloud-run-1');
});

test('cloud static preflight validates IaC, IAM, public access and worker entrypoint', async () => {
  const result = await execFileAsync(process.execPath, [resolve(ROOT, 'scripts/cloud-preflight.mjs')], {cwd: ROOT});
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.publicBucketBlocked, true);
  assert.equal(parsed.worker.cpu, '512');
  assert.equal(parsed.worker.memory, '1024');
});

test('budget guard accepts bounded smoke request', () => {
  const result = checkCloudBudget({runtimeMs: 60_000, modelCalls: 1, taskCount: 1, retries: 0, estimatedSpendUsd: 0.05});
  assert.equal(result.ok, true);
});
