import type { CandidateRevision, CheckPlan, TestDefinition } from '../../packages/contracts/src/index.js';
import { TestArtifactStore, artifactRefFor } from './evidence.js';
import {
  PROFILE_LIMITS,
  computeProfileDigest,
  sha256Hex,
  stableStringify,
  type PrCheckProfile,
} from './profile.js';

/**
 * Bounded, offline check planning.
 *
 * The model may propose extra generated tests. It may not change approved
 * checks, commands, tools or limits: only `{ generatedTests: [{ checkId,
 * script }] }` is accepted, at most twice, with at most four entries. The
 * model sees candidate metadata, never patch bytes, and its output is never
 * trusted as evidence.
 *
 * `planCandidate` is the jobs-worker entry point. `planChecks` is the lower
 * level form used by tests and adapters that already hold a store.
 */
export const PLANNER_LIMITS = Object.freeze({
  maxModelCalls: 2,
  maxGeneratedTests: 4,
  maxScriptBytes: PROFILE_LIMITS.maxScriptBytes,
});

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

export interface PlannerModelRequest {
  readonly attempt: number;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly policyVersion: string;
  readonly repository: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedFiles: readonly string[];
}

export interface PlannerModelAdapter {
  propose(request: PlannerModelRequest): Promise<unknown>;
}

export interface PlanLimits {
  /** Calls allowed to the injected adapter. 1 to 2. */
  readonly maxModelCalls?: number;
  /** Generated tests allowed. 0 skips the adapter. 0 to 4. */
  readonly maxGeneratedTests?: number;
}

export interface PlanChecksInput {
  readonly profile: PrCheckProfile;
  readonly candidate: CandidateRevision;
  readonly artifactStore: TestArtifactStore;
  /** Optional. Without it, approved checks are persisted and generated checks stay unavailable. */
  readonly model?: PlannerModelAdapter;
  readonly limits?: PlanLimits;
}

export interface PlanCandidateOptions {
  /** Optional. Omit for an inspectable fixed-check plan with no model call. */
  readonly model?: PlannerModelAdapter;
  /** Exactly one of artifactStore or artifactsRoot is required. */
  readonly artifactStore?: TestArtifactStore;
  readonly artifactsRoot?: string;
  readonly maxModelCalls?: number;
  readonly maxGeneratedTests?: number;
}

export interface PlannedCheckPlan {
  readonly plan: CheckPlan;
  /** Regression definition is content addressed but not part of CheckPlan. */
  readonly regression: TestDefinition;
  readonly modelCalls: number;
  readonly limitations: readonly string[];
}

export type PlanValidationArea = 'profile' | 'plan' | 'artifacts';

export interface PlanValidationIssue {
  readonly area: PlanValidationArea;
  readonly code: string;
  readonly detail: string;
}

export interface PlanValidationResult {
  readonly ok: boolean;
  readonly issues: readonly PlanValidationIssue[];
}

export interface ValidatePlanInput {
  readonly profile: PrCheckProfile;
  readonly plan: CheckPlan;
  readonly artifactStore?: TestArtifactStore;
  /** Default true. Set false only for a structural check before bytes exist. */
  readonly verifyArtifacts?: boolean;
}

const checkIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const generatedKeys = new Set(['checkId', 'script']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalDefinition(definition: TestDefinition): TestDefinition {
  return {
    checkId: definition.checkId,
    artifactRef: definition.artifactRef,
    contentSha256: definition.contentSha256,
    origin: definition.origin,
  };
}

/** The command a generated test runs. It is derived, never model supplied. */
export function generatedTestCommand(definition: Pick<TestDefinition, 'artifactRef'>): string {
  return `node --test ${definition.artifactRef}`;
}

export function computePlanDigest(
  plan: Pick<CheckPlan, 'policyVersion' | 'profileId' | 'profileDigest' | 'requiredChecks' | 'generatedTests'>,
): string {
  return sha256Hex(
    stableStringify({
      policyVersion: plan.policyVersion,
      profileId: plan.profileId,
      profileDigest: plan.profileDigest,
      requiredChecks: plan.requiredChecks.map(canonicalDefinition),
      generatedTests: plan.generatedTests.map(canonicalDefinition),
    }),
  );
}

interface GeneratedProposal {
  readonly checkId: string;
  readonly script: string;
}

function reject(message: string): never {
  throw new PlanValidationError(message);
}

function resolveLimits(limits: PlanLimits | undefined): Required<PlanLimits> {
  const maxModelCalls = limits?.maxModelCalls ?? PLANNER_LIMITS.maxModelCalls;
  const maxGeneratedTests = limits?.maxGeneratedTests ?? PLANNER_LIMITS.maxGeneratedTests;
  if (
    typeof maxModelCalls !== 'number' ||
    !Number.isSafeInteger(maxModelCalls) ||
    maxModelCalls < 1 ||
    maxModelCalls > PLANNER_LIMITS.maxModelCalls
  ) {
    reject(`maxModelCalls must be an integer between 1 and ${PLANNER_LIMITS.maxModelCalls}`);
  }
  if (
    typeof maxGeneratedTests !== 'number' ||
    !Number.isSafeInteger(maxGeneratedTests) ||
    maxGeneratedTests < 0 ||
    maxGeneratedTests > PLANNER_LIMITS.maxGeneratedTests
  ) {
    reject(`maxGeneratedTests must be an integer between 0 and ${PLANNER_LIMITS.maxGeneratedTests}`);
  }
  return { maxModelCalls, maxGeneratedTests };
}

function parseProposals(
  value: unknown,
  reservedIds: ReadonlySet<string>,
  maxGeneratedTests: number,
): GeneratedProposal[] {
  if (!isRecord(value)) reject('model output must be an object');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'generatedTests') {
    reject('model output may contain only generatedTests');
  }
  const items = value.generatedTests;
  if (!Array.isArray(items)) reject('generatedTests must be an array');
  if (items.length > maxGeneratedTests) {
    reject(`generatedTests must contain at most ${maxGeneratedTests} entries`);
  }

  const seen = new Set<string>();
  const proposals: GeneratedProposal[] = [];
  items.forEach((item, index) => {
    if (!isRecord(item)) reject(`generatedTests[${index}] must be an object`);
    for (const key of Object.keys(item)) {
      if (!generatedKeys.has(key)) reject(`generatedTests[${index}] may contain only checkId and script`);
    }
    const checkId = item.checkId;
    if (typeof checkId !== 'string' || !checkIdPattern.test(checkId)) {
      reject(`generatedTests[${index}].checkId must be a lower-case identifier`);
    }
    if (reservedIds.has(checkId)) reject(`generatedTests[${index}] cannot replace approved check ${checkId}`);
    if (seen.has(checkId)) reject(`generatedTests contains duplicate checkId ${checkId}`);
    seen.add(checkId);

    const script = item.script;
    if (typeof script !== 'string' || script.trim() === '') {
      reject(`generatedTests[${index}].script must be a non-empty string`);
    }
    if (Buffer.byteLength(script, 'utf8') > PLANNER_LIMITS.maxScriptBytes) {
      reject(`generatedTests[${index}].script exceeds ${PLANNER_LIMITS.maxScriptBytes} bytes`);
    }
    proposals.push({ checkId, script });
  });

  return proposals.sort((left, right) => (left.checkId < right.checkId ? -1 : left.checkId > right.checkId ? 1 : 0));
}

async function persistentDefinition(
  store: TestArtifactStore,
  checkId: string,
  script: string,
  origin: 'approved' | 'generated',
): Promise<TestDefinition> {
  const stored = await store.persist(script);
  return {
    checkId,
    artifactRef: stored.artifactRef,
    contentSha256: stored.contentSha256,
    origin,
  };
}

function approvedDefinition(checkId: unknown, script: unknown): TestDefinition | undefined {
  if (typeof checkId !== 'string' || !checkIdPattern.test(checkId) || typeof script !== 'string') return undefined;
  const digest = sha256Hex(script);
  return { checkId, artifactRef: artifactRefFor(digest), contentSha256: digest, origin: 'approved' };
}

function assertInput(input: PlanChecksInput): void {
  if (!isRecord(input) || !isRecord(input.profile) || !isRecord(input.candidate)) {
    reject('profile and candidate are required');
  }
  if (input.profile.profileDigest !== computeProfileDigest(input.profile)) {
    reject('profile digest does not match its contents');
  }
  if (input.candidate.repository !== input.profile.repository) {
    reject('candidate repository does not match the approved profile repository');
  }
  if (!shaPattern.test(input.candidate.baseSha) || !shaPattern.test(input.candidate.headSha)) {
    reject('candidate base and head must be 40-character commit SHAs');
  }
  if (!input.artifactStore || typeof input.artifactStore.persist !== 'function') {
    reject('artifactStore must persist test bytes before execution');
  }
  if (
    input.model !== undefined &&
    (typeof input.model !== 'object' || input.model === null || typeof input.model.propose !== 'function')
  ) {
    reject('model adapter must expose propose(request) when configured');
  }
}

/**
 * Build a plan from the approved profile, keeping approved checks fixed and
 * adding bounded generated tests when the adapter returns a valid proposal.
 */
export async function planChecks(input: PlanChecksInput): Promise<PlannedCheckPlan> {
  assertInput(input);
  const { profile, candidate, artifactStore, model } = input;
  const limits = resolveLimits(input.limits);

  const requiredChecks: TestDefinition[] = [];
  for (const check of profile.requiredChecks) {
    requiredChecks.push(await persistentDefinition(artifactStore, check.checkId, check.script, 'approved'));
  }
  const regression = await persistentDefinition(
    artifactStore,
    profile.regressionCheck.checkId,
    profile.regressionCheck.script,
    'approved',
  );
  const reservedIds = new Set<string>([
    ...profile.requiredChecks.map((check) => check.checkId),
    profile.regressionCheck.checkId,
  ]);

  const request = Object.freeze({
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    policyVersion: profile.policyVersion,
    repository: candidate.repository,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    changedFiles: Object.freeze([...candidate.changedFiles]),
  });

  let proposals: GeneratedProposal[] | undefined;
  let limitation: string | undefined;
  let modelCalls = 0;
  if (model === undefined) {
    proposals = [];
    limitation =
      'model adapter is not configured: generated checks and planning are unavailable; approved checks were persisted unchanged';
  } else if (limits.maxGeneratedTests === 0) {
    proposals = [];
  } else {
    for (let attempt = 1; attempt <= limits.maxModelCalls; attempt += 1) {
      modelCalls = attempt;
      try {
        proposals = parseProposals(
          await model.propose(Object.freeze({ ...request, attempt })),
          reservedIds,
          limits.maxGeneratedTests,
        );
        limitation = undefined;
        break;
      } catch (error) {
        limitation = `model output rejected: ${
          error instanceof Error ? error.message : String(error)
        }; approved checks were kept unchanged`;
      }
    }
  }

  const generatedTests: TestDefinition[] = [];
  if (proposals) {
    for (const proposal of proposals) {
      generatedTests.push(await persistentDefinition(artifactStore, proposal.checkId, proposal.script, 'generated'));
    }
  }

  const planBase = {
    policyVersion: profile.policyVersion,
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    requiredChecks,
    generatedTests,
  };
  const plan: CheckPlan = { ...planBase, planDigest: computePlanDigest(planBase) };

  return Object.freeze({
    plan,
    regression,
    modelCalls,
    limitations: Object.freeze(limitation === undefined ? [] : [limitation]),
  });
}

/**
 * Jobs-worker planning entry point. Supplies either an existing store or an
 * absolute root; there is no implicit executor, model or filesystem fallback.
 */
export async function planCandidate(
  profile: PrCheckProfile,
  candidate: CandidateRevision,
  options: PlanCandidateOptions,
): Promise<PlannedCheckPlan> {
  if (options === null || typeof options !== 'object') reject('planCandidate options are required');
  const hasStore = options.artifactStore !== undefined;
  const hasRoot = options.artifactsRoot !== undefined;
  if (hasStore === hasRoot) {
    reject('provide exactly one of artifactStore or artifactsRoot');
  }
  const artifactStore = options.artifactStore ?? new TestArtifactStore(options.artifactsRoot as string);
  return planChecks({
    profile,
    candidate,
    artifactStore,
    model: options.model,
    limits: {
      ...(options.maxModelCalls === undefined ? {} : { maxModelCalls: options.maxModelCalls }),
      ...(options.maxGeneratedTests === undefined ? {} : { maxGeneratedTests: options.maxGeneratedTests }),
    },
  });
}

/**
 * Validate a plan against an approved profile before execution.
 *
 * Returns issues instead of throwing so a worker can report Incomplete with a
 * precise reason. Artifact bytes are re-hashed by default; pass
 * `verifyArtifacts: false` only for a structural check before the store exists.
 */
export async function validatePlan(input: ValidatePlanInput): Promise<PlanValidationResult> {
  const issues: PlanValidationIssue[] = [];
  const issue = (area: PlanValidationArea, code: string, detail: string): void => {
    issues.push({ area, code, detail });
  };
  const finish = (): PlanValidationResult => Object.freeze({ ok: issues.length === 0, issues: Object.freeze([...issues]) });

  if (!isRecord(input) || !isRecord(input.profile) || !isRecord(input.plan)) {
    issue('plan', 'plan.input', 'profile and plan are required');
    return finish();
  }
  const profile = input.profile;
  const plan = input.plan;

  try {
    if (profile.profileDigest !== computeProfileDigest(profile)) {
      issue('profile', 'profile.digest', 'profile digest does not match its contents');
    }
  } catch {
    issue('profile', 'profile.digest', 'profile could not be validated');
  }

  const required = profile.requiredChecks;
  const regression = profile.regressionCheck;
  if (!Array.isArray(required) || required.length === 0) {
    issue('profile', 'profile.required', 'approved profile has no required checks');
  }
  const regressionDefinition = isRecord(regression)
    ? approvedDefinition(regression.checkId, regression.script)
    : undefined;
  if (
    !isRecord(regression) ||
    !regressionDefinition ||
    typeof regression.command !== 'string' ||
    !checkIdPattern.test(String(regression.checkId))
  ) {
    issue('profile', 'profile.regression', 'approved profile has no usable regression check');
  } else if (Array.isArray(required) && required.some((check) => check.command === regression.command)) {
    issue(
      'profile',
      'profile.replay',
      'regression check repeats a required command; same-command replay is not independent',
    );
  }

  if (
    plan.profileId !== profile.profileId ||
    plan.profileDigest !== profile.profileDigest ||
    plan.policyVersion !== profile.policyVersion
  ) {
    issue('plan', 'plan.identity', 'plan profile identity does not match the approved profile');
  }
  try {
    if (plan.planDigest !== computePlanDigest(plan)) {
      issue('plan', 'plan.digest', 'plan digest does not match its contents');
    }
  } catch {
    issue('plan', 'plan.digest', 'plan could not be validated');
  }

  if (!Array.isArray(plan.requiredChecks) || !Array.isArray(plan.generatedTests)) {
    issue('plan', 'plan.shape', 'plan checks must be arrays');
    return finish();
  }
  if (Array.isArray(required) && plan.requiredChecks.length !== required.length) {
    issue('plan', 'plan.required-count', 'plan does not contain exactly the approved required checks');
  }

  const validated = new Map<string, TestDefinition>();
  if (Array.isArray(required)) {
    for (const check of required) {
      const definition = plan.requiredChecks.find(
        (item) => isRecord(item) && item.checkId === check.checkId,
      ) as TestDefinition | undefined;
      if (!definition) {
        issue('plan', 'plan.required-missing', `approved check ${check.checkId} is missing from the plan`);
        continue;
      }
      if (validated.has(check.checkId)) {
        issue('plan', 'plan.required-duplicate', `approved check ${check.checkId} appears twice in the plan`);
        continue;
      }
      const digest = sha256Hex(check.script);
      if (
        definition.origin !== 'approved' ||
        definition.contentSha256 !== digest ||
        definition.artifactRef !== artifactRefFor(digest)
      ) {
        issue('plan', 'plan.required-changed', `approved check ${check.checkId} was changed after approval`);
        continue;
      }
      validated.set(check.checkId, definition);
    }
  }

  if (plan.generatedTests.length > PLANNER_LIMITS.maxGeneratedTests) {
    issue(
      'plan',
      'plan.generated-count',
      `plan contains more than ${PLANNER_LIMITS.maxGeneratedTests} generated tests`,
    );
  }
  const reserved = new Set<string>([
    ...(Array.isArray(required) ? required.map((check) => check.checkId) : []),
    ...(isRecord(regression) ? [String(regression.checkId)] : []),
  ]);
  const generatedIds = new Set<string>();
  for (const definition of plan.generatedTests) {
    const valid =
      isRecord(definition) &&
      checkIdPattern.test(String(definition.checkId)) &&
      !reserved.has(definition.checkId) &&
      !generatedIds.has(definition.checkId) &&
      definition.origin === 'generated' &&
      typeof definition.contentSha256 === 'string' &&
      digestPattern.test(definition.contentSha256) &&
      definition.artifactRef === artifactRefFor(definition.contentSha256);
    if (!valid) {
      issue('plan', 'plan.generated-invalid', `generated test ${String(definition?.checkId)} is not a valid addition`);
      continue;
    }
    generatedIds.add(definition.checkId);
    validated.set(definition.checkId, definition);
  }

  const verifyArtifacts = input.verifyArtifacts !== false;
  if (verifyArtifacts) {
    if (!input.artifactStore) {
      issue('artifacts', 'artifacts.store', 'artifactStore is required to verify test bytes');
      return finish();
    }
    const definitions = [
      ...validated.values(),
      ...(regressionDefinition ? [regressionDefinition] : []),
    ];
    for (const definition of definitions) {
      try {
        await input.artifactStore.verify(definition);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        issue('artifacts', 'artifacts.bytes', `${definition.checkId}: ${detail}`);
      }
    }
  }

  return finish();
}
