import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CandidateRevision,
  CheckObservation,
  CheckPlan,
  PrVerificationRequest,
} from '../packages/contracts/src/index.js';
import {
  PrJobController,
  PrJobControllerError,
  type PrJobEvaluator,
  type PrJobExecutor,
  type PrJobPlanner,
  type PrJobResolver,
  type PrResourceAdapter,
} from '../services/pr-verification/controller.js';
import { PrJobStore, type PrJob, type RequestPrincipal } from '../services/pr-verification/store.js';

/**
 * These tests drive the controller against a real store on disk and against
 * fake adapters. The adapters record what they were asked to do, so the
 * assertions are about behaviour rather than about source text.
 */

interface PrFs {
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

const fs = nodeFs as unknown as PrFs;

async function makeTempDir(label: string): Promise<string> {
  const bases = ['/tmp/opencode', process.env.TMPDIR ?? '/tmp', '/tmp'];
  for (const base of bases) {
    try {
      return await fs.mkdtemp(join(base, `${label}-`));
    } catch {
      // Try the next base directory.
    }
  }
  throw new Error('could not create a temporary directory');
}

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const MERGE_BASE_SHA = 'c'.repeat(40);
const DIFF_DIGEST = 'd'.repeat(64);
const PLAN_DIGEST = 'e'.repeat(64);
const TEST_SHA = 'f'.repeat(64);

const candidate: CandidateRevision = {
  repository: 'acme/shop',
  pullRequest: 7,
  headRepository: 'acme/shop',
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  mergeBaseSha: MERGE_BASE_SHA,
  changedFiles: ['src/app.ts'],
  diffDigest: DIFF_DIGEST,
};

function makePlan(planDigest = PLAN_DIGEST): CheckPlan {
  return {
    policyVersion: 'policy-1',
    profileId: 'default',
    profileDigest: '1'.repeat(64),
    requiredChecks: [
      { checkId: 'unit', artifactRef: 'artifacts/unit.json', contentSha256: TEST_SHA, origin: 'approved' },
    ],
    generatedTests: [],
    planDigest,
  };
}

function makeObservation(overrides: Partial<CheckObservation> = {}): CheckObservation {
  return {
    checkId: 'unit',
    revision: 'head',
    commitSha: HEAD_SHA,
    status: 'Verified',
    executed: true,
    exitCode: 0,
    artifactRefs: ['artifacts/unit.json'],
    commandDigest: '2'.repeat(64),
    testContentSha256: TEST_SHA,
    ...overrides,
  };
}

const principal: RequestPrincipal = {
  id: 'owner-1',
  kind: 'human',
  repositories: ['acme/shop'],
};

const request: PrVerificationRequest = {
  repository: 'acme/shop',
  pullRequest: 7,
  expectedHeadSha: HEAD_SHA,
};

function isControllerError(error: unknown, code: string, status?: number): boolean {
  if (!(error instanceof PrJobControllerError)) return false;
  if (error.code !== code) return false;
  if (status !== undefined && error.status !== status) return false;
  return true;
}

function resolver(calls: string[] = []): PrJobResolver {
  return {
    resolve: async () => {
      calls.push('resolve');
      return candidate;
    },
  };
}

function planner(calls: string[] = []): PrJobPlanner {
  return {
    plan: async () => {
      calls.push('plan');
      return makePlan();
    },
  };
}

function executor(observations: CheckObservation[], calls: string[] = []): PrJobExecutor {
  return {
    execute: async () => {
      calls.push('execute');
      return { observations };
    },
  };
}

/**
 * A stand in for the policy worker. The real evaluator lives outside this
 * slice. This one only proves that the seam is wired: it accepts an
 * observation set that covers the plan and refuses everything else.
 */
function evaluator(): PrJobEvaluator {
  return {
    evaluate: ({ plan, candidate, observations, cancelled, cleanupComplete }) => {
      if (cancelled) return { verdict: 'Incomplete', limitations: ['the job was cancelled'] };
      if (!cleanupComplete) return { verdict: 'Incomplete', limitations: ['cleanup did not complete'] };
      if (observations.some((observation) => observation.status === 'Failed')) {
        return { verdict: 'Failed', limitations: [] };
      }
      for (const required of plan.requiredChecks) {
        const proven = observations.some(
          (observation) =>
            observation.checkId === required.checkId &&
            observation.revision === 'head' &&
            observation.executed === true &&
            observation.status === 'Verified' &&
            observation.testContentSha256 === required.contentSha256 &&
            observation.commitSha === candidate.headSha,
        );
        if (!proven) {
          return { verdict: 'Incomplete', limitations: [`required check ${required.checkId} is not proven`] };
        }
      }
      return { verdict: 'Verified', limitations: [] };
    },
  };
}

test('the queued job is on disk before the resolver runs', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    let stateWhenResolved = '';
    const controller = new PrJobController({
      store,
      resolver: {
        resolve: async ({ job }) => {
          const disk = new PrJobStore({ directory });
          const seen = await disk.get(job.id);
          stateWhenResolved = seen ? 'persisted' : 'missing';
          return candidate;
        },
      },
      planner: planner(),
    });

    const job = await controller.start(principal, request);
    assert.equal(job.phase, 'Queued');
    const onDisk = await new PrJobStore({ directory }).get(job.id);
    assert.equal(onDisk?.phase, 'Queued');

    await controller.run(job.id);
    assert.equal(stateWhenResolved, 'persisted');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('starting the same request twice returns the same job', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const controller = new PrJobController({ store });

    const first = await controller.start(principal, request);
    const second = await controller.start(principal, request);

    assert.equal(first.id, second.id);
    assert.equal((await store.list()).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a principal without repository access is refused before anything is stored', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const calls: string[] = [];
    const controller = new PrJobController({
      store,
      resolver: resolver(calls),
      planner: planner(calls),
      executor: executor([makeObservation()], calls),
    });

    await assert.rejects(
      () => controller.start({ id: 'owner-2', kind: 'agent', repositories: ['other/repo'] }, request),
      (error: unknown) => isControllerError(error, 'REPOSITORY_NOT_AUTHORIZED', 403),
    );
    assert.deepEqual(calls, []);
    assert.equal((await store.list()).length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a principal that does not own the job cannot read or cancel it', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const controller = new PrJobController({ store });
    const job = await controller.start(principal, request);

    const stranger: RequestPrincipal = { id: 'owner-2', kind: 'agent', repositories: ['other/repo'] };
    await assert.rejects(
      () => controller.get(stranger, job.id),
      (error: unknown) => isControllerError(error, 'JOB_ACCESS_DENIED', 403),
    );
    await assert.rejects(
      () => controller.cancel(stranger, job.id),
      (error: unknown) => isControllerError(error, 'JOB_ACCESS_DENIED', 403),
    );

    const allowed = await controller.get(principal, job.id);
    assert.equal(allowed.id, job.id);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a second distinct job is refused while one is active', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const calls: string[] = [];
    const controller = new PrJobController({
      store,
      resolver: resolver(calls),
      planner: planner(calls),
      executor: executor([makeObservation()], calls),
    });

    await controller.start(principal, request);
    await assert.rejects(
      () => controller.start(principal, { ...request, pullRequest: 8 }),
      (error: unknown) => isControllerError(error, 'ACTIVE_JOB_EXISTS', 409),
    );
    assert.deepEqual(calls, []);
    assert.equal((await store.list()).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('two concurrent starts admit only one job', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const controller = new PrJobController({ store });

    const attempts = await Promise.allSettled([
      controller.start(principal, request),
      controller.start(principal, { ...request, pullRequest: 8 }),
    ]);

    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(reason instanceof PrJobControllerError);
    assert.equal(reason.code, 'ACTIVE_JOB_EXISTS');
    assert.equal((await store.list()).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a job without an execution adapter finishes as incomplete and never as verified', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const controller = new PrJobController({ store, resolver: resolver(), planner: planner() });

    const job = await controller.start(principal, request);
    const finished = await controller.run(job.id);

    assert.equal(finished.phase, 'Finished');
    assert.equal(finished.verdict, 'Incomplete');
    assert.ok(finished.result);
    assert.equal(finished.result?.verdict, 'Incomplete');
    assert.deepEqual(finished.result?.observations, []);
    assert.equal(finished.failure?.code, 'EXECUTOR_UNAVAILABLE');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the resource intent and the identifiers are persisted before the side effects', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const seen: Record<string, string> = {};

    const resources: PrResourceAdapter = {
      allocate: async (jobId, intent) => {
        const disk = new PrJobStore({ directory });
        const job = await disk.get(jobId);
        seen.intentAtAllocation = job?.resourceIntent?.planDigest ?? 'missing';
        seen.idsAtAllocation = JSON.stringify(job?.resourceIds ?? []);
        return ['resource-1'];
      },
      inspect: async () => [],
      release: async () => ({ released: [], failed: [] }),
    };

    const controller = new PrJobController({
      store,
      resolver: resolver(),
      planner: planner(),
      resources,
      evaluator: evaluator(),
      executor: {
        execute: async ({ job }) => {
          const disk = new PrJobStore({ directory });
          const stored = await disk.get(job.id);
          seen.idsAtExecution = JSON.stringify(stored?.resourceIds ?? []);
          seen.phaseAtExecution = stored?.phase ?? 'missing';
          seen.planAtExecution = stored?.plan?.planDigest ?? 'missing';
          return { observations: [makeObservation()] };
        },
      },
    });

    const job = await controller.start(principal, request);
    const finished = await controller.run(job.id);

    assert.equal(seen.intentAtAllocation, PLAN_DIGEST);
    assert.equal(seen.idsAtAllocation, '[]');
    assert.equal(seen.idsAtExecution, '["resource-1"]');
    assert.equal(seen.phaseAtExecution, 'Executing');
    assert.equal(seen.planAtExecution, PLAN_DIGEST);
    assert.equal(finished.verdict, 'Verified');
    assert.deepEqual(finished.resourceIds, ['resource-1']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('cancelling is idempotent and closes a job that has not started', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const calls: string[] = [];
    const controller = new PrJobController({
      store,
      resolver: resolver(calls),
      planner: planner(calls),
      executor: executor([makeObservation()], calls),
    });

    const job = await controller.start(principal, request);
    const cancelled = await controller.cancel(principal, job.id);
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.phase, 'Finished');
    assert.equal(cancelled.verdict, 'Incomplete');
    assert.equal(cancelled.failure?.code, 'CANCELLED');

    const again = await controller.cancel(principal, job.id);
    assert.equal(again.id, job.id);
    assert.equal(again.phase, 'Finished');
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a cancel during execution stops the job before it can be verified', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controller = new PrJobController({
      store,
      resolver: resolver(),
      planner: planner(),
      executor: {
        execute: async () => {
          await gate;
          return { observations: [makeObservation()] };
        },
      },
    });

    const job = await controller.start(principal, request);
    const running = controller.run(job.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await controller.cancel(principal, job.id);
    release();
    const finished = await running;

    assert.equal(finished.phase, 'Finished');
    assert.equal(finished.verdict, 'Incomplete');
    assert.notEqual(finished.verdict, 'Verified');
    assert.ok(finished.limitations.some((item) => item.includes('cancelled')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the verdict follows the observations and nothing else', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();

    const runWith = async (observations: CheckObservation[], pullRequest = 7): Promise<PrJob> => {
      const controller = new PrJobController({
        store,
        resolver: {
          resolve: async () => ({ ...candidate, pullRequest }),
        },
        planner: planner(),
        evaluator: evaluator(),
        executor: executor(observations),
      });
      const job = await controller.start(principal, { ...request, pullRequest });
      return controller.run(job.id);
    };

    const passing = await runWith([makeObservation()]);
    assert.equal(passing.verdict, 'Verified');
    assert.equal(passing.result?.verdict, 'Verified');
    assert.equal(passing.result?.cleanupComplete, true);
    assert.equal(passing.result?.superseded, false);

    const failing = await runWith([makeObservation({ status: 'Failed', exitCode: 1 })], 8);
    assert.equal(failing.verdict, 'Failed');

    const unknownCheck = await runWith([makeObservation({ checkId: 'not-in-plan' })], 9);
    assert.equal(unknownCheck.verdict, 'Incomplete');

    const wrongBytes = await runWith([makeObservation({ testContentSha256: '9'.repeat(64) })], 10);
    assert.equal(wrongBytes.verdict, 'Incomplete');

    const notExecuted = await runWith([makeObservation({ executed: false })], 11);
    assert.equal(notExecuted.verdict, 'Incomplete');

    const wrongCommit = await runWith([makeObservation({ commitSha: '7'.repeat(40) })], 12);
    assert.equal(wrongCommit.verdict, 'Incomplete');

    const empty = await runWith([], 13);
    assert.equal(empty.verdict, 'Incomplete');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a missing required check keeps the job incomplete', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const controller = new PrJobController({
      store,
      resolver: resolver(),
      planner: {
        plan: async () => ({
          ...makePlan(),
          requiredChecks: [
            { checkId: 'unit', artifactRef: 'artifacts/unit.json', contentSha256: TEST_SHA, origin: 'approved' },
            { checkId: 'lint', artifactRef: 'artifacts/lint.json', contentSha256: '3'.repeat(64), origin: 'approved' },
          ],
        }),
      },
      evaluator: evaluator(),
      executor: executor([makeObservation()]),
    });

    const job = await controller.start(principal, request);
    const finished = await controller.run(job.id);
    assert.equal(finished.verdict, 'Incomplete');
    assert.ok(finished.limitations.some((item) => item.includes('lint')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('without an evaluator no job can be verified', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const controller = new PrJobController({
      store,
      resolver: resolver(),
      planner: planner(),
      executor: executor([makeObservation()]),
    });

    const job = await controller.start(principal, request);
    const finished = await controller.run(job.id);

    assert.equal(finished.verdict, 'Incomplete');
    assert.notEqual(finished.verdict, 'Verified');
    assert.equal(finished.result?.verdict, 'Incomplete');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a persisted plan is not replaced by a different plan', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const now = new Date().toISOString();
    await store.create({
      id: 'job-pinned',
      ownerId: principal.id,
      request,
      requestKey: 'owner-1|acme/shop|7|' + HEAD_SHA,
      phase: 'Queued',
      cancelRequested: false,
      plan: makePlan('5'.repeat(64)),
      resourceIds: [],
      limitations: [],
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    const controller = new PrJobController({
      store,
      resolver: resolver(),
      planner: planner(),
      executor: executor([makeObservation()]),
    });

    await assert.rejects(
      () => controller.run('job-pinned'),
      (error: unknown) => isControllerError(error, 'PLAN_CONFLICT', 409),
    );
    const stored = await store.get('job-pinned');
    assert.equal(stored.plan?.planDigest, '5'.repeat(64));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a finished job is not run again', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const calls: string[] = [];
    const controller = new PrJobController({
      store,
      resolver: resolver(calls),
      planner: planner(calls),
      executor: executor([makeObservation()], calls),
    });

    const job = await controller.start(principal, request);
    const finished = await controller.run(job.id);
    const again = await controller.run(job.id);
    assert.equal(again.version, finished.version);
    assert.deepEqual(calls, ['resolve', 'plan', 'execute']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the controller lock keeps a second writer out', async () => {
  const directory = await makeTempDir('pr-job-controller');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    const controller = new PrJobController({ store });
    const lock = await store.acquireLock('controller');

    await assert.rejects(
      () => controller.run('job-missing'),
      (error: unknown) => isControllerError(error, 'CONTROLLER_BUSY', 409),
    );
    await store.releaseLock(lock);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
