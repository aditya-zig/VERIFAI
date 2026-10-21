import type {
  CandidateRevision,
  CheckObservation,
  CheckPlan,
  PrVerdict,
  PrVerificationResult,
} from '../../packages/contracts/src/index.js';
import { ARTIFACT_LIMITS, TestArtifactStore, type EvidenceWriter } from './evidence.js';
import { generatedTestCommand, validatePlan } from './planner.js';
import { sha256Hex, stableStringify, type PrCheckProfile } from './profile.js';

/**
 * Deterministic verdict evaluation over recorded check observations.
 *
 * The evaluator trusts records only when they line up: approved check, correct
 * base/head commit, approved command digest, planned test digest, real integer
 * exit code and at least one evidence reference. Missing facts are Incomplete,
 * flaky or undetermined facts are Unknown, and a model opinion is ignored.
 *
 * This is offline policy. It never runs a check, calls a model or reaches AWS.
 */
export type EvaluationReasonCode =
  | 'incomplete.profile'
  | 'incomplete.plan'
  | 'incomplete.artifacts'
  | 'incomplete.observation'
  | 'incomplete.missing-check'
  | 'incomplete.base-failure'
  | 'incomplete.cleanup'
  | 'incomplete.superseded'
  | 'incomplete.evidence'
  | 'unknown.flaky'
  | 'unknown.status'
  | 'failed.candidate-regression';

export interface EvaluationReason {
  readonly code: EvaluationReasonCode;
  readonly detail: string;
}

export interface CandidateEvaluationInput {
  readonly candidate: CandidateRevision;
  readonly plan: CheckPlan;
  readonly profile: PrCheckProfile;
  readonly observations: readonly CheckObservation[];
  readonly artifactStore: TestArtifactStore;
  readonly cleanupComplete: boolean;
  readonly superseded: boolean;
  /**
   * Optional store for `evidence://records/<sha256>` references. When present,
   * those records are re-hashed. Other adapter-defined refs stay format checked.
   */
  readonly evidenceStore?: EvidenceWriter;
  /**
   * When true, an empty generated-test plan cannot reach Verified. Use this
   * when generated coverage is a policy requirement, not optional preparation.
   */
  readonly requireGeneratedTests?: boolean;
  /** Opinion only. Kept in the input to prove it cannot change the verdict. */
  readonly modelOpinion?: PrVerdict;
}

export interface CandidateEvaluation {
  readonly result: PrVerificationResult;
  readonly reasons: readonly EvaluationReason[];
}

export interface EvidenceManifestInput {
  readonly candidate: CandidateRevision;
  readonly plan: CheckPlan;
  readonly observations: readonly CheckObservation[];
  readonly cleanupComplete: boolean;
  readonly superseded: boolean;
}

type CheckKind = 'required' | 'regression' | 'generated';

interface ExpectedCheck {
  readonly checkId: string;
  readonly kind: CheckKind;
  readonly command: string;
  readonly contentSha256: string;
  readonly revisions: readonly ('base' | 'head')[];
}

const shaPattern = /^[0-9a-f]{40}$/;
const evidenceRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const evidenceRecordPrefix = 'evidence://records/';
const verdicts = new Set<PrVerdict>(['Verified', 'Failed', 'Incomplete', 'Unknown']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalObservation(observation: CheckObservation): Record<string, unknown> {
  return {
    checkId: observation.checkId,
    revision: observation.revision,
    commitSha: observation.commitSha,
    status: observation.status,
    executed: observation.executed,
    exitCode: observation.exitCode,
    artifactRefs: [...observation.artifactRefs],
    commandDigest: observation.commandDigest,
    testContentSha256: observation.testContentSha256,
  };
}

function observationOrder(observation: CheckObservation): string {
  return stableStringify(canonicalObservation(observation));
}

/**
 * Hash the records a verdict was computed from. Observation order does not
 * matter; any changed record produces a different manifest.
 */
export function computeEvidenceManifestSha256(input: EvidenceManifestInput): string {
  return sha256Hex(
    stableStringify({
      candidate: input.candidate,
      plan: input.plan,
      observations: [...input.observations].map(canonicalObservation).sort((left, right) => {
        const leftKey = stableStringify(left);
        const rightKey = stableStringify(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
      cleanupComplete: input.cleanupComplete,
      superseded: input.superseded,
    }),
  );
}

/**
 * Decide whether a candidate may advance.
 *
 * Inputs are the resolved candidate, the planned checks, the approved profile,
 * adapter observations and cleanup/supersession facts. Output is a
 * PrVerificationResult plus structured reasons. Missing capability never
 * becomes a pass.
 */
export async function evaluateCandidate(input: CandidateEvaluationInput): Promise<CandidateEvaluation> {
  const candidate = structuredClone(input.candidate);
  const plan = structuredClone(input.plan);
  const observations = structuredClone([...input.observations]) as CheckObservation[];
  const reasons: EvaluationReason[] = [];
  const notes: string[] = [];

  const add = (code: EvaluationReasonCode, detail: string): void => {
    reasons.push({ code, detail });
  };

  if (input.cleanupComplete !== true) {
    add('incomplete.cleanup', 'candidate cleanup did not finish successfully');
  }
  if (input.superseded === true) {
    add('incomplete.superseded', 'candidate was superseded before the verdict was evaluated');
  }
  if (input.modelOpinion !== undefined) {
    notes.push(`model opinion (${String(input.modelOpinion)}) is not evidence and was ignored`);
  }

  const finish = (verdict: PrVerdict): CandidateEvaluation => {
    const limitations = [...reasons.map((reason) => `${reason.code}: ${reason.detail}`), ...notes];
    const result: PrVerificationResult = {
      candidate,
      plan,
      observations,
      verdict,
      limitations,
      evidenceManifestSha256: computeEvidenceManifestSha256({
        candidate,
        plan,
        observations,
        cleanupComplete: input.cleanupComplete === true,
        superseded: input.superseded === true,
      }),
      cleanupComplete: input.cleanupComplete === true,
      superseded: input.superseded === true,
    };
    return { result, reasons };
  };

  if (!isRecord(input.profile)) {
    add('incomplete.profile', 'approved profile is required');
    return finish('Incomplete');
  }
  if (candidate.repository !== input.profile.repository) {
    add('incomplete.profile', `candidate repository ${String(candidate.repository)} is not approved`);
    return finish('Incomplete');
  }
  if (!shaPattern.test(candidate.baseSha) || !shaPattern.test(candidate.headSha)) {
    add('incomplete.profile', 'candidate base and head must be 40-character commit SHAs');
    return finish('Incomplete');
  }

  // Profile, plan identity, required-check content, generated bounds and
  // persisted test bytes are validated together before any record is trusted.
  const validation = await validatePlan({
    profile: input.profile,
    plan,
    artifactStore: input.artifactStore,
    verifyArtifacts: true,
  });
  if (!validation.ok) {
    for (const issue of validation.issues) {
      const code: EvaluationReasonCode =
        issue.area === 'profile'
          ? 'incomplete.profile'
          : issue.area === 'plan'
            ? 'incomplete.plan'
            : 'incomplete.artifacts';
      add(code, issue.detail);
    }
    return finish('Incomplete');
  }
  if (input.requireGeneratedTests === true && plan.generatedTests.length === 0) {
    add('incomplete.plan', 'generated test coverage is required but the plan contains none');
    return finish('Incomplete');
  }

  const expected: ExpectedCheck[] = [];
  for (const check of input.profile.requiredChecks) {
    expected.push({
      checkId: check.checkId,
      kind: 'required',
      command: check.command,
      contentSha256: sha256Hex(check.script),
      revisions: ['base', 'head'],
    });
  }
  for (const definition of plan.generatedTests) {
    expected.push({
      checkId: definition.checkId,
      kind: 'generated',
      command: generatedTestCommand(definition),
      contentSha256: definition.contentSha256,
      revisions: ['head'],
    });
  }
  expected.push({
    checkId: input.profile.regressionCheck.checkId,
    kind: 'regression',
    command: input.profile.regressionCheck.command,
    contentSha256: sha256Hex(input.profile.regressionCheck.script),
    revisions: ['base', 'head'],
  });

  // Group observations. Shape errors are rejected before any verdict logic.
  const groups = new Map<string, CheckObservation[]>();
  const known = new Set(expected.map((check) => check.checkId));
  for (const raw of observations as unknown[]) {
    if (!isRecord(raw) || typeof raw.checkId !== 'string' || !raw.checkId) {
      add('incomplete.observation', 'observation is missing a checkId');
      continue;
    }
    if (raw.revision !== 'base' && raw.revision !== 'head') {
      add('incomplete.observation', `observation for ${raw.checkId} has no valid revision`);
      continue;
    }
    if (!known.has(raw.checkId)) {
      add('incomplete.evidence', `observation names check ${raw.checkId}, which is not in the plan`);
      continue;
    }
    const key = `${raw.checkId}\u0000${raw.revision}`;
    const group = groups.get(key) ?? [];
    group.push(raw as unknown as CheckObservation);
    groups.set(key, group);
  }

  const flaky = new Set<string>();
  for (const [key, group] of groups) {
    if (new Set(group.map(observationOrder)).size > 1) {
      flaky.add(key);
      const [checkId] = key.split('\u0000');
      add('unknown.flaky', `${checkId} has conflicting observations; the evidence is flaky`);
    }
  }

  const headResults = new Map<string, PrVerdict>();
  const baseResults = new Map<string, PrVerdict>();
  const expectedSha = (revision: 'base' | 'head'): string =>
    revision === 'base' ? candidate.baseSha : candidate.headSha;

  for (const check of expected) {
    for (const revision of check.revisions) {
      const key = `${check.checkId}\u0000${revision}`;
      const group = groups.get(key);
      if (!group || group.length === 0) {
        add('incomplete.missing-check', `${check.checkId} has no ${revision} observation`);
        continue;
      }
      if (flaky.has(key)) continue;

      const observation = group[0]!;
      const commitSha = expectedSha(revision);
      if (observation.commitSha !== commitSha) {
        add(
          'incomplete.observation',
          `${check.checkId} ${revision} observation targets ${String(observation.commitSha)}, expected ${commitSha}`,
        );
        continue;
      }
      if (observation.executed !== true) {
        add('incomplete.observation', `${check.checkId} ${revision} was not executed`);
        continue;
      }
      if (!verdicts.has(observation.status)) {
        add('incomplete.observation', `${check.checkId} ${revision} has an invalid status`);
        continue;
      }
      if (observation.commandDigest !== sha256Hex(check.command)) {
        add('incomplete.observation', `${check.checkId} ${revision} did not run the approved command`);
        continue;
      }
      if (observation.testContentSha256 !== check.contentSha256) {
        add('incomplete.observation', `${check.checkId} ${revision} did not run the planned test bytes`);
        continue;
      }
      const refs = observation.artifactRefs;
      if (
        !Array.isArray(refs) ||
        refs.length === 0 ||
        refs.length > ARTIFACT_LIMITS.maxEvidenceRefs ||
        refs.some((ref) => typeof ref !== 'string' || !evidenceRefPattern.test(ref)) ||
        new Set(refs).size !== refs.length
      ) {
        add('incomplete.evidence', `${check.checkId} ${revision} has no usable evidence references`);
        continue;
      }
      if (input.evidenceStore) {
        const unreadable = await unreadableEvidence(input.evidenceStore, refs);
        if (unreadable) {
          add('incomplete.evidence', `${check.checkId} ${revision} evidence is unreadable: ${unreadable}`);
          continue;
        }
      }
      if (observation.status === 'Incomplete') {
        add('incomplete.observation', `${check.checkId} ${revision} reported Incomplete`);
        continue;
      }
      if (observation.status === 'Unknown') {
        add('unknown.status', `${check.checkId} ${revision} could not determine a result`);
        continue;
      }

      const exitCode = observation.exitCode;
      if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
        add('incomplete.observation', `${check.checkId} ${revision} has no integer exit code`);
        continue;
      }
      if (observation.status === 'Verified' && exitCode !== 0) {
        add('incomplete.observation', `${check.checkId} ${revision} is Verified with exit ${exitCode}`);
        continue;
      }
      if (observation.status === 'Failed' && exitCode === 0) {
        add('incomplete.observation', `${check.checkId} ${revision} is Failed with exit 0`);
        continue;
      }

      if (observation.status === 'Failed') {
        if (revision === 'base') baseResults.set(check.checkId, 'Failed');
        else headResults.set(check.checkId, 'Failed');
      } else if (observation.status === 'Verified') {
        if (revision === 'base') baseResults.set(check.checkId, 'Verified');
        else headResults.set(check.checkId, 'Verified');
      }
    }
  }

  for (const [checkId, status] of baseResults) {
    if (status !== 'Failed') continue;
    add(
      'incomplete.base-failure',
      `${checkId} already failed at base ${candidate.baseSha}; this is not a candidate regression`,
    );
  }

  for (const [checkId, status] of headResults) {
    if (status !== 'Failed') continue;
    const kind = expected.find((check) => check.checkId === checkId)?.kind;
    if (kind === 'generated') {
      add('failed.candidate-regression', `generated test ${checkId} failed on the candidate head`);
      continue;
    }
    if (baseResults.get(checkId) === 'Verified') {
      add('failed.candidate-regression', `${checkId} passed at base and failed at head ${candidate.headSha}`);
    }
  }

  const hasIncomplete = reasons.some((reason) => reason.code.startsWith('incomplete.'));
  const hasUnknown = reasons.some((reason) => reason.code.startsWith('unknown.'));
  const hasFailed = reasons.some((reason) => reason.code.startsWith('failed.'));
  const verdict: PrVerdict = hasIncomplete
    ? 'Incomplete'
    : hasUnknown
      ? 'Unknown'
      : hasFailed
        ? 'Failed'
        : 'Verified';

  return finish(verdict);
}

/**
 * Re-hash `evidence://records/...` references when a writer/store is supplied.
 * Returns a detail string for the first failure, or undefined when readable.
 */
async function unreadableEvidence(store: EvidenceWriter, refs: readonly string[]): Promise<string | undefined> {
  for (const ref of refs) {
    if (!ref.startsWith(evidenceRecordPrefix)) continue;
    try {
      await store.read(ref);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `${ref}: ${detail}`;
    }
  }
  return undefined;
}
