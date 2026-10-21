import type { CandidateRevision, CheckPlan, TestDefinition } from '../../packages/contracts/src/index.js';
import { TestArtifactStore } from './evidence.js';
import {
  PROFILE_LIMITS,
  computeProfileDigest,
  sha256Hex,
  stableStringify,
  type PrCheckProfile,
} from './profile.js';

/**
 * Bounded, model-assisted check planning.
 *
 * The model may propose extra generated tests. It may not change approved
 * checks, commands, tools or limits: only `{ generatedTests: [{ checkId,
 * script }] }` is accepted, at most twice, with at most four entries. The
 * model sees candidate metadata, never patch bytes, and its output is never
 * trusted as evidence.
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

export interface PlanChecksInput {
  readonly profile: PrCheckProfile;
  readonly candidate: CandidateRevision;
  readonly artifactStore: TestArtifactStore;
  readonly model: PlannerModelAdapter;
}

export interface PlannedCheckPlan {
  readonly plan: CheckPlan;
  /** Regression definition is content addressed but not part of CheckPlan. */
  readonly regression: TestDefinition;
  readonly modelCalls: number;
  readonly limitations: readonly string[];
}

const checkIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const shaPattern = /^[0-9a-f]{40}$/;
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

function parseProposals(value: unknown, reservedIds: ReadonlySet<string>): GeneratedProposal[] {
  if (!isRecord(value)) reject('model output must be an object');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'generatedTests') {
    reject('model output may contain only generatedTests');
  }
  const items = value.generatedTests;
  if (!Array.isArray(items)) reject('generatedTests must be an array');
  if (items.length > PLANNER_LIMITS.maxGeneratedTests) {
    reject(`generatedTests must contain at most ${PLANNER_LIMITS.maxGeneratedTests} entries`);
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
  if (!input.model || typeof input.model.propose !== 'function') {
    reject('model adapter with propose(request) is required');
  }
}

/**
 * Build a plan from the approved profile, keeping approved checks fixed and
 * adding bounded generated tests when the adapter returns a valid proposal.
 */
export async function planChecks(input: PlanChecksInput): Promise<PlannedCheckPlan> {
  assertInput(input);
  const { profile, candidate, artifactStore, model } = input;

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
  for (let attempt = 1; attempt <= PLANNER_LIMITS.maxModelCalls; attempt += 1) {
    modelCalls = attempt;
    try {
      proposals = parseProposals(await model.propose(Object.freeze({ ...request, attempt })), reservedIds);
      limitation = undefined;
      break;
    } catch (error) {
      limitation = error instanceof Error ? error.message : String(error);
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
    limitations: Object.freeze(
      limitation === undefined ? [] : [`model output rejected: ${limitation}; approved checks were kept unchanged`],
    ),
  });
}
