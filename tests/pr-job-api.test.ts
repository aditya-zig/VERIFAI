import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateRevision, CheckObservation, CheckPlan } from '../packages/contracts/src/index.js';
import {
  PrJobControllerError,
  PrVerificationController,
  type PrJobEvaluator,
  type PrJobExecutor,
  type PrJobPlanner,
  type PrJobResolver,
} from '../services/pr-verification/controller.js';
import { PrJobStore, type RequestPrincipal } from '../services/pr-verification/store.js';

/**
 * The route facing surface. These tests use the argument order the HTTP
 * layer uses: `start(input, principal, idempotencyKey)`, `get(id, principal)`
 * and `cancel(id, principal)`.
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

const observation: CheckObservation = {
  checkId: 'unit',
  revision: 'head',
  commitSha: HEAD_SHA,
  status: 'Verified',
  executed: true,
  exitCode: 0,
  artifactRefs: ['artifacts/unit.json'],
  commandDigest: '2'.repeat(64),
  testContentSha256: TEST_SHA,
};

const principal: RequestPrincipal = { id: 'owner-1', kind: 'human', repositories: ['acme/shop'] };
const input = { repository: 'acme/shop', pullRequest: 7, expectedHeadSha: HEAD_SHA };

const resolver: PrJobResolver = { resolve: async () => candidate };
const planner: PrJobPlanner = { plan: async () => plan };
const executor: PrJobExecutor = { execute: async () => ({ observations: [observation] }) };
const evaluator: PrJobEvaluator = {
  evaluate: () => ({ verdict: 'Verified', limitations: [] }),
};

function isControllerError(error: unknown, code: string, status?: number): boolean {
  if (!(error instanceof PrJobControllerError)) return false;
  if (error.code !== code) return false;
  if (status !== undefined && error.status !== status) return false;
  return true;
}

async function makeController(): Promise<{ controller: PrVerificationController; directory: string }> {
  const directory = await makeTempDir('pr-job-api');
  const store = new PrJobStore({ directory });
  await store.init();
  const controller = new PrVerificationController({
    store,
    resolver,
    planner,
    executor,
    evaluator,
  });
  return { controller, directory };
}

test('the same idempotency key returns the same job', async () => {
  const { controller, directory } = await makeController();
  try {
    const first = await controller.start(input, principal, 'key-1');
    const second = await controller.start(input, principal, 'key-1');

    assert.equal(first.id, second.id);
    assert.equal((await controller.store.list()).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the same idempotency key with a different payload is refused', async () => {
  const { controller, directory } = await makeController();
  try {
    await controller.start(input, principal, 'key-1');
    await assert.rejects(
      () => controller.start({ ...input, pullRequest: 8 }, principal, 'key-1'),
      (error: unknown) => isControllerError(error, 'IDEMPOTENCY_KEY_REUSED', 409),
    );
    assert.equal((await controller.store.list()).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an unusable idempotency key is refused', async () => {
  const { controller, directory } = await makeController();
  try {
    for (const key of ['', 'has space', 'a'.repeat(201)]) {
      await assert.rejects(
        () => controller.start(input, principal, key),
        (error: unknown) => isControllerError(error, 'INVALID_REQUEST', 400),
      );
    }
    assert.equal((await controller.store.list()).length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an idempotency key is scoped to the principal', async () => {
  const { controller, directory } = await makeController();
  try {
    const first = await controller.start(input, principal, 'key-1');
    await controller.run(first.id);

    const second = await controller.start(
      input,
      { id: 'owner-2', kind: 'agent', repositories: ['acme/shop'] },
      'key-1',
    );
    assert.notEqual(second.id, first.id);
    assert.equal(second.ownerId, 'owner-2');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('get and cancel take the id and the principal', async () => {
  const { controller, directory } = await makeController();
  try {
    const job = await controller.start(input, principal, 'key-1');

    const stranger: RequestPrincipal = { id: 'owner-9', kind: 'agent', repositories: ['other/repo'] };
    await assert.rejects(
      () => controller.get(job.id, stranger),
      (error: unknown) => isControllerError(error, 'JOB_ACCESS_DENIED', 403),
    );
    await assert.rejects(
      () => controller.cancel(job.id, stranger),
      (error: unknown) => isControllerError(error, 'JOB_ACCESS_DENIED', 403),
    );

    const fetched = await controller.get(job.id, principal);
    assert.equal(fetched.id, job.id);

    const cancelled = await controller.cancel(job.id, principal);
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.phase, 'Finished');
    assert.equal(cancelled.verdict, 'Incomplete');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('waitForIdle settles the queue and returns nothing unfinished', async () => {
  const { controller, directory } = await makeController();
  try {
    const job = await controller.start(input, principal, 'key-1');
    assert.equal(job.phase, 'Queued');

    const unfinished = await controller.waitForIdle({ timeoutMs: 10_000 });
    assert.deepEqual(unfinished, []);

    const settled = await controller.get(job.id, principal);
    assert.equal(settled.phase, 'Finished');
    assert.equal(settled.verdict, 'Verified');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('waitForIdle reports a timeout when nothing drives the queue', async () => {
  const { controller, directory } = await makeController();
  try {
    await controller.start(input, principal, 'key-1');
    await assert.rejects(
      () => controller.waitForIdle({ timeoutMs: 120, pollMs: 10, drive: false }),
      (error: unknown) => isControllerError(error, 'WAIT_TIMEOUT', 504),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
