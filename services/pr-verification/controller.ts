import { createHash } from 'node:crypto';
import type {
  CandidateRevision,
  CheckObservation,
  CheckPlan,
  PrJobPhase,
  PrVerificationRequest,
  PrVerificationResult,
  PrVerdict,
} from '../../packages/contracts/src/index.js';
import {
  PrJobStore,
  PrJobStoreError,
  type PrJob,
  type PrJobResourceIntent,
  type PrJobStoreLock,
  type RequestPrincipal,
} from './store.js';

/**
 * Controller for pull request verification jobs.
 *
 * The controller owns admission, authorization, phase transitions and the
 * verdict rules. It does not own GitHub access, planning or execution: those
 * arrive as injected adapters so the same controller can be exercised
 * without a network, without a runner and without inventing evidence.
 *
 * Two rules shape everything below.
 *
 * First, the controller never claims a check ran when it did not. A missing
 * executor ends the job as `Incomplete`. The only path to `Verified` is a
 * complete set of executed observations that match the persisted plan.
 *
 * Second, the controller never starts side effects before the state that
 * explains them is durable. `Queued` is written before the resolver runs,
 * the resource intent is written before anything is allocated, and the
 * allocated identifiers are written before the executor is called.
 */

export interface PrJobResolver {
  resolve(input: {
    job: PrJob;
    request: PrVerificationRequest;
    signal: AbortSignal;
  }): Promise<CandidateRevision>;
}

export interface PrJobPlanner {
  plan(input: { job: PrJob; candidate: CandidateRevision; signal: AbortSignal }): Promise<CheckPlan>;
}

export interface PrJobExecutionOutcome {
  observations: CheckObservation[];
  /** True when the candidate was superseded while the checks ran. */
  superseded?: boolean;
  limitations?: string[];
}

export interface PrJobExecutor {
  execute(input: {
    job: PrJob;
    candidate: CandidateRevision;
    plan: CheckPlan;
    signal: AbortSignal;
  }): Promise<PrJobExecutionOutcome>;
}

/**
 * One resource and what can be proven about it. `owned` means the adapter
 * can prove the resource belongs to the job. An unproven resource is never
 * deleted: it blocks new work instead.
 */
export interface PrResourceState {
  resourceId: string;
  present: boolean;
  owned: boolean;
}

export interface PrResourceReleaseReport {
  released: string[];
  failed: string[];
}

export interface PrResourceAdapter {
  allocate(jobId: string, intent: PrJobResourceIntent): Promise<string[]>;
  inspect(jobId: string, resourceIds: readonly string[]): Promise<PrResourceState[]>;
  release(jobId: string, resourceIds: readonly string[]): Promise<PrResourceReleaseReport>;
}

export type PrJobControllerErrorCode =
  | 'INVALID_PRINCIPAL'
  | 'INVALID_REQUEST'
  | 'REPOSITORY_NOT_AUTHORIZED'
  | 'JOB_NOT_FOUND'
  | 'JOB_ACCESS_DENIED'
  | 'ACTIVE_JOB_EXISTS'
  | 'CLEANUP_UNRESOLVED'
  | 'JOB_NOT_QUEUED'
  | 'PLAN_CONFLICT'
  | 'CONTROLLER_BUSY'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'WAIT_TIMEOUT';

export class PrJobControllerError extends Error {
  readonly code: PrJobControllerErrorCode;
  readonly status: number;

  constructor(code: PrJobControllerErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'PrJobControllerError';
    this.code = code;
    this.status = status;
  }
}

export interface PrJobControllerOptions {
  store: PrJobStore;
  resolver?: PrJobResolver;
  planner?: PrJobPlanner;
  executor?: PrJobExecutor;
  resources?: PrResourceAdapter;
  /**
   * The verdict policy. Without one the job can only end as `Incomplete` or
   * `Failed`. See `PrJobEvaluator`.
   */
  evaluator?: PrJobEvaluator;
  /** Name of the single writer lock. Defaults to `controller`. */
  lockName?: string;
}

export interface PrJobRunOptions {
  /** Milliseconds to wait for the single writer lock. */
  lockWaitMs?: number;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,37}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/**
 * The request key makes `start` idempotent for one principal and one pull
 * request. The head SHA is part of the key, so a new push is a new request
 * and not a replay of the old one.
 */
export function buildRequestKey(ownerId: string, request: PrVerificationRequest): string {
  return [
    'derived',
    ownerId,
    request.repository.toLowerCase(),
    String(request.pullRequest),
    request.expectedHeadSha.toLowerCase(),
  ].join('|');
}

/**
 * The request key for a caller supplied idempotency key. The key is scoped
 * to the principal so two owners may use the same client key.
 */
export function buildIdempotentRequestKey(ownerId: string, idempotencyKey: string): string {
  return ['idem', ownerId, idempotencyKey].join('|');
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function assertIdempotencyKey(idempotencyKey: unknown): string {
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new PrJobControllerError(
      'INVALID_REQUEST',
      'the idempotency key must be 1 to 200 characters of letters, digits, dot, underscore, colon or dash',
      400,
    );
  }
  return idempotencyKey;
}

function sameRequest(left: PrVerificationRequest, right: PrVerificationRequest): boolean {
  return (
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.pullRequest === right.pullRequest &&
    left.expectedHeadSha.toLowerCase() === right.expectedHeadSha.toLowerCase()
  );
}

function assertPrincipal(principal: RequestPrincipal): string {
  if (!isRecord(principal)) throw new PrJobControllerError('INVALID_PRINCIPAL', 'principal must be an object', 400);
  if (typeof principal.id !== 'string' || principal.id.trim().length === 0) {
    throw new PrJobControllerError('INVALID_PRINCIPAL', 'principal id is required', 400);
  }
  if (principal.kind !== 'human' && principal.kind !== 'agent') {
    throw new PrJobControllerError('INVALID_PRINCIPAL', 'principal kind must be human or agent', 400);
  }
  if (!Array.isArray(principal.repositories) || principal.repositories.some((item) => typeof item !== 'string')) {
    throw new PrJobControllerError('INVALID_PRINCIPAL', 'principal repositories must be a list of strings', 400);
  }
  return principal.id;
}

function normalizeRequest(request: PrVerificationRequest): PrVerificationRequest {
  if (!isRecord(request)) throw new PrJobControllerError('INVALID_REQUEST', 'request must be an object', 400);
  if (typeof request.repository !== 'string' || !REPOSITORY_PATTERN.test(request.repository)) {
    throw new PrJobControllerError('INVALID_REQUEST', 'repository must be owner/name', 400);
  }
  if (typeof request.pullRequest !== 'number' || !Number.isSafeInteger(request.pullRequest) || request.pullRequest <= 0) {
    throw new PrJobControllerError('INVALID_REQUEST', 'pullRequest must be a positive integer', 400);
  }
  if (typeof request.expectedHeadSha !== 'string' || !SHA_PATTERN.test(request.expectedHeadSha)) {
    throw new PrJobControllerError('INVALID_REQUEST', 'expectedHeadSha must be a 40 character commit SHA', 400);
  }
  return {
    repository: request.repository,
    pullRequest: request.pullRequest,
    expectedHeadSha: request.expectedHeadSha.toLowerCase(),
  };
}

/**
 * Repository access is the only authorization this slice implements. The
 * principal carries the repositories it may touch; nothing else is trusted.
 */
export function assertRepositoryAccess(principal: RequestPrincipal, repository: string): void {
  const wanted = repository.toLowerCase();
  const allowed = principal.repositories.some((item) => item.toLowerCase() === wanted);
  if (!allowed) {
    throw new PrJobControllerError(
      'REPOSITORY_NOT_AUTHORIZED',
      `principal ${principal.id} is not authorized for ${repository}`,
      403,
    );
  }
}

function assertJobAccess(principal: RequestPrincipal, job: PrJob): void {
  if (job.ownerId === principal.id) return;
  try {
    assertRepositoryAccess(principal, job.request.repository);
  } catch {
    throw new PrJobControllerError('JOB_ACCESS_DENIED', `job ${job.id} belongs to ${job.ownerId}`, 403);
  }
}

function assertCandidate(candidate: CandidateRevision, request: PrVerificationRequest): void {
  if (!isRecord(candidate)) throw new PrJobControllerError('INVALID_REQUEST', 'candidate is not an object', 502);
  if (typeof candidate.repository !== 'string' || candidate.repository.toLowerCase() !== request.repository.toLowerCase()) {
    throw new PrJobControllerError('INVALID_REQUEST', 'candidate repository does not match the request', 502);
  }
  if (candidate.pullRequest !== request.pullRequest) {
    throw new PrJobControllerError('INVALID_REQUEST', 'candidate pull request does not match the request', 502);
  }
  if (typeof candidate.headSha !== 'string' || candidate.headSha.toLowerCase() !== request.expectedHeadSha) {
    throw new PrJobControllerError('INVALID_REQUEST', 'candidate head does not match the expected head', 409);
  }
  if (typeof candidate.baseSha !== 'string' || !SHA_PATTERN.test(candidate.baseSha)) {
    throw new PrJobControllerError('INVALID_REQUEST', 'candidate base SHA is invalid', 502);
  }
  if (typeof candidate.mergeBaseSha !== 'string' || !SHA_PATTERN.test(candidate.mergeBaseSha)) {
    throw new PrJobControllerError('INVALID_REQUEST', 'candidate merge base SHA is invalid', 502);
  }
  if (!Array.isArray(candidate.changedFiles)) {
    throw new PrJobControllerError('INVALID_REQUEST', 'candidate changed files are invalid', 502);
  }
  if (typeof candidate.diffDigest !== 'string' || !DIGEST_PATTERN.test(candidate.diffDigest)) {
    throw new PrJobControllerError('INVALID_REQUEST', 'candidate diff digest is invalid', 502);
  }
}

function assertPlan(plan: CheckPlan): void {
  if (!isRecord(plan)) throw new PrJobControllerError('INVALID_REQUEST', 'plan is not an object', 502);
  if (typeof plan.policyVersion !== 'string' || plan.policyVersion.length === 0) {
    throw new PrJobControllerError('INVALID_REQUEST', 'plan policy version is missing', 502);
  }
  if (typeof plan.profileId !== 'string' || plan.profileId.length === 0) {
    throw new PrJobControllerError('INVALID_REQUEST', 'plan profile id is missing', 502);
  }
  if (typeof plan.planDigest !== 'string' || !DIGEST_PATTERN.test(plan.planDigest)) {
    throw new PrJobControllerError('INVALID_REQUEST', 'plan digest is invalid', 502);
  }
  if (!Array.isArray(plan.requiredChecks) || !Array.isArray(plan.generatedTests)) {
    throw new PrJobControllerError('INVALID_REQUEST', 'plan checks are invalid', 502);
  }
  for (const definition of [...plan.requiredChecks, ...plan.generatedTests]) {
    if (!isRecord(definition) || typeof definition.checkId !== 'string' || definition.checkId.length === 0) {
      throw new PrJobControllerError('INVALID_REQUEST', 'plan check id is missing', 502);
    }
    if (typeof definition.contentSha256 !== 'string' || !DIGEST_PATTERN.test(definition.contentSha256)) {
      throw new PrJobControllerError('INVALID_REQUEST', `plan check ${definition.checkId} has no content digest`, 502);
    }
  }
}

function findCheck(plan: CheckPlan, checkId: string): { checkId: string; contentSha256: string } | undefined {
  for (const definition of [...plan.requiredChecks, ...plan.generatedTests]) {
    if (definition.checkId === checkId) return definition;
  }
  return undefined;
}

export interface PrJobEvaluationInput {
  job: PrJob;
  candidate: CandidateRevision;
  plan: CheckPlan;
  observations: readonly CheckObservation[];
  cancelled: boolean;
  cleanupComplete: boolean;
  limitations: readonly string[];
}

export interface PrJobEvaluation {
  verdict: PrVerdict;
  limitations: string[];
}

/**
 * The policy seam.
 *
 * The verdict of a finished job belongs to an injected evaluator, not to
 * this module. The policy worker supplies one. Without an evaluator no job
 * can become `Verified`.
 */
export interface PrJobEvaluator {
  evaluate(input: PrJobEvaluationInput): PrJobEvaluation;
}

/**
 * The conservative fallback used when no evaluator is configured.
 *
 * This is not a success policy and it never claims one. It reports what it
 * can prove from the observations and stops at `Incomplete`. An observation
 * that states a failure is reported as `Failed`, because that is a fact in
 * the record rather than a judgement about the pull request.
 *
 * The only path to `Verified` is an injected evaluator that is given the
 * same facts.
 */
export function evaluateObservations(input: {
  plan: CheckPlan;
  candidate: CandidateRevision;
  observations: readonly CheckObservation[];
  cancelled: boolean;
  cleanupComplete: boolean;
  limitations?: readonly string[];
}): PrJobEvaluation {
  const limitations: string[] = [...(input.limitations ?? [])];
  const problems: string[] = [];
  let sawFailure = false;

  for (const observation of input.observations) {
    if (!isRecord(observation) || typeof observation.checkId !== 'string') {
      problems.push('an observation is malformed');
      continue;
    }
    const definition = findCheck(input.plan, observation.checkId);
    if (!definition) {
      problems.push(`observation ${observation.checkId} is not part of the plan`);
      continue;
    }
    if (observation.testContentSha256 !== definition.contentSha256) {
      problems.push(`observation ${observation.checkId} does not match the planned test bytes`);
    }
    if (observation.revision === 'head' && observation.commitSha !== input.candidate.headSha) {
      problems.push(`observation ${observation.checkId} does not reference the candidate head`);
    }
    if (observation.revision === 'base' && observation.commitSha !== input.candidate.baseSha) {
      problems.push(`observation ${observation.checkId} does not reference the candidate base`);
    }
    if (observation.executed !== true) {
      problems.push(`observation ${observation.checkId} was not executed`);
    }
    if (observation.status === 'Failed') sawFailure = true;
  }

  for (const required of input.plan.requiredChecks) {
    const matching = input.observations.filter(
      (observation) => observation.checkId === required.checkId && observation.revision === 'head',
    );
    const executed = matching.find((observation) => observation.executed === true && observation.status === 'Verified');
    if (!executed) {
      problems.push(`required check ${required.checkId} has no executed passing observation`);
    }
  }

  for (const problem of problems) {
    if (!limitations.includes(problem)) limitations.push(problem);
  }

  if (input.cancelled && !limitations.includes('the job was cancelled before it completed')) {
    limitations.push('the job was cancelled before it completed');
  }
  if (!input.cleanupComplete && !limitations.includes('resource cleanup did not complete')) {
    limitations.push('resource cleanup did not complete');
  }
  if (input.observations.length === 0 && !limitations.includes('no check observations were produced')) {
    limitations.push('no check observations were produced');
  }

  if (sawFailure) return { verdict: 'Failed', limitations };
  return { verdict: 'Incomplete', limitations };
}

export function buildEvidenceManifest(
  candidate: CandidateRevision,
  plan: CheckPlan,
  observations: readonly CheckObservation[],
): string {
  const payload = JSON.stringify({
    candidate: candidate.diffDigest,
    plan: plan.planDigest,
    observations: observations.map((observation) => ({
      checkId: observation.checkId,
      revision: observation.revision,
      commitSha: observation.commitSha,
      status: observation.status,
      executed: observation.executed,
      exitCode: observation.exitCode,
      artifactRefs: observation.artifactRefs,
      commandDigest: observation.commandDigest,
      testContentSha256: observation.testContentSha256,
    })),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export class PrJobController {
  readonly store: PrJobStore;
  readonly #resolver?: PrJobResolver;
  readonly #planner?: PrJobPlanner;
  readonly #executor?: PrJobExecutor;
  readonly #resources?: PrResourceAdapter;
  readonly #evaluator?: PrJobEvaluator;
  readonly #lockName: string;
  readonly #aborters = new Map<string, AbortController>();

  constructor(options: PrJobControllerOptions) {
    this.store = options.store;
    this.#resolver = options.resolver;
    this.#planner = options.planner;
    this.#executor = options.executor;
    this.#resources = options.resources;
    this.#evaluator = options.evaluator;
    this.#lockName = options.lockName ?? 'controller';
  }

  /**
   * Admit one job. The call is idempotent for one principal and one pull
   * request: the same request returns the same job instead of starting a
   * second one. A different request is rejected while another job is still
   * running, and that rejection happens before any adapter is called.
   *
   * `options.requestKey` overrides the derived key. The wrapper uses it for
   * the caller supplied idempotency key.
   */
  async start(
    principal: RequestPrincipal,
    request: PrVerificationRequest,
    options: { requestKey?: string } = {},
  ): Promise<PrJob> {
    const ownerId = assertPrincipal(principal);
    const normalized = normalizeRequest(request);
    assertRepositoryAccess(principal, normalized.repository);

    const blockers = await this.store.listBlockers();
    if (blockers.length > 0) {
      throw new PrJobControllerError(
        'CLEANUP_UNRESOLVED',
        `unresolved cleanup for job ${blockers[0].jobId}; no new job may start`,
        409,
      );
    }

    const requestKey = options.requestKey ?? buildRequestKey(ownerId, normalized);
    const existing = await this.store.findByRequestKey(requestKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    const job: PrJob = {
      id: this.store.newJobId(),
      ownerId,
      request: normalized,
      requestKey,
      phase: 'Queued',
      cancelRequested: false,
      resourceIds: [],
      limitations: [],
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      return await this.store.createExclusive(job);
    } catch (error) {
      if (error instanceof PrJobStoreError && error.code === 'ACTIVE_JOB_EXISTS') {
        throw new PrJobControllerError('ACTIVE_JOB_EXISTS', error.message, 409);
      }
      throw error;
    }
  }

  /** Read one job. */
  async get(principal: RequestPrincipal, jobId: string): Promise<PrJob> {
    assertPrincipal(principal);
    const job = await this.#load(jobId);
    assertJobAccess(principal, job);
    return job;
  }

  /**
   * Ask for a job to stop. The call is idempotent: asking twice keeps one
   * request, and a job that already finished is returned unchanged.
   */
  async cancel(principal: RequestPrincipal, jobId: string): Promise<PrJob> {
    assertPrincipal(principal);
    const job = await this.#load(jobId);
    assertJobAccess(principal, job);
    if (job.phase === 'Finished') return job;
    if (job.cancelRequested) return job;

    const requested = await this.store.mutate(jobId, (draft) => {
      draft.cancelRequested = true;
    });
    this.#aborters.get(jobId)?.abort();

    if (requested.phase === 'Queued') {
      // Nothing started yet, so the job can be closed right away instead of
      // occupying the single job slot.
      return this.#finish(requested, {
        verdict: 'Incomplete',
        limitations: ['the job was cancelled before execution started'],
        failure: { code: 'CANCELLED', message: 'cancelled by request' },
      });
    }
    return requested;
  }

  /**
   * Run a queued job to completion. The single writer lock keeps two
   * controllers from driving the same queue at once.
   */
  async run(jobId: string, options: PrJobRunOptions = {}): Promise<PrJob> {
    let lock: PrJobStoreLock;
    try {
      // A lock left behind by a dead controller must not block the queue. A
      // lock held by a live process is never broken.
      lock = await this.store.acquireLock(this.#lockName, {
        waitMs: options.lockWaitMs ?? 0,
        stealStale: true,
      });
    } catch (error) {
      if (error instanceof PrJobStoreError && error.code === 'LOCK_HELD') {
        throw new PrJobControllerError('CONTROLLER_BUSY', error.message, 409);
      }
      throw error;
    }
    try {
      return await this.#runLocked(jobId);
    } finally {
      await this.store.releaseLock(lock);
    }
  }

  /** Run the oldest queued job, if any. */
  async tick(options: PrJobRunOptions = {}): Promise<PrJob | null> {
    const unfinished = await this.store.listUnfinished();
    const queued = unfinished
      .filter((job) => job.phase === 'Queued')
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
        return left.id < right.id ? -1 : 1;
      });
    if (queued.length === 0) return null;
    return this.run(queued[0].id, options);
  }

  async #runLocked(jobId: string): Promise<PrJob> {
    let job = await this.#load(jobId);
    if (job.phase === 'Finished') return job;
    if (job.phase !== 'Queued') {
      throw new PrJobControllerError('JOB_NOT_QUEUED', `job ${jobId} is ${job.phase}, not Queued`, 409);
    }

    const blockers = await this.store.listBlockers();
    if (blockers.length > 0) {
      throw new PrJobControllerError(
        'CLEANUP_UNRESOLVED',
        `unresolved cleanup for job ${blockers[0].jobId}; no new job may start`,
        409,
      );
    }

    const abort = new AbortController();
    this.#aborters.set(jobId, abort);
    try {
      job = await this.#transition(jobId, 'Resolving');
      if (job.phase === 'Finished') return job;
      const candidate = await this.#resolveCandidate(job, abort.signal);
      if ('failure' in candidate) {
        return await this.#finish(job, {
          verdict: 'Incomplete',
          limitations: [`candidate resolution failed: ${candidate.failure.message}`],
          failure: candidate.failure,
        });
      }
      job = await this.#persistCandidate(jobId, candidate.value);
      if (await this.#cancelled(jobId)) {
        return await this.#finish(job, {
          verdict: 'Incomplete',
          limitations: ['the job was cancelled before it completed'],
          failure: { code: 'CANCELLED', message: 'cancelled by request' },
        });
      }

      job = await this.#transition(jobId, 'Planning');
      if (job.phase === 'Finished') return job;
      const planned = await this.#buildPlan(job, abort.signal);
      if ('failure' in planned) {
        return await this.#finish(job, {
          verdict: 'Incomplete',
          limitations: [`check planning failed: ${planned.failure.message}`],
          failure: planned.failure,
        });
      }
      job = await this.#persistPlan(jobId, planned.value);
      if (await this.#cancelled(jobId)) {
        return await this.#finish(job, {
          verdict: 'Incomplete',
          limitations: ['the job was cancelled before it completed'],
          failure: { code: 'CANCELLED', message: 'cancelled by request' },
        });
      }

      if (!this.#executor) {
        // No execution adapter means no checks ran. The job ends as
        // Incomplete. It must never end as Verified.
        job = await this.#transition(jobId, 'Executing');
        if (job.phase === 'Finished') return job;
        const limitations = ['no execution adapter is configured, so no check was executed'];
        const result =
          job.candidate && job.plan
            ? {
                candidate: job.candidate,
                plan: job.plan,
                observations: [] as CheckObservation[],
                verdict: 'Incomplete' as PrVerdict,
                limitations,
                evidenceManifestSha256: buildEvidenceManifest(job.candidate, job.plan, []),
                cleanupComplete: true,
                superseded: false,
              }
            : undefined;
        return await this.#finish(job, {
          verdict: 'Incomplete',
          limitations,
          result,
          failure: { code: 'EXECUTOR_UNAVAILABLE', message: 'no execution adapter is configured' },
        });
      }

      job = await this.#transition(jobId, 'Executing');
      if (job.phase === 'Finished') return job;
      const allocation = await this.#allocate(jobId, job);
      if ('failure' in allocation) {
        return await this.#finish(job, {
          verdict: 'Incomplete',
          limitations: [`resource allocation failed: ${allocation.failure.message}`],
          failure: allocation.failure,
        });
      }
      job = allocation.job;

      let observations: CheckObservation[] = [];
      let superseded = false;
      let executionFailure: { code: string; message: string } | undefined;
      try {
        const outcome = await this.#executor.execute({
          job,
          candidate: job.candidate as CandidateRevision,
          plan: job.plan as CheckPlan,
          signal: abort.signal,
        });
        observations = Array.isArray(outcome?.observations) ? outcome.observations : [];
        superseded = outcome?.superseded === true;
      } catch (error) {
        executionFailure = { code: 'EXECUTOR_FAILED', message: errorMessage(error) };
      }

      const cancelled = await this.#cancelled(jobId);
      job = await this.#transition(jobId, 'Cleaning');
      const cleanup = await this.#cleanup(job, abort.signal);
      job = cleanup.job;

      if (job.candidate && job.plan) {
        const evaluation = this.#evaluate({
          job,
          candidate: job.candidate,
          plan: job.plan,
          observations,
          cancelled,
          cleanupComplete: cleanup.cleanupComplete,
          limitations: cleanup.limitations,
        });
        const result: PrVerificationResult = {
          candidate: job.candidate,
          plan: job.plan,
          observations,
          verdict: evaluation.verdict,
          limitations: evaluation.limitations,
          evidenceManifestSha256: buildEvidenceManifest(job.candidate, job.plan, observations),
          cleanupComplete: cleanup.cleanupComplete,
          superseded,
        };
        return await this.#finish(job, {
          verdict: evaluation.verdict,
          limitations: evaluation.limitations,
          result,
          failure: executionFailure,
        });
      }

      return await this.#finish(job, {
        verdict: 'Incomplete',
        limitations: cleanup.limitations,
        failure: executionFailure ?? { code: 'INCOMPLETE', message: 'the job ended without a candidate and plan' },
      });
    } finally {
      this.#aborters.delete(jobId);
    }
  }

  /**
   * Ask the configured evaluator for the verdict.
   *
   * Without an evaluator the conservative fallback runs and the job stays
   * `Incomplete`. A cancelled job or a job whose cleanup did not finish can
   * never carry a `Verified` verdict, whatever the evaluator says. Those two
   * rules belong to the state machine, not to the policy.
   */
  #evaluate(input: Omit<PrJobEvaluationInput, 'job'> & { job: PrJob }): PrJobEvaluation {
    const fallback = evaluateObservations({
      plan: input.plan,
      candidate: input.candidate,
      observations: input.observations,
      cancelled: input.cancelled,
      cleanupComplete: input.cleanupComplete,
      limitations: input.limitations,
    });
    if (!this.#evaluator) {
      return {
        ...fallback,
        limitations: [
          ...fallback.limitations,
          'no verdict evaluator is configured, so the job cannot be verified',
        ],
      };
    }
    const evaluation = this.#evaluator.evaluate(input);
    const limitations = [...(evaluation.limitations ?? [])];
    let verdict = evaluation.verdict;
    if (verdict === 'Verified' && input.cancelled) {
      verdict = 'Incomplete';
      limitations.push('the job was cancelled before it completed');
    }
    if (verdict === 'Verified' && !input.cleanupComplete) {
      verdict = 'Incomplete';
      limitations.push('resource cleanup did not complete');
    }
    return { verdict, limitations };
  }

  async #transition(jobId: string, phase: PrJobPhase): Promise<PrJob> {
    const current = await this.#load(jobId);
    // A job that already reached the terminal phase is never resurrected. A
    // cancel that landed first owns the outcome.
    if (current.phase === 'Finished') return current;
    return this.store.mutate(jobId, (draft) => {
      if (draft.phase !== 'Finished') draft.phase = phase;
    });
  }

  async #load(jobId: string): Promise<PrJob> {
    try {
      return await this.store.get(jobId);
    } catch (error) {
      if (error instanceof PrJobStoreError && error.code === 'JOB_NOT_FOUND') {
        throw new PrJobControllerError('JOB_NOT_FOUND', `job ${jobId} does not exist`, 404);
      }
      throw error;
    }
  }

  async #cancelled(jobId: string): Promise<boolean> {
    const job = await this.#load(jobId);
    return job.cancelRequested;
  }

  async #resolveCandidate(
    job: PrJob,
    signal: AbortSignal,
  ): Promise<{ value: CandidateRevision } | { failure: { code: string; message: string } }> {
    if (!this.#resolver) {
      return { failure: { code: 'RESOLVER_UNAVAILABLE', message: 'no candidate resolver is configured' } };
    }
    try {
      const candidate = await this.#resolver.resolve({ job, request: job.request, signal });
      assertCandidate(candidate, job.request);
      return { value: candidate };
    } catch (error) {
      return { failure: { code: 'RESOLVER_FAILED', message: errorMessage(error) } };
    }
  }

  async #buildPlan(
    job: PrJob,
    signal: AbortSignal,
  ): Promise<{ value: CheckPlan } | { failure: { code: string; message: string } }> {
    if (!this.#planner) {
      return { failure: { code: 'PLANNER_UNAVAILABLE', message: 'no check planner is configured' } };
    }
    try {
      const plan = await this.#planner.plan({ job, candidate: job.candidate as CandidateRevision, signal });
      assertPlan(plan);
      return { value: plan };
    } catch (error) {
      return { failure: { code: 'PLANNER_FAILED', message: errorMessage(error) } };
    }
  }

  async #persistCandidate(jobId: string, candidate: CandidateRevision): Promise<PrJob> {
    return this.store.mutate(jobId, (draft) => {
      draft.candidate = candidate;
    });
  }

  async #persistPlan(jobId: string, plan: CheckPlan): Promise<PrJob> {
    const existing = await this.#load(jobId);
    if (existing.plan && existing.plan.planDigest !== plan.planDigest) {
      throw new PrJobControllerError(
        'PLAN_CONFLICT',
        `job ${jobId} already has plan ${existing.plan.planDigest}`,
        409,
      );
    }
    if (existing.plan) return existing;
    return this.store.mutate(jobId, (draft) => {
      draft.plan = plan;
    });
  }

  /**
   * Allocate resources for the execution. The intent is persisted before the
   * allocation and the identifiers are persisted before the executor runs, so
   * a crash leaves a trail that recovery can follow.
   */
  async #allocate(
    jobId: string,
    job: PrJob,
  ): Promise<
    { job: PrJob } | { failure: { code: string; message: string } }
  > {
    if (!this.#resources) return { job };
    const intent: PrJobResourceIntent = {
      purpose: 'verification-execution',
      repository: job.request.repository,
      headSha: (job.candidate as CandidateRevision).headSha,
      planDigest: (job.plan as CheckPlan).planDigest,
    };
    let current = await this.store.mutate(jobId, (draft) => {
      draft.resourceIntent = intent;
    });
    let allocated: string[];
    try {
      allocated = await this.#resources.allocate(jobId, intent);
    } catch (error) {
      // The allocation outcome is unknown. New work stays blocked until the
      // adapter can prove what exists.
      await this.store.addBlocker({
        jobId,
        reason: `resource allocation failed and the outcome is unknown: ${errorMessage(error)}`,
        resourceIds: [],
      });
      return {
        failure: { code: 'RESOURCE_ALLOCATION_FAILED', message: errorMessage(error) },
      };
    }
    if (!Array.isArray(allocated) || allocated.some((item) => typeof item !== 'string' || item.length === 0)) {
      await this.store.addBlocker({
        jobId,
        reason: 'resource allocation returned malformed identifiers',
        resourceIds: [],
      });
      return {
        failure: { code: 'RESOURCE_ALLOCATION_FAILED', message: 'resource allocation returned malformed identifiers' },
      };
    }
    current = await this.store.mutate(jobId, (draft) => {
      draft.resourceIds = [...allocated];
    });
    return { job: current };
  }

  /**
   * Release what was allocated. Only identifiers the job recorded are
   * released, and a failed release leaves a blocker behind.
   */
  async #cleanup(
    job: PrJob,
    signal: AbortSignal,
  ): Promise<{ job: PrJob; cleanupComplete: boolean; limitations: string[] }> {
    const limitations: string[] = [];
    if (!this.#resources || job.resourceIds.length === 0) {
      return { job, cleanupComplete: true, limitations };
    }
    try {
      const report = await this.#resources.release(job.id, job.resourceIds);
      const failed = Array.isArray(report?.failed) ? report.failed : [];
      if (failed.length > 0) {
        limitations.push(`resource cleanup failed for ${failed.join(', ')}`);
        await this.store.addBlocker({
          jobId: job.id,
          reason: `resource cleanup failed for ${failed.join(', ')}`,
          resourceIds: failed,
        });
        return { job, cleanupComplete: false, limitations };
      }
    } catch (error) {
      limitations.push(`resource cleanup failed: ${errorMessage(error)}`);
      await this.store.addBlocker({
        jobId: job.id,
        reason: `resource cleanup failed: ${errorMessage(error)}`,
        resourceIds: job.resourceIds,
      });
      return { job, cleanupComplete: false, limitations };
    }
    void signal;
    return { job, cleanupComplete: true, limitations };
  }

  /** Write the terminal state of a job. */
  async #finish(
    job: PrJob,
    outcome: {
      verdict: PrVerdict;
      limitations: string[];
      result?: PrVerificationResult;
      failure?: { code: string; message: string };
    },
  ): Promise<PrJob> {
    return this.store.mutate(job.id, (draft) => {
      draft.phase = 'Finished';
      draft.verdict = outcome.verdict;
      draft.limitations = [...outcome.limitations];
      if (outcome.result) draft.result = outcome.result;
      if (outcome.failure) draft.failure = outcome.failure;
      else delete draft.failure;
    });
  }
}

export interface PrVerificationControllerOptions extends PrJobControllerOptions {}

/**
 * The route facing controller.
 *
 * The signatures here are the ones the HTTP layer uses, so no route has to
 * remember a different argument order:
 *
 * - `start(input, principal, idempotencyKey)`
 * - `get(id, principal)`
 * - `cancel(id, principal)`
 * - `waitForIdle()`
 *
 * The idempotency key is explicit and stable. Replaying a request with the
 * same key returns the same job. Replaying it with a different payload is
 * refused, because the key says one request and the payload says another.
 */
export class PrVerificationController {
  readonly #controller: PrJobController;

  constructor(options: PrVerificationControllerOptions) {
    this.#controller = new PrJobController(options);
  }

  get store(): PrJobStore {
    return this.#controller.store;
  }

  /**
   * Admit a job. The same idempotency key and the same payload return the
   * same job. The same key with a different payload is refused.
   */
  async start(
    input: PrVerificationRequest,
    principal: RequestPrincipal,
    idempotencyKey: string,
  ): Promise<PrJob> {
    const key = assertIdempotencyKey(idempotencyKey);
    const ownerId = assertPrincipal(principal);
    const requestKey = buildIdempotentRequestKey(ownerId, key);
    const existing = await this.#controller.store.findByRequestKey(requestKey);
    if (existing) {
      if (!sameRequest(existing.request, input)) {
        throw new PrJobControllerError(
          'IDEMPOTENCY_KEY_REUSED',
          `the idempotency key ${key} was already used for a different request`,
          409,
        );
      }
      return existing;
    }
    return this.#controller.start(principal, input, { requestKey });
  }

  /** Read one job. */
  async get(id: string, principal: RequestPrincipal): Promise<PrJob> {
    return this.#controller.get(principal, id);
  }

  /** Ask for a job to stop. */
  async cancel(id: string, principal: RequestPrincipal): Promise<PrJob> {
    return this.#controller.cancel(principal, id);
  }

  /** Run one job. */
  async run(id: string): Promise<PrJob> {
    return this.#controller.run(id);
  }

  /** Run the oldest queued job. */
  async tick(): Promise<PrJob | null> {
    return this.#controller.tick();
  }

  /**
   * Wait until no job is unfinished.
   *
   * By default the wrapper also drives the queue while it waits, so a caller
   * that only wants the job to settle does not need a second runner. Pass
   * `drive: false` when another runner owns the queue.
   */
  async waitForIdle(
    options: { timeoutMs?: number; pollMs?: number; drive?: boolean } = {},
  ): Promise<PrJob[]> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollMs = options.pollMs ?? 25;
    const drive = options.drive ?? true;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const unfinished = await this.#controller.store.listUnfinished();
      if (unfinished.length === 0) return [];
      if (drive) {
        try {
          await this.#controller.tick();
        } catch (error) {
          if (!(error instanceof PrJobControllerError) || error.code !== 'CONTROLLER_BUSY') throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new PrJobControllerError(
          'WAIT_TIMEOUT',
          `jobs are still unfinished: ${unfinished.map((job) => job.id).join(', ')}`,
          504,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
