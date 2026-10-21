import type { PrJobPhase, PrVerdict, PrVerificationResult } from '../../packages/contracts/src/index.js';
import { buildEvidenceManifest, type PrResourceAdapter, type PrResourceState } from './controller.js';
import { PrJobStore, type PrJobBlocker } from './store.js';

/**
 * Recovery for interrupted verification jobs.
 *
 * A job that was in flight when the process died keeps its last persisted
 * phase. Recovery closes it as `Incomplete` because the checks it was running
 * cannot be trusted to have finished, and it cleans up the resources it can
 * prove it owns.
 *
 * The important rule is what recovery refuses to do. A resource whose
 * ownership cannot be proven is never deleted. It is recorded as a blocker
 * and new work stops until the adapter can prove the resource is gone or
 * belongs to the job.
 */

export interface PrRecoveryOptions {
  store: PrJobStore;
  /** Adapter used to inspect and release resources. */
  resources?: PrResourceAdapter;
  /**
   * What to do with a job that was still queued. `keep` leaves it for the
   * runner, `close` finishes it as Incomplete. The default is `keep` because
   * a queued job has not started any work.
   */
  queuedJobs?: 'keep' | 'close';
}

export interface PrRecoveryJobOutcome {
  jobId: string;
  phase: PrJobPhase;
  verdict: PrVerdict;
  released: string[];
  unresolved: string[];
  cleanupComplete: boolean;
}

export interface PrRecoveryOutcome {
  jobs: PrRecoveryJobOutcome[];
  released: string[];
  unresolved: string[];
  blockers: PrJobBlocker[];
  /** True when new jobs must not start. */
  blocked: boolean;
}

interface ResourceSweep {
  released: string[];
  unresolved: string[];
  /** False when cleanup could not be proven. */
  proven: boolean;
  /** Why the cleanup could not be proven. */
  reasons: string[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/**
 * Inspect and release the resources of one job.
 *
 * Only resources the adapter reports as owned by the job are released. A
 * resource that is present but not proven to be owned is reported as
 * unresolved and left alone.
 */
async function sweepResources(
  resources: PrResourceAdapter | undefined,
  jobId: string,
  knownResourceIds: readonly string[],
): Promise<ResourceSweep> {
  const released: string[] = [];
  const unresolved: string[] = [];
  const reasons: string[] = [];
  if (!resources) {
    if (knownResourceIds.length > 0) {
      unresolved.push(...knownResourceIds);
      reasons.push('no resource adapter is configured');
      return { released, unresolved, proven: false, reasons };
    }
    return { released, unresolved, proven: true, reasons };
  }

  let states: PrResourceState[];
  try {
    states = await resources.inspect(jobId, knownResourceIds);
  } catch (error) {
    unresolved.push(...knownResourceIds);
    reasons.push(`the resources of job ${jobId} could not be inspected: ${errorMessage(error)}`);
    return { released, unresolved, proven: false, reasons };
  }
  if (!Array.isArray(states)) {
    unresolved.push(...knownResourceIds);
    reasons.push(`the resource adapter returned an unusable answer for job ${jobId}`);
    return { released, unresolved, proven: false, reasons };
  }

  const releasable = states.filter((state) => state.owned === true && state.present !== false);
  for (const state of states) {
    if (state.owned !== true) {
      unresolved.push(state.resourceId);
      reasons.push(`ownership of ${state.resourceId} could not be proven`);
    }
  }

  if (releasable.length > 0) {
    try {
      const report = await resources.release(
        jobId,
        releasable.map((state) => state.resourceId),
      );
      const failed = Array.isArray(report?.failed) ? report.failed : [];
      for (const id of releasable.map((state) => state.resourceId)) {
        if (failed.includes(id)) {
          unresolved.push(id);
          reasons.push(`${id} could not be released`);
        } else released.push(id);
      }
    } catch (error) {
      for (const state of releasable) unresolved.push(state.resourceId);
      reasons.push(`the resources of job ${jobId} could not be released: ${errorMessage(error)}`);
    }
  }
  return { released, unresolved, proven: unresolved.length === 0, reasons };
}

/**
 * Try to clear a blocker by proving what happened to its resources. The
 * blocker stays while any resource is still unproven.
 */
async function resolveBlocker(
  resources: PrResourceAdapter | undefined,
  blocker: PrJobBlocker,
): Promise<{ cleared: boolean; released: string[] }> {
  if (!resources) return { cleared: false, released: [] };
  let states: PrResourceState[];
  try {
    states = await resources.inspect(blocker.jobId, blocker.resourceIds);
  } catch {
    return { cleared: false, released: [] };
  }
  if (!Array.isArray(states)) return { cleared: false, released: [] };

  const releasable = states.filter((state) => state.owned === true && state.present !== false);
  const unproven = states.filter((state) => state.owned !== true);
  if (unproven.length > 0) return { cleared: false, released: [] };

  const released: string[] = [];
  if (releasable.length > 0) {
    try {
      const report = await resources.release(
        blocker.jobId,
        releasable.map((state) => state.resourceId),
      );
      const failed = Array.isArray(report?.failed) ? report.failed : [];
      if (failed.length > 0) return { cleared: false, released: [] };
      released.push(...releasable.map((state) => state.resourceId));
    } catch {
      return { cleared: false, released: [] };
    }
  }
  return { cleared: true, released };
}

/**
 * Recover every interrupted job and report what is still unresolved.
 *
 * The function is safe to run repeatedly. A job that was already recovered is
 * finished and is skipped.
 */
export async function recoverInterruptedJobs(options: PrRecoveryOptions): Promise<PrRecoveryOutcome> {
  const { store } = options;
  const queuedPolicy = options.queuedJobs ?? 'keep';
  const unfinished = await store.listUnfinished();

  const jobs: PrRecoveryJobOutcome[] = [];
  const releasedAll: string[] = [];
  const unresolvedAll: string[] = [];

  for (const job of unfinished) {
    if (job.phase === 'Queued' && queuedPolicy === 'keep') continue;

    const sweep = await sweepResources(options.resources, job.id, job.resourceIds);
    const cleanupComplete = sweep.proven && sweep.unresolved.length === 0;
    const limitations = [
      'the job was interrupted and could not finish its checks',
      ...(cleanupComplete ? [] : ['some resources could not be proven to belong to this job']),
    ];

    await store.mutate(job.id, (draft) => {
      draft.phase = 'Finished';
      draft.verdict = 'Incomplete';
      draft.limitations = limitations;
      draft.failure = { code: 'INTERRUPTED', message: `job was interrupted in phase ${job.phase}` };
      if (draft.candidate && draft.plan) {
        const result: PrVerificationResult = {
          candidate: draft.candidate,
          plan: draft.plan,
          observations: [],
          verdict: 'Incomplete',
          limitations,
          evidenceManifestSha256: buildEvidenceManifest(draft.candidate, draft.plan, []),
          cleanupComplete,
          superseded: false,
        };
        draft.result = result;
      }
    });

    if (sweep.unresolved.length > 0) {
      await store.addBlocker({
        id: `blocker-${job.id}`,
        jobId: job.id,
        reason: `cleanup for job ${job.id} could not be proven complete: ${sweep.reasons.join('; ')}`,
        resourceIds: sweep.unresolved,
      });
    }

    releasedAll.push(...sweep.released);
    unresolvedAll.push(...sweep.unresolved);
    jobs.push({
      jobId: job.id,
      phase: 'Finished',
      verdict: 'Incomplete',
      released: sweep.released,
      unresolved: sweep.unresolved,
      cleanupComplete,
    });
  }

  // Try to clear the blockers left by earlier runs.
  for (const blocker of await store.listBlockers()) {
    const resolution = await resolveBlocker(options.resources, blocker);
    if (resolution.cleared) {
      await store.clearBlocker(blocker.id);
      releasedAll.push(...resolution.released);
    } else {
      unresolvedAll.push(...blocker.resourceIds);
    }
  }

  const blockers = await store.listBlockers();
  return {
    jobs,
    released: releasedAll,
    unresolved: unresolvedAll,
    blockers,
    blocked: blockers.length > 0,
  };
}

/**
 * Convenience wrapper: recover and report only the outcome of one job.
 */
export async function recoverJob(
  store: PrJobStore,
  jobId: string,
  resources?: PrResourceAdapter,
): Promise<PrRecoveryJobOutcome | null> {
  const outcome = await recoverInterruptedJobs({ store, resources });
  return outcome.jobs.find((job) => job.jobId === jobId) ?? null;
}
