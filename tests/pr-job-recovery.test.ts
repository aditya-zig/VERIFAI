import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateRevision, CheckPlan } from '../packages/contracts/src/index.js';
import {
  PrJobController,
  PrJobControllerError,
  type PrResourceAdapter,
  type PrResourceState,
} from '../services/pr-verification/controller.js';
import { recoverInterruptedJobs } from '../services/pr-verification/recovery.js';
import { PrJobStore, type PrJob, type RequestPrincipal } from '../services/pr-verification/store.js';

/**
 * Recovery is exercised against a real store on disk with a fake resource
 * adapter. The fake records what it was asked to release, so the assertions
 * are about what was deleted and what was left alone.
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
const TEST_SHA = 'f'.repeat(64);

const candidate: CandidateRevision = {
  repository: 'acme/shop',
  pullRequest: 7,
  headRepository: 'acme/shop',
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  mergeBaseSha: 'c'.repeat(40),
  changedFiles: ['src/app.ts'],
  diffDigest: 'd'.repeat(64),
};

const plan: CheckPlan = {
  policyVersion: 'policy-1',
  profileId: 'default',
  profileDigest: '1'.repeat(64),
  requiredChecks: [
    { checkId: 'unit', artifactRef: 'artifacts/unit.json', contentSha256: TEST_SHA, origin: 'approved' },
  ],
  generatedTests: [],
  planDigest: 'e'.repeat(64),
};

const principal: RequestPrincipal = { id: 'owner-1', kind: 'human', repositories: ['acme/shop'] };

function makeInterruptedJob(overrides: Partial<PrJob> = {}): PrJob {
  const now = new Date().toISOString();
  return {
    id: 'job-interrupted',
    ownerId: principal.id,
    request: { repository: 'acme/shop', pullRequest: 7, expectedHeadSha: HEAD_SHA },
    requestKey: `owner-1|acme/shop|7|${HEAD_SHA}`,
    phase: 'Executing',
    cancelRequested: false,
    candidate,
    plan,
    resourceIds: [],
    limitations: [],
    version: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeResources {
  adapter: PrResourceAdapter;
  released: string[];
  states: Map<string, PrResourceState>;
  inspectFails: boolean;
}

function fakeResources(states: Record<string, PrResourceState>): FakeResources {
  const released: string[] = [];
  const map = new Map(Object.entries(states));
  const fake: FakeResources = {
    released,
    states: map,
    inspectFails: false,
    adapter: {
      allocate: async () => [],
      inspect: async (_jobId, resourceIds) => {
        if (fake.inspectFails) throw new Error('the resource service is unavailable');
        if (resourceIds.length === 0) return [...map.values()];
        return resourceIds.map((id) => map.get(id)).filter((item): item is PrResourceState => Boolean(item));
      },
      release: async (_jobId, resourceIds) => {
        released.push(...resourceIds);
        for (const id of resourceIds) map.delete(id);
        return { released: [...resourceIds], failed: [] };
      },
    },
  };
  return fake;
}

test('an interrupted job is closed as incomplete', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob());

    const outcome = await recoverInterruptedJobs({ store });
    assert.equal(outcome.jobs.length, 1);
    assert.equal(outcome.jobs[0].verdict, 'Incomplete');
    assert.equal(outcome.blocked, false);

    const job = await store.get('job-interrupted');
    assert.equal(job.phase, 'Finished');
    assert.equal(job.verdict, 'Incomplete');
    assert.equal(job.failure?.code, 'INTERRUPTED');
    assert.ok(job.result);
    assert.equal(job.result?.verdict, 'Incomplete');
    assert.deepEqual(job.result?.observations, []);
    assert.equal(job.result?.cleanupComplete, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('resources that are proven to belong to the job are released', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob({ resourceIds: ['resource-1'] }));

    const resources = fakeResources({
      'resource-1': { resourceId: 'resource-1', present: true, owned: true },
    });

    const outcome = await recoverInterruptedJobs({ store, resources: resources.adapter });
    assert.deepEqual(resources.released, ['resource-1']);
    assert.deepEqual(outcome.jobs[0].unresolved, []);
    assert.equal(outcome.jobs[0].cleanupComplete, true);
    assert.equal(outcome.blocked, false);

    const job = await store.get('job-interrupted');
    assert.equal(job.result?.cleanupComplete, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a resource that cannot be proven is not deleted and blocks new work', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob({ resourceIds: ['resource-1'] }));

    const resources = fakeResources({
      'resource-1': { resourceId: 'resource-1', present: true, owned: false },
    });

    const outcome = await recoverInterruptedJobs({ store, resources: resources.adapter });
    assert.deepEqual(resources.released, []);
    assert.deepEqual(outcome.jobs[0].unresolved, ['resource-1']);
    assert.equal(outcome.jobs[0].cleanupComplete, false);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.blockers.length, 1);

    const job = await store.get('job-interrupted');
    assert.equal(job.result?.cleanupComplete, false);

    const controller = new PrJobController({ store });
    await assert.rejects(
      () => controller.start(principal, { ...job.request, pullRequest: 9 }),
      (error: unknown) => {
        if (!(error instanceof PrJobControllerError)) return false;
        if (error.code !== 'CLEANUP_UNRESOLVED') return false;
        return error.status === 409;
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a later recovery clears the blocker once ownership is proven', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob({ resourceIds: ['resource-1'] }));

    const resources = fakeResources({
      'resource-1': { resourceId: 'resource-1', present: true, owned: false },
    });

    const first = await recoverInterruptedJobs({ store, resources: resources.adapter });
    assert.equal(first.blocked, true);
    assert.deepEqual(resources.released, []);

    resources.states.set('resource-1', { resourceId: 'resource-1', present: true, owned: true });
    const second = await recoverInterruptedJobs({ store, resources: resources.adapter });
    assert.deepEqual(resources.released, ['resource-1']);
    assert.equal(second.blocked, false);
    assert.deepEqual(await store.listBlockers(), []);

    const controller = new PrJobController({ store });
    const job = await controller.start(principal, { repository: 'acme/shop', pullRequest: 9, expectedHeadSha: HEAD_SHA });
    assert.equal(job.phase, 'Queued');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('resources are released only when every one of them is proven', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob({ resourceIds: ['resource-1', 'resource-2'] }));

    const resources = fakeResources({
      'resource-1': { resourceId: 'resource-1', present: true, owned: true },
      'resource-2': { resourceId: 'resource-2', present: true, owned: false },
    });

    const outcome = await recoverInterruptedJobs({ store, resources: resources.adapter });
    assert.deepEqual(resources.released, ['resource-1']);
    assert.deepEqual(outcome.jobs[0].unresolved, ['resource-2']);
    assert.equal(outcome.jobs[0].cleanupComplete, false);
    assert.equal(outcome.blocked, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('without a resource adapter the cleanup cannot be proven', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob({ resourceIds: ['resource-1'] }));

    const outcome = await recoverInterruptedJobs({ store });
    assert.deepEqual(outcome.jobs[0].unresolved, ['resource-1']);
    assert.equal(outcome.jobs[0].cleanupComplete, false);
    assert.equal(outcome.blocked, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a resource service that cannot be reached leaves the job unresolved', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob({ resourceIds: ['resource-1'] }));

    const resources = fakeResources({
      'resource-1': { resourceId: 'resource-1', present: true, owned: true },
    });
    resources.inspectFails = true;

    const outcome = await recoverInterruptedJobs({ store, resources: resources.adapter });
    assert.deepEqual(resources.released, []);
    assert.equal(outcome.jobs[0].cleanupComplete, false);
    assert.equal(outcome.blocked, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a queued job is left for the runner unless it is closed on request', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob({ phase: 'Queued', candidate: undefined, plan: undefined }));

    const kept = await recoverInterruptedJobs({ store });
    assert.equal(kept.jobs.length, 0);
    assert.equal((await store.get('job-interrupted')).phase, 'Queued');

    const closed = await recoverInterruptedJobs({ store, queuedJobs: 'close' });
    assert.equal(closed.jobs.length, 1);
    const job = await store.get('job-interrupted');
    assert.equal(job.phase, 'Finished');
    assert.equal(job.verdict, 'Incomplete');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('recovery can be run twice without changing the outcome', async () => {
  const directory = await makeTempDir('pr-job-recovery');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeInterruptedJob({ resourceIds: ['resource-1'] }));

    const resources = fakeResources({
      'resource-1': { resourceId: 'resource-1', present: true, owned: true },
    });

    const first = await recoverInterruptedJobs({ store, resources: resources.adapter });
    const second = await recoverInterruptedJobs({ store, resources: resources.adapter });
    assert.equal(first.jobs.length, 1);
    assert.equal(second.jobs.length, 0);
    assert.deepEqual(resources.released, ['resource-1']);
    assert.equal((await store.get('job-interrupted')).phase, 'Finished');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
