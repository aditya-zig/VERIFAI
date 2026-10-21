import type {
  CandidateRevision,
  CheckObservation,
  CheckPlan,
  PrVerdict,
  PrVerificationResult,
  TestDefinition,
} from '../../packages/contracts/src/index.js';
import { ARTIFACT_LIMITS, TestArtifactStore, artifactRefFor } from './evidence.js';
import {
  PLANNER_LIMITS,
  computePlanDigest,
  generatedTestCommand,
} from './planner.js';
import {
  computeProfileDigest,
  sha256Hex,
  stableStringify,
  type PrCheckProfile,
} from './profile.js';

/**
 * Deterministic verdict evaluation over recorded check observations.
 *
 * The evaluator trusts records only when they line up: approved check, correct
 * base/head commit, approved command digest, planned test digest, real integer
 * exit code and at least one evidence reference. Missing facts are Incomplete,
 * flaky or undetermined facts are Unknown, and a model opinion is ignored.
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

const checkIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const evidenceRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
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

function definitionFromProfile(checkId: string, script: string): TestDefinition {
  const contentSha256 = sha256Hex(script);
  return { checkId, artifactRef: artifactRefFor(contentSha256), contentSha256, origin: 'approved' };
}

/**
 * Decide whether a candidate may advance. This function reads persisted test
 * artifacts and recorded observations only; it never runs a check, calls a
 * model or contacts AWS.
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

  // Profile and plan integrity. A plan that no longer matches the approved
  // profile cannot be repaired by observation data.
  let profileFailure = false;
  try {
    if (input.profile.profileDigest !== computeProfileDigest(input.profile)) {
      add('incomplete.profile', 'profile digest does not match its contents');
      profileFailure = true;
    }
  } catch {
    add('incomplete.profile', 'profile could not be validated');
    profileFailure = true;
  }
  if (candidate.repository !== input.profile.repository) {
    add('incomplete.profile', `candidate repository ${String(candidate.repository)} is not approved`);
    profileFailure = true;
  }
  if (!shaPattern.test(candidate.baseSha) || !shaPattern.test(candidate.headSha)) {
    add('incomplete.profile', 'candidate base and head must be 40-character commit SHAs');
    profileFailure = true;
  }
  const regression = input.profile.regressionCheck;
  if (
    !Array.isArray(input.profile.requiredChecks) ||
    input.profile.requiredChecks.length === 0 ||
    !isRecord(regression) ||
    !checkIdPattern.test(String(regression.checkId)) ||
    typeof regression.command !== 'string' ||
    typeof regression.script !== 'string'
  ) {
    add('incomplete.profile', 'approved profile has no usable required or regression checks');
    profileFailure = true;
  } else if (input.profile.requiredChecks.some((check) => check.command === regression.command)) {
    add('incomplete.profile', 'regression check repeats a required command; same-command replay is not independent');
    profileFailure = true;
  }
  if (profileFailure) return finish('Incomplete');

  let structuralFailure = false;
  try {
    if (
      plan.profileId !== input.profile.profileId ||
      plan.profileDigest !== input.profile.profileDigest ||
      plan.policyVersion !== input.profile.policyVersion
    ) {
      add('incomplete.plan', 'plan profile identity does not match the approved profile');
      structuralFailure = true;
    }
    if (plan.planDigest !== computePlanDigest(plan)) {
      add('incomplete.plan', 'plan digest does not match its contents');
      structuralFailure = true;
    }
  } catch {
    add('incomplete.plan', 'plan could not be validated');
    structuralFailure = true;
  }

  const expected: ExpectedCheck[] = [];
  const requiredDefinitions = new Map<string, TestDefinition>();
  if (!structuralFailure) {
    if (plan.requiredChecks.length !== input.profile.requiredChecks.length) {
      add('incomplete.plan', 'plan does not contain exactly the approved required checks');
      structuralFailure = true;
    }
    for (const check of input.profile.requiredChecks) {
      const definition = plan.requiredChecks.find((item) => item.checkId === check.checkId);
      if (!definition) {
        add('incomplete.plan', `approved check ${check.checkId} is missing from the plan`);
        structuralFailure = true;
        continue;
      }
      if (requiredDefinitions.has(check.checkId)) {
        add('incomplete.plan', `approved check ${check.checkId} appears twice in the plan`);
        structuralFailure = true;
        continue;
      }
      requiredDefinitions.set(check.checkId, definition);
      const digest = sha256Hex(check.script);
      if (
        definition.origin !== 'approved' ||
        definition.contentSha256 !== digest ||
        definition.artifactRef !== artifactRefFor(digest)
      ) {
        add('incomplete.plan', `approved check ${check.checkId} was changed after approval`);
        structuralFailure = true;
        continue;
      }
      expected.push({
        checkId: check.checkId,
        kind: 'required',
        command: check.command,
        contentSha256: digest,
        revisions: ['base', 'head'],
      });
    }

    if (plan.generatedTests.length > PLANNER_LIMITS.maxGeneratedTests) {
      add('incomplete.plan', `plan contains more than ${PLANNER_LIMITS.maxGeneratedTests} generated tests`);
      structuralFailure = true;
    }
    const reserved = new Set<string>([
      ...input.profile.requiredChecks.map((check) => check.checkId),
      input.profile.regressionCheck.checkId,
    ]);
    const generatedIds = new Set<string>();
    for (const definition of plan.generatedTests) {
      if (
        !checkIdPattern.test(definition.checkId) ||
        reserved.has(definition.checkId) ||
        generatedIds.has(definition.checkId) ||
        definition.origin !== 'generated' ||
        !digestPattern.test(definition.contentSha256) ||
        definition.artifactRef !== artifactRefFor(definition.contentSha256)
      ) {
        add('incomplete.plan', `generated test ${String(definition.checkId)} is not a valid addition`);
        structuralFailure = true;
        continue;
      }
      generatedIds.add(definition.checkId);
      expected.push({
        checkId: definition.checkId,
        kind: 'generated',
        command: generatedTestCommand(definition),
        contentSha256: definition.contentSha256,
        revisions: ['head'],
      });
    }

    const regressionDigest = sha256Hex(input.profile.regressionCheck.script);
    expected.push({
      checkId: input.profile.regressionCheck.checkId,
      kind: 'regression',
      command: input.profile.regressionCheck.command,
      contentSha256: regressionDigest,
      revisions: ['base', 'head'],
    });
  }

  if (structuralFailure) return finish('Incomplete');

  // Re-hash every persisted artifact that the plan claims to use.
  let artifactFailure = false;
  for (const check of expected) {
    const definition =
      check.kind === 'regression'
        ? definitionFromProfile(check.checkId, input.profile.regressionCheck.script)
        : (requiredDefinitions.get(check.checkId) ??
          plan.generatedTests.find((item) => item.checkId === check.checkId));
    if (!definition) {
      add('incomplete.artifacts', `test definition for ${check.checkId} is unavailable`);
      artifactFailure = true;
      continue;
    }
    try {
      await input.artifactStore.verify(definition);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      add('incomplete.artifacts', `${check.checkId}: ${detail}`);
      artifactFailure = true;
    }
  }
  if (artifactFailure) return finish('Incomplete');

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
