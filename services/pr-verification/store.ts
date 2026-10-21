import { createHash, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CandidateRevision,
  CheckPlan,
  PrJobPhase,
  PrVerificationRequest,
  PrVerificationResult,
  PrVerdict,
} from '../../packages/contracts/src/index.js';

/**
 * Durable state for pull request verification jobs.
 *
 * The store is intentionally boring: one JSON file per job, written with a
 * temporary file plus rename, guarded by a compare-and-swap on the job
 * version. It never executes anything and never talks to GitHub. It only
 * records what the controller believes happened, so an interrupted process
 * leaves a readable trail instead of a silent gap.
 */

/**
 * The repository has no `@types/node`, so node builtins are typed by the
 * project shim. These narrow declarations keep the calls we rely on visible
 * to the compiler without editing files outside this slice.
 */
interface PrFileHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface PrFileSystem {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  open(path: string, flags: string, mode?: number): Promise<PrFileHandle>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, options?: { mode?: number; flag?: string }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<{ mode: number }>;
  chmod(path: string, mode: number): Promise<void>;
}

const fs = nodeFs as unknown as PrFileSystem;

/**
 * The caller that asks for a verification. The store keeps the principal so
 * that ownership survives a restart, but it never treats the principal as
 * proof of anything: authorization is re-checked at the request boundary.
 */
export interface RequestPrincipal {
  id: string;
  kind: 'human' | 'agent';
  repositories: string[];
}

/**
 * What a job intends to allocate before anything is allocated. Persisting the
 * intent first is what makes an interrupted allocation recoverable: recovery
 * can ask the resource adapter what it owns for this job even when the
 * allocated identifiers were never written back.
 */
export interface PrJobResourceIntent {
  purpose: 'verification-execution';
  repository: string;
  headSha: string;
  planDigest: string;
}

export interface PrJob {
  id: string;
  ownerId: string;
  request: PrVerificationRequest;
  /** Stable key used to make `start` idempotent for one principal and request. */
  requestKey: string;
  phase: PrJobPhase;
  cancelRequested: boolean;
  candidate?: CandidateRevision;
  plan?: CheckPlan;
  resourceIntent?: PrJobResourceIntent;
  resourceIds: string[];
  result?: PrVerificationResult;
  /** The job level outcome. It is set when the job reaches `Finished`. */
  verdict?: PrVerdict;
  failure?: { code: string; message: string };
  limitations: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A recorded reason why new work must not start. Unknown resource ownership
 * is the only blocker today: if cleanup cannot be proven, the controller
 * refuses to admit another job rather than leak resources in the dark.
 */
export interface PrJobBlocker {
  id: string;
  jobId: string;
  reason: string;
  resourceIds: string[];
  since: string;
}

export type PrJobStoreErrorCode =
  | 'INVALID_JOB_ID'
  | 'JOB_NOT_FOUND'
  | 'JOB_EXISTS'
  | 'VERSION_CONFLICT'
  | 'CORRUPTED_STATE'
  | 'ACTIVE_JOB_EXISTS'
  | 'LOCK_HELD'
  | 'LOCK_NOT_HELD'
  | 'INVALID_JOB_STATE';

export class PrJobStoreError extends Error {
  readonly code: PrJobStoreErrorCode;
  readonly status: number;

  constructor(code: PrJobStoreErrorCode, message: string, status = 500) {
    super(message);
    this.name = 'PrJobStoreError';
    this.code = code;
    this.status = status;
  }
}

export interface PrJobStoreOptions {
  directory: string;
  now?: () => Date;
  idFactory?: () => string;
}

export interface PrJobStoreLock {
  name: string;
  owner: string;
  pid: number;
  acquiredAt: string;
}

export interface PrJobStoreLockOptions {
  /** Break a lock whose owner process is gone. Off by default. */
  stealStale?: boolean;
  /** Milliseconds to wait for a busy lock before giving up. */
  waitMs?: number;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MUTATION_LOCK_NAME = 'store-mutation';
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOCK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PHASES: readonly PrJobPhase[] = ['Queued', 'Resolving', 'Planning', 'Executing', 'Cleaning', 'Finished'];
const TERMINAL_PHASE: PrJobPhase = 'Finished';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Stable JSON so that a checksum does not depend on key order. Two records
 * with the same content always produce the same digest.
 */
function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function assertSafeJobId(id: unknown): string {
  if (typeof id !== 'string' || !JOB_ID_PATTERN.test(id)) {
    throw new PrJobStoreError('INVALID_JOB_ID', 'job id must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/', 400);
  }
  return id;
}

function assertSafeLockName(name: unknown): string {
  if (typeof name !== 'string' || !LOCK_NAME_PATTERN.test(name)) {
    throw new PrJobStoreError('INVALID_JOB_ID', 'lock name must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/', 400);
  }
  return name;
}

function assertJobShape(job: unknown): asserts job is PrJob {
  if (!isRecord(job)) throw new PrJobStoreError('CORRUPTED_STATE', 'stored job is not an object');
  if (typeof job.id !== 'string' || !JOB_ID_PATTERN.test(job.id)) {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has an invalid id');
  }
  if (typeof job.ownerId !== 'string' || job.ownerId.length === 0) {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has no owner');
  }
  if (!isRecord(job.request)) throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has no request');
  if (typeof job.request.repository !== 'string' || typeof job.request.expectedHeadSha !== 'string') {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job request is malformed');
  }
  if (typeof job.phase !== 'string' || !PHASES.includes(job.phase as PrJobPhase)) {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has an unknown phase');
  }
  if (typeof job.cancelRequested !== 'boolean') {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has a malformed cancel flag');
  }
  if (!Array.isArray(job.resourceIds) || job.resourceIds.some((item) => typeof item !== 'string')) {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has malformed resource ids');
  }
  if (!Array.isArray(job.limitations) || job.limitations.some((item) => typeof item !== 'string')) {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has malformed limitations');
  }
  if (typeof job.version !== 'number' || !Number.isSafeInteger(job.version) || job.version < 0) {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has an invalid version');
  }
  if (typeof job.createdAt !== 'string' || typeof job.updatedAt !== 'string') {
    throw new PrJobStoreError('CORRUPTED_STATE', 'stored job has invalid timestamps');
  }
}

export class PrJobStore {
  readonly directory: string;
  readonly #jobsDirectory: string;
  readonly #locksDirectory: string;
  readonly #blockersPath: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  #queue: Promise<unknown> = Promise.resolve();
  #temporaryCounter = 0;

  constructor(options: PrJobStoreOptions) {
    this.directory = options.directory;
    this.#jobsDirectory = join(options.directory, 'jobs');
    this.#locksDirectory = join(options.directory, 'locks');
    this.#blockersPath = join(options.directory, 'blockers.json');
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `job-${randomUUID()}`);
  }

  /** Create the private directory layout. Safe to call more than once. */
  async init(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(this.directory, DIRECTORY_MODE);
    await fs.mkdir(this.#jobsDirectory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(this.#jobsDirectory, DIRECTORY_MODE);
    await fs.mkdir(this.#locksDirectory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(this.#locksDirectory, DIRECTORY_MODE);
  }

  newJobId(): string {
    return assertSafeJobId(this.#idFactory());
  }

  /**
   * Serialize mutations inside this process. The file lock protects across
   * processes; this queue protects against two interleaved writers in one
   * process, which the file system alone cannot order.
   */
  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#queue = previous.then(() => current, () => current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Hold the store wide mutation lock while a read-check-write happens.
   *
   * The compare-and-swap is only honest when the read and the write are one
   * critical section. The in-process queue cannot order two store instances
   * or two processes, so the exclusion is done with an exclusively created
   * lock file.
   */
  async #withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(MUTATION_LOCK_NAME, {
      waitMs: 10_000,
      stealStale: true,
    });
    try {
      return await operation();
    } finally {
      await this.releaseLock(lock);
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #jobPath(id: string): string {
    return join(this.#jobsDirectory, `${assertSafeJobId(id)}.json`);
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await fs.open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Write a file so that a reader either sees the old content or the new
   * content, never a half written file. The temporary file is fsynced before
   * the rename and the directory is fsynced after it.
   */
  async #writeAtomic(path: string, contents: string): Promise<void> {
    this.#temporaryCounter += 1;
    const temporary = `${path}.tmp-${process.pid}-${this.#temporaryCounter}`;
    const handle = await fs.open(temporary, 'wx', FILE_MODE);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path);
    await fs.chmod(path, FILE_MODE);
    await this.#syncDirectory(dirname(path));
  }

  async #readJobFile(id: string): Promise<PrJob> {
    const path = this.#jobPath(id);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new PrJobStoreError('JOB_NOT_FOUND', `job ${id} does not exist`, 404);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PrJobStoreError('CORRUPTED_STATE', `job ${id} is not readable JSON`, 500);
    }
    if (!isRecord(parsed) || typeof parsed.checksum !== 'string' || !isRecord(parsed.job)) {
      throw new PrJobStoreError('CORRUPTED_STATE', `job ${id} has an invalid envelope`, 500);
    }
    if (digest(parsed.job) !== parsed.checksum) {
      throw new PrJobStoreError('CORRUPTED_STATE', `job ${id} failed its checksum`, 500);
    }
    assertJobShape(parsed.job);
    return parsed.job as PrJob;
  }

  async #writeJobFile(job: PrJob): Promise<void> {
    const payload = deepClone(job);
    const envelope = { checksum: digest(payload), job: payload };
    await this.#writeAtomic(this.#jobPath(job.id), `${stableJson(envelope)}\n`);
  }

  /** Read one job. Returns null when the job does not exist. */
  async read(id: string): Promise<PrJob | null> {
    assertSafeJobId(id);
    try {
      return deepClone(await this.#readJobFile(id));
    } catch (error) {
      if (error instanceof PrJobStoreError && error.code === 'JOB_NOT_FOUND') return null;
      throw error;
    }
  }

  /** Read one job or fail with `JOB_NOT_FOUND`. */
  async get(id: string): Promise<PrJob> {
    assertSafeJobId(id);
    return deepClone(await this.#readJobFile(id));
  }

  /**
   * Create a job at version 0. Fails when the identifier is already taken so a
   * second writer cannot silently overwrite a record.
   */
  async create(job: PrJob): Promise<PrJob> {
    assertSafeJobId(job.id);
    return this.#serialized(() =>
      this.#withMutationLock(async () => {
        const existing = await this.read(job.id);
        if (existing) throw new PrJobStoreError('JOB_EXISTS', `job ${job.id} already exists`, 409);
        const created: PrJob = {
          ...deepClone(job),
          version: 0,
          createdAt: job.createdAt ?? this.#timestamp(),
          updatedAt: job.updatedAt ?? this.#timestamp(),
        };
        await this.#writeJobFile(created);
        return deepClone(created);
      }),
    );
  }

  /**
   * Compare-and-swap. The write only lands when the stored version still
   * equals `expectedVersion`, so two writers cannot both win.
   */
  async update(id: string, expectedVersion: number, mutate: (job: PrJob) => PrJob | void): Promise<PrJob> {
    assertSafeJobId(id);
    return this.#serialized(() =>
      this.#withMutationLock(async () => {
        const current = await this.#readJobFile(id);
        if (current.version !== expectedVersion) {
          throw new PrJobStoreError(
            'VERSION_CONFLICT',
            `job ${id} is at version ${current.version}, expected ${expectedVersion}`,
            409,
          );
        }
        const draft = deepClone(current);
        const mutated = mutate(draft) ?? draft;
        const next: PrJob = {
          ...deepClone(mutated),
          id: current.id,
          version: current.version + 1,
          updatedAt: this.#timestamp(),
        };
        assertJobShape(next);
        await this.#writeJobFile(next);
        return deepClone(next);
      }),
    );
  }

  /**
   * Apply a mutation with a bounded retry. The retry re-reads the record, so
   * the caller still gets a compare-and-swap guarantee per attempt.
   */
  async mutate(id: string, mutate: (job: PrJob) => PrJob | void, attempts = 8): Promise<PrJob> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await this.get(id);
      try {
        return await this.update(id, current.version, mutate);
      } catch (error) {
        if (!(error instanceof PrJobStoreError) || error.code !== 'VERSION_CONFLICT') throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new PrJobStoreError('VERSION_CONFLICT', `job ${id} could not be updated`, 409);
  }

  /** Every job on disk, ordered by identifier. */
  async list(): Promise<PrJob[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.#jobsDirectory);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return [];
      throw error;
    }
    const jobs: PrJob[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!JOB_ID_PATTERN.test(id)) continue;
      jobs.push(deepClone(await this.#readJobFile(id)));
    }
    return jobs;
  }

  /** Jobs that have not reached the terminal phase. */
  async listUnfinished(): Promise<PrJob[]> {
    const jobs = await this.list();
    return jobs.filter((job) => job.phase !== TERMINAL_PHASE);
  }

  async findByRequestKey(requestKey: string): Promise<PrJob | null> {
    const jobs = await this.list();
    return jobs.find((job) => job.requestKey === requestKey) ?? null;
  }

  /**
   * Create a job only when it is the only job in flight. The check and the
   * write happen inside one serialized section, so two concurrent callers
   * cannot both be admitted.
   */
  async createExclusive(job: PrJob): Promise<PrJob> {
    assertSafeJobId(job.id);
    return this.#serialized(() =>
      this.#withMutationLock(async () => {
        const existing = await this.read(job.id);
        if (existing) throw new PrJobStoreError('JOB_EXISTS', `job ${job.id} already exists`, 409);
        const jobs = await this.list();
        const sameRequest = jobs.find((item) => item.requestKey === job.requestKey);
        if (sameRequest) return deepClone(sameRequest);
        const active = jobs.find((item) => item.phase !== TERMINAL_PHASE && item.id !== job.id);
        if (active) {
          throw new PrJobStoreError(
            'ACTIVE_JOB_EXISTS',
            `job ${active.id} is still ${active.phase}; only one verification job may run at a time`,
            409,
          );
        }
        const created: PrJob = {
          ...deepClone(job),
          version: 0,
          createdAt: job.createdAt ?? this.#timestamp(),
          updatedAt: job.updatedAt ?? this.#timestamp(),
        };
        await this.#writeJobFile(created);
        return deepClone(created);
      }),
    );
  }

  async #readBlockers(): Promise<PrJobBlocker[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#blockersPath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PrJobStoreError('CORRUPTED_STATE', 'blocker file is not readable JSON', 500);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.blockers)) {
      throw new PrJobStoreError('CORRUPTED_STATE', 'blocker file has an invalid shape', 500);
    }
    return parsed.blockers as PrJobBlocker[];
  }

  async #writeBlockers(blockers: PrJobBlocker[]): Promise<void> {
    const payload = deepClone(blockers);
    await this.#writeAtomic(this.#blockersPath, `${stableJson({ blockers: payload })}\n`);
  }

  /** Reasons why new work must not start. */
  async listBlockers(): Promise<PrJobBlocker[]> {
    return deepClone(await this.#readBlockers());
  }

  async addBlocker(blocker: Omit<PrJobBlocker, 'id' | 'since'> & { id?: string; since?: string }): Promise<PrJobBlocker> {
    return this.#serialized(() =>
      this.#withMutationLock(async () => {
        const blockers = await this.#readBlockers();
        const id = blocker.id ?? `blocker-${randomUUID()}`;
        if (blockers.some((item) => item.id === id)) {
          const existing = blockers.find((item) => item.id === id);
          return deepClone(existing as PrJobBlocker);
        }
        const created: PrJobBlocker = {
          id,
          jobId: blocker.jobId,
          reason: blocker.reason,
          resourceIds: [...blocker.resourceIds],
          since: blocker.since ?? this.#timestamp(),
        };
        blockers.push(created);
        await this.#writeBlockers(blockers);
        return deepClone(created);
      }),
    );
  }

  async clearBlocker(id: string): Promise<void> {
    await this.#serialized(() =>
      this.#withMutationLock(async () => {
        const blockers = await this.#readBlockers();
        const remaining = blockers.filter((item) => item.id !== id);
        if (remaining.length === blockers.length) return;
        await this.#writeBlockers(remaining);
      }),
    );
  }

  #lockPath(name: string): string {
    return join(this.#locksDirectory, `${assertSafeLockName(name)}.lock`);
  }

  /**
   * Take the single writer lock. The lock file is created exclusively, so
   * only one controller can hold it. A lock whose owner process is gone can
   * be broken on request, which is what a crashed controller leaves behind.
   */
  async acquireLock(name: string, options: PrJobStoreLockOptions = {}): Promise<PrJobStoreLock> {
    const lockName = assertSafeLockName(name);
    const path = this.#lockPath(lockName);
    const waitMs = options.waitMs ?? 0;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const lock: PrJobStoreLock = {
        name: lockName,
        owner: `pid-${process.pid}`,
        pid: process.pid,
        acquiredAt: this.#timestamp(),
      };
      try {
        // One exclusive write so a reader never sees a half written lock.
        await fs.writeFile(path, `${stableJson(lock)}\n`, { flag: 'wx', mode: FILE_MODE });
        return lock;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
        if (options.stealStale && (await this.#isLockStale(path))) {
          await fs.rm(path, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new PrJobStoreError('LOCK_HELD', `lock ${lockName} is held by another writer`, 409);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  async #isLockStale(path: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch {
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return true;
    }
    if (!isRecord(parsed) || typeof parsed.pid !== 'number') return true;
    try {
      process.kill(parsed.pid, 0);
      return false;
    } catch (error) {
      return hasErrorCode(error, 'ESRCH');
    }
  }

  async releaseLock(lock: PrJobStoreLock): Promise<void> {
    const path = this.#lockPath(lock.name);
    let raw: string | null = null;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as PrJobStoreLock;
        if (parsed.pid !== lock.pid || parsed.acquiredAt !== lock.acquiredAt) {
          throw new PrJobStoreError('LOCK_NOT_HELD', `lock ${lock.name} is held by another writer`, 409);
        }
      } catch (error) {
        if (error instanceof PrJobStoreError) throw error;
        throw new PrJobStoreError('CORRUPTED_STATE', `lock ${lock.name} is not readable JSON`, 500);
      }
    }
    await fs.rm(path, { force: true });
  }

  /** Read the current lock, if any. */
  async readLock(name: string): Promise<PrJobStoreLock | null> {
    const path = this.#lockPath(name);
    try {
      const raw = await fs.readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as PrJobStoreLock;
      if (!isRecord(parsed) || typeof parsed.pid !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }
}
