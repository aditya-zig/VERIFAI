import {createHash} from 'node:crypto';
import {
  DescribeTasksCommand,
  ListTagsForResourceCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import {checkCloudBudget, DEFAULT_CLOUD_LIMITS} from './budget-guard.mjs';

const TERMINAL = new Set(['Completed', 'Failed', 'Incomplete']);

function nowIso() {
  return new Date().toISOString();
}

function env(name, value) {
  return {name, value: String(value)};
}

function clientToken(runId) {
  return 'verifiai-' + createHash('sha256').update(runId).digest('hex').slice(0, 48);
}

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('cloud job is required');
  if (typeof job.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.runId)) {
    throw new Error('cloud runId is invalid');
  }
  if (!job.repository?.fullName || !job.repository?.url || !/^[0-9a-f]{7,64}$/i.test(job.repository?.commit || '')) {
    throw new Error('cloud job requires exact repository fullName/url/commit');
  }
  if (!job.model?.provider || !job.model?.name) throw new Error('cloud job requires model provider/name');
  if (!Number.isInteger(job.deadlineMs) || job.deadlineMs < 1000 || job.deadlineMs > 20 * 60 * 1000) {
    throw new Error('cloud deadline must be between 1 second and 20 minutes');
  }
}

function tagsToObject(tags = []) {
  return Object.fromEntries(tags.map((tag) => [tag.key, tag.value]));
}

export function assertOwnedCloudTask(tags, {runId, environment}) {
  const value = Array.isArray(tags) ? tagsToObject(tags) : tags;
  if (value.project !== 'verifiai') throw new Error('task ownership project mismatch');
  if (value.runId !== runId) throw new Error('task ownership runId mismatch');
  if (value.environment !== environment) throw new Error('task ownership environment mismatch');
  return true;
}

export class AwsCloudControlPlane {
  constructor({
    ecs,
    store,
    cluster,
    taskDefinition,
    containerName = 'verifiai-worker',
    subnets = [],
    securityGroups = [],
    environment = 'dev',
    assignPublicIp = true,
    budgetLimits = DEFAULT_CLOUD_LIMITS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!ecs || typeof ecs.send !== 'function') throw new Error('ECS client is required');
    if (!store || typeof store.acquire !== 'function') throw new Error('run store is required');
    if (!cluster || !taskDefinition) throw new Error('cluster and task definition are required');
    if (!Array.isArray(subnets) || subnets.length === 0) throw new Error('at least one public subnet is required');
    this.ecs = ecs;
    this.store = store;
    this.cluster = cluster;
    this.taskDefinition = taskDefinition;
    this.containerName = containerName;
    this.subnets = subnets;
    this.securityGroups = securityGroups;
    this.environment = environment;
    this.assignPublicIp = assignPublicIp;
    this.budgetLimits = budgetLimits;
    this.sleep = sleep;
  }

  async start(job) {
    validateJob(job);
    const budget = checkCloudBudget({
      runtimeMs: job.deadlineMs,
      modelCalls: job.maxModelCalls ?? 1,
      taskCount: 1,
      retries: job.retries ?? 0,
      estimatedSpendUsd: job.estimatedSpendUsd,
    }, this.budgetLimits);

    if (!budget.ok) {
      const state = {
        id: job.runId,
        status: 'Incomplete',
        failedStage: 'budget',
        failureCode: 'BudgetLimit',
        error: 'Cloud launch blocked by configured budget bounds: ' + budget.violations.join(', '),
        budget,
        finishedAt: nowIso(),
        provenance: {runtime: 'cloud', contractVersion: 1},
      };
      await this.store.putState(job.runId, state);
      return state;
    }

    const lock = await this.store.acquire(job.runId, {
      repository: {fullName: job.repository.fullName, commit: job.repository.commit},
    });
    if (!lock.acquired) {
      const existing = await this.store.getState(job.runId);
      return existing || {
        id: job.runId,
        status: 'Incomplete',
        failedStage: 'launch',
        failureCode: 'DuplicateRunPending',
        error: 'Run lock already exists but state is not yet readable',
        provenance: {runtime: 'cloud', contractVersion: 1},
      };
    }

    const state = {
      id: job.runId,
      status: 'Running',
      startedAt: nowIso(),
      repository: structuredClone(job.repository),
      provenance: {runtime: 'cloud', contractVersion: 1},
      budget,
    };
    await this.store.putState(job.runId, state);

    const environment = [
      env('VERIFIAI_RUN_ID', job.runId),
      env('VERIFIAI_REPOSITORY_URL', job.repository.url),
      env('VERIFIAI_REPOSITORY_FULL_NAME', job.repository.fullName),
      env('VERIFIAI_REPOSITORY_COMMIT', job.repository.commit),
      env('VERIFIAI_MODEL_PROVIDER', job.model.provider),
      env('VERIFIAI_MODEL_ID', job.model.name),
      env('VERIFIAI_CLOUD_DEADLINE_MS', job.deadlineMs),
      env('VERIFIAI_CLOUD_MAX_MODEL_CALLS', job.maxModelCalls ?? 1),
      env('VERIFIAI_CLOUD_CAPABILITIES', JSON.stringify(job.capabilities || [])),
    ];

    let response;
    try {
      response = await this.ecs.send(new RunTaskCommand({
        cluster: this.cluster,
        taskDefinition: this.taskDefinition,
        launchType: 'FARGATE',
        platformVersion: '1.4.0',
        count: 1,
        clientToken: clientToken(job.runId),
        enableExecuteCommand: false,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.subnets,
            ...(this.securityGroups.length ? {securityGroups: this.securityGroups} : {}),
            assignPublicIp: this.assignPublicIp ? 'ENABLED' : 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [{
            name: this.containerName,
            environment,
          }],
        },
        tags: [
          {key: 'project', value: 'verifiai'},
          {key: 'runId', value: job.runId},
          {key: 'environment', value: this.environment},
        ],
      }));
    } catch (error) {
      const failed = {
        ...state,
        status: 'Incomplete',
        failedStage: 'launch',
        failureCode: 'TaskLaunchFailed',
        error: String(error?.message || error),
        finishedAt: nowIso(),
      };
      await this.store.putState(job.runId, failed);
      return failed;
    }

    const taskArn = response?.tasks?.[0]?.taskArn;
    if (!taskArn || (response?.failures?.length || 0) > 0) {
      const failed = {
        ...state,
        status: 'Incomplete',
        failedStage: 'launch',
        failureCode: 'TaskLaunchFailed',
        error: 'ECS RunTask did not return exactly one worker task',
        launchFailures: response?.failures || [],
        finishedAt: nowIso(),
      };
      await this.store.putState(job.runId, failed);
      return failed;
    }

    const running = {...state, taskArn};
    await this.store.putState(job.runId, running);
    return running;
  }

  async ownership(taskArn, runId) {
    const response = await this.ecs.send(new ListTagsForResourceCommand({resourceArn: taskArn}));
    assertOwnedCloudTask(response?.tags || [], {runId, environment: this.environment});
    return true;
  }

  async refresh(runId) {
    const state = await this.store.getState(runId);
    if (!state || TERMINAL.has(state.status) || !state.taskArn) return state;

    const response = await this.ecs.send(new DescribeTasksCommand({
      cluster: this.cluster,
      tasks: [state.taskArn],
    }));
    const task = response?.tasks?.[0];
    if (!task) return state;
    if (task.lastStatus !== 'STOPPED') return state;

    const result = await this.store.getResult(runId);
    if (result && TERMINAL.has(result.status)) {
      const terminal = {
        ...result,
        id: runId,
        taskArn: state.taskArn,
        provenance: {...result.provenance, runtime: 'cloud', contractVersion: 1},
      };
      await this.store.putState(runId, terminal);
      return terminal;
    }

    const failed = {
      ...state,
      status: 'Incomplete',
      failedStage: 'worker',
      failureCode: 'WorkerStoppedWithoutResult',
      error: 'Cloud task stopped without a terminal VERIFAI result',
      stoppedReason: task.stoppedReason,
      cleanup: {status: 'Completed', taskStopped: true},
      finishedAt: nowIso(),
    };
    await this.store.putState(runId, failed);
    return failed;
  }

  async cancel(runId, {waitMs = 30000} = {}) {
    const state = await this.store.getState(runId);
    if (!state || TERMINAL.has(state.status)) return state;
    if (!state.taskArn) {
      const failed = {
        ...state,
        status: 'Incomplete',
        failedStage: 'cleanup',
        failureCode: 'CancelWithoutTask',
        error: 'No owned task ARN recorded for cancellation',
        finishedAt: nowIso(),
      };
      await this.store.putState(runId, failed);
      return failed;
    }

    await this.ownership(state.taskArn, runId);
    await this.ecs.send(new StopTaskCommand({
      cluster: this.cluster,
      task: state.taskArn,
      reason: 'VERIFAI user cancellation',
    }));

    const deadline = Date.now() + Math.max(1000, Math.min(waitMs, 60000));
    while (Date.now() < deadline) {
      const response = await this.ecs.send(new DescribeTasksCommand({
        cluster: this.cluster,
        tasks: [state.taskArn],
      }));
      const task = response?.tasks?.[0];
      if (task?.lastStatus === 'STOPPED') {
        const cancelled = {
          ...state,
          status: 'Incomplete',
          failedStage: 'cancellation',
          failureCode: 'Cancelled',
          error: 'Cloud run cancelled',
          cleanup: {status: 'Completed', taskStopped: true, artifactsPreserved: true},
          finishedAt: nowIso(),
        };
        await this.store.putState(runId, cancelled);
        return cancelled;
      }
      await this.sleep(250);
    }

    const incomplete = {
      ...state,
      status: 'Incomplete',
      failedStage: 'cleanup',
      failureCode: 'CancelTimeout',
      error: 'Cloud task stop was requested but terminal stop was not observed',
      cleanup: {status: 'Incomplete', taskStopped: false, artifactsPreserved: true},
      finishedAt: nowIso(),
    };
    await this.store.putState(runId, incomplete);
    return incomplete;
  }

  async reap(runId, {olderThanMs = 20 * 60 * 1000, now = Date.now()} = {}) {
    const state = await this.store.getState(runId);
    if (!state || TERMINAL.has(state.status) || !state.taskArn) return {reaped: false, state};
    const started = Date.parse(state.startedAt || '');
    if (!Number.isFinite(started) || now - started < olderThanMs) return {reaped: false, state};

    await this.ownership(state.taskArn, runId);
    await this.ecs.send(new StopTaskCommand({
      cluster: this.cluster,
      task: state.taskArn,
      reason: 'VERIFAI stale owned task reaper',
    }));
    const reaped = {
      ...state,
      status: 'Incomplete',
      failedStage: 'cleanup',
      failureCode: 'StaleTaskReaped',
      error: 'Owned stale cloud task was stopped by bounded reaper',
      cleanup: {status: 'Completed', taskStopRequested: true, artifactsPreserved: true},
      finishedAt: nowIso(),
    };
    await this.store.putState(runId, reaped);
    return {reaped: true, state: reaped};
  }
}
