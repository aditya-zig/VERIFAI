import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import { PrJobStore, PrJobStoreError, type PrJob } from '../services/pr-verification/store.js';

/**
 * These tests exercise the store against a real temporary directory. A new
 * store instance over the same directory stands in for a process restart.
 */

interface PrFs {
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, options?: { mode?: number; flag?: string }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mode: number }>;
  symlink(target: string, path: string): Promise<void>;
  mkdir(path: string, options?: { mode?: number }): Promise<void>;
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


function isStoreError(error: unknown, code: string, status?: number): boolean {
  if (!(error instanceof PrJobStoreError)) return false;
  if (error.code !== code) return false;
  if (status !== undefined && error.status !== status) return false;
  return true;
}

function makeJob(overrides: Partial<PrJob> = {}): PrJob {
  return {
    id: 'job-alpha',
    ownerId: 'owner-1',
    request: {
      repository: 'acme/shop',
      pullRequest: 7,
      expectedHeadSha: 'a'.repeat(40),
    },
    requestKey: 'owner-1|acme/shop|7|' + 'a'.repeat(40),
    phase: 'Queued',
    cancelRequested: false,
    resourceIds: [],
    limitations: [],
    version: 0,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

test('a job survives a restart of the process', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());

    const restarted = new PrJobStore({ directory });
    await restarted.init();
    const job = await restarted.get('job-alpha');
    assert.equal(job.id, 'job-alpha');
    assert.equal(job.phase, 'Queued');
    assert.equal(job.request.repository, 'acme/shop');
    assert.equal(job.version, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('initialization refuses linked state directories without changing the target permissions', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const target = join(directory, 'unrelated');
    await fs.mkdir(target, { mode: 0o755 });
    const before = (await fs.stat(target)).mode;
    for (const child of ['', 'jobs', 'locks']) {
      const root = join(directory, `state-${child || 'root'}`);
      if (child) await fs.mkdir(root);
      await fs.symlink(target, child ? join(root, child) : root);
      await assert.rejects(() => new PrJobStore({ directory: root }).init(),
        (error: unknown) => isStoreError(error, 'CORRUPTED_STATE'));
      assert.equal((await fs.stat(target)).mode, before);
      assert.deepEqual(await fs.readdir(target), []);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a copied checksummed record cannot change the requested job identity', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());
    const raw = await fs.readFile(join(directory, 'jobs', 'job-alpha.json'), 'utf8');
    await fs.writeFile(join(directory, 'jobs', 'job-beta.json'), raw);
    await assert.rejects(() => store.get('job-beta'),
      (error: unknown) => isStoreError(error, 'CORRUPTED_STATE'));
    assert.equal((await store.get('job-alpha')).id, 'job-alpha');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('compare-and-swap rejects a stale version', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());

    const updated = await store.update('job-alpha', 0, (draft) => {
      draft.phase = 'Executing';
    });
    assert.equal(updated.version, 1);

    await assert.rejects(
      () => store.update('job-alpha', 0, (draft) => {
        draft.phase = 'Finished';
      }),
      (error: unknown) => isStoreError(error, 'VERSION_CONFLICT', 409),
    );

    const current = await store.get('job-alpha');
    assert.equal(current.phase, 'Executing');
    assert.equal(current.version, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('two writers cannot both win the same version', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const first = new PrJobStore({ directory });
    await first.init();
    await first.create(makeJob());

    const second = new PrJobStore({ directory });
    await second.init();

    const attempts = await Promise.allSettled([
      first.update('job-alpha', 0, (draft) => {
        draft.phase = 'Executing';
      }),
      second.update('job-alpha', 0, (draft) => {
        draft.phase = 'Cleaning';
      }),
    ]);

    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const current = await first.get('job-alpha');
    assert.equal(current.version, 1);
    assert.ok(current.phase === 'Executing' || current.phase === 'Cleaning');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('job ids that could escape the store directory are rejected', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());

    for (const id of ['../escape', 'a/b', '..', '.', '', 'job alpha', 'job.alpha']) {
      await assert.rejects(
        () => store.read(id),
        (error: unknown) => isStoreError(error, 'INVALID_JOB_ID', 400),
      );
    }

    const entries = await fs.readdir(join(directory, 'jobs'));
    assert.deepEqual(entries, ['job-alpha.json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the store keeps its directory and files private', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());

    const directoryMode = (await fs.stat(directory)).mode & 0o777;
    const jobsMode = (await fs.stat(join(directory, 'jobs'))).mode & 0o777;
    const fileMode = (await fs.stat(join(directory, 'jobs', 'job-alpha.json'))).mode & 0o777;

    assert.equal(directoryMode, 0o700);
    assert.equal(jobsMode, 0o700);
    assert.equal(fileMode, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('only one writer holds the controller lock', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();

    const lock = await store.acquireLock('controller');
    await assert.rejects(
      () => store.acquireLock('controller'),
      (error: unknown) => isStoreError(error, 'LOCK_HELD'),
    );

    await store.releaseLock(lock);
    const second = await store.acquireLock('controller');
    assert.equal(second.name, 'controller');
    await store.releaseLock(second);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a lock left behind by a dead process can be broken on request', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await fs.writeFile(
      join(directory, 'locks', 'controller.lock'),
      JSON.stringify({ name: 'controller', owner: 'pid-4194303', pid: 4194303, acquiredAt: '2026-10-21T00:00:00.000Z' }),
      { mode: 0o600 },
    );

    await assert.rejects(
      () => store.acquireLock('controller'),
      (error: unknown) => isStoreError(error, 'LOCK_HELD'),
    );

    const lock = await store.acquireLock('controller', { stealStale: true });
    assert.equal(lock.name, 'controller');
    await store.releaseLock(lock);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a returned job is a deep snapshot', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());

    const snapshot = await store.get('job-alpha');
    snapshot.request.repository = 'attacker/evil';
    snapshot.resourceIds.push('resource-1');
    snapshot.limitations.push('invented');

    const fresh = await store.get('job-alpha');
    assert.equal(fresh.request.repository, 'acme/shop');
    assert.deepEqual(fresh.resourceIds, []);
    assert.deepEqual(fresh.limitations, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('unfinished jobs are listed apart from finished ones', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());
    await store.create(makeJob({ id: 'job-beta', phase: 'Finished' }));

    const unfinished = await store.listUnfinished();
    assert.deepEqual(unfinished.map((job) => job.id), ['job-alpha']);
    assert.equal((await store.list()).length, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('corrupted state is reported instead of being ignored', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());

    const path = join(directory, 'jobs', 'job-alpha.json');
    const raw = await fs.readFile(path, 'utf8');
    await fs.writeFile(path, raw.slice(0, raw.length / 2), { mode: 0o600 });

    await assert.rejects(
      () => store.read('job-alpha'),
      (error: unknown) => isStoreError(error, 'CORRUPTED_STATE'),
    );
    assert.equal(await store.read('job-missing'), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a tampered job body fails its checksum', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());

    const path = join(directory, 'jobs', 'job-alpha.json');
    const envelope = JSON.parse(await fs.readFile(path, 'utf8'));
    envelope.job.request.expectedHeadSha = 'b'.repeat(40);
    await fs.writeFile(path, JSON.stringify(envelope), { mode: 0o600 });

    await assert.rejects(
      () => store.read('job-alpha'),
      (error: unknown) => isStoreError(error, 'CORRUPTED_STATE'),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('only one job may be active at a time', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();
    await store.create(makeJob());

    await assert.rejects(
      () => store.createExclusive(makeJob({ id: 'job-gamma', requestKey: 'owner-1|acme/shop|8|' + 'a'.repeat(40) })),
      (error: unknown) => isStoreError(error, 'ACTIVE_JOB_EXISTS', 409),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('blockers are persisted until they are cleared', async () => {
  const directory = await makeTempDir('pr-job-store');
  try {
    const store = new PrJobStore({ directory });
    await store.init();

    const blocker = await store.addBlocker({
      jobId: 'job-alpha',
      reason: 'resource ownership is unknown',
      resourceIds: ['resource-1'],
    });
    assert.equal((await store.listBlockers()).length, 1);

    const restarted = new PrJobStore({ directory });
    await restarted.init();
    assert.equal((await restarted.listBlockers()).length, 1);

    await store.clearBlocker(blocker.id);
    assert.deepEqual(await store.listBlockers(), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
