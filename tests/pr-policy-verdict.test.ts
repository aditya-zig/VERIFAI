import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CandidateRevision,
  CheckObservation,
  PrVerdict,
  TestDefinition,
} from '../packages/contracts/src/index.js';
import { computeProfileDigest, defineApprovedProfile, sha256Hex, type PrCheckProfile } from '../services/pr-verification/profile.js';
import { TestArtifactStore, artifactFilePath } from '../services/pr-verification/evidence.js';
import {
  computePlanDigest,
  generatedTestCommand,
  planChecks,
  type PlannedCheckPlan,
} from '../services/pr-verification/planner.js';
import {
  computeEvidenceManifestSha256,
  evaluateCandidate,
  type CandidateEvaluation,
} from '../services/pr-verification/verdict.js';

const ROOT = '/tmp/opencode/pr-policy-verdict';
// The repository's minimal node shim omits rm; tests need it for cleanup.
const fs: any = await import('node:fs/promises');
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);

const PROFILE: PrCheckProfile = defineApprovedProfile({
  profileId: 'verifai-demo',
  policyVersion: '1',
  repository: 'acme/shop',
  policyCommitSha: 'a'.repeat(40),
  imageDigest: `sha256:${'b'.repeat(64)}`,
  dependencyDigests: [{ name: 'package-lock.json', sha256: 'c'.repeat(64) }],
  requiredChecks: [
    { checkId: 'unit', command: 'node scripts/unit.mjs', script: 'unit bytes\n', timeoutMs: 30_000 },
    { checkId: 'types', command: 'node scripts/types.mjs', script: 'types bytes\n', timeoutMs: 30_000 },
  ],
  regressionCheck: { checkId: 'smoke', command: 'node scripts/smoke.mjs', script: 'smoke bytes\n', timeoutMs: 30_000 },
});

const CANDIDATE: CandidateRevision = {
  repository: 'acme/shop',
  pullRequest: 7,
  headRepository: 'acme/shop',
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  mergeBaseSha: '3'.repeat(40),
  changedFiles: ['src/app.ts'],
  diffDigest: 'd'.repeat(64),
};

interface Fixture {
  root: string;
  planned: PlannedCheckPlan;
  definitions: Map<string, TestDefinition>;
  commands: Map<string, string>;
}

async function fixture(): Promise<Fixture> {
  const root = join(ROOT, randomUUID());
  await mkdir(root, { recursive: true });
  const planned = await planChecks({
    profile: PROFILE,
    candidate: CANDIDATE,
    artifactStore: new TestArtifactStore(root),
    model: {
      propose: async () => ({ generatedTests: [{ checkId: 'generated-edge', script: 'edge case\n' }] }),
    },
  });
  const definitions = new Map<string, TestDefinition>();
  const commands = new Map<string, string>();
  for (const definition of planned.plan.requiredChecks) {
    definitions.set(definition.checkId, definition);
    commands.set(definition.checkId, PROFILE.requiredChecks.find((check) => check.checkId === definition.checkId)!.command);
  }
  for (const definition of planned.plan.generatedTests) {
    definitions.set(definition.checkId, definition);
    commands.set(definition.checkId, generatedTestCommand(definition));
  }
  definitions.set(planned.regression.checkId, planned.regression);
  commands.set(planned.regression.checkId, PROFILE.regressionCheck.command);
  return { root, planned, definitions, commands };
}

function observation(
  fixtureValue: Fixture,
  checkId: string,
  revision: 'base' | 'head',
  status: PrVerdict,
  exitCode: number | null,
  overrides: Partial<CheckObservation> = {},
): CheckObservation {
  const definition = fixtureValue.definitions.get(checkId);
  const command = fixtureValue.commands.get(checkId);
  if (!definition || !command) throw new Error(`missing definition for ${checkId}`);
  return {
    checkId,
    revision,
    commitSha: revision === 'base' ? BASE_SHA : HEAD_SHA,
    status,
    executed: true,
    exitCode,
    artifactRefs: [`evidence://run/${checkId}/${revision}`],
    commandDigest: sha256Hex(command),
    testContentSha256: definition.contentSha256,
    ...overrides,
  };
}

function passingObservations(fixtureValue: Fixture): CheckObservation[] {
  return [
    observation(fixtureValue, 'unit', 'base', 'Verified', 0),
    observation(fixtureValue, 'unit', 'head', 'Verified', 0),
    observation(fixtureValue, 'types', 'base', 'Verified', 0),
    observation(fixtureValue, 'types', 'head', 'Verified', 0),
    observation(fixtureValue, 'smoke', 'base', 'Verified', 0),
    observation(fixtureValue, 'smoke', 'head', 'Verified', 0),
    observation(fixtureValue, 'generated-edge', 'head', 'Verified', 0),
  ];
}

async function evaluate(
  fixtureValue: Fixture,
  observations: CheckObservation[],
  overrides: Partial<Parameters<typeof evaluateCandidate>[0]> = {},
): Promise<CandidateEvaluation> {
  return evaluateCandidate({
    candidate: CANDIDATE,
    plan: fixtureValue.planned.plan,
    profile: PROFILE,
    observations,
    artifactStore: new TestArtifactStore(fixtureValue.root),
    cleanupComplete: true,
    superseded: false,
    ...overrides,
  });
}

function reasonCodes(evaluation: CandidateEvaluation): string[] {
  return evaluation.reasons.map((reason) => reason.code);
}

async function withFixture(run: (fixtureValue: Fixture) => Promise<void>): Promise<void> {
  const fixtureValue = await fixture();
  try {
    await run(fixtureValue);
  } finally {
    await fs.rm(fixtureValue.root, { recursive: true, force: true });
  }
}

test('verifies a candidate when every required, regression and generated check passes', async () => {
  await withFixture(async (fixtureValue) => {
    const evaluation = await evaluate(fixtureValue, passingObservations(fixtureValue));

    assert.equal(evaluation.result.verdict, 'Verified');
    assert.deepEqual(reasonCodes(evaluation), []);
    assert.deepEqual(evaluation.result.limitations, []);
    assert.equal(evaluation.result.candidate.headSha, HEAD_SHA);
    assert.equal(evaluation.result.plan.planDigest, fixtureValue.planned.plan.planDigest);
    assert.equal(evaluation.result.cleanupComplete, true);
    assert.equal(evaluation.result.superseded, false);
    assert.match(evaluation.result.evidenceManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(evaluation.result.observations.length, 7);
  });
});

test('a head failure on a passing base is a candidate regression', async () => {
  await withFixture(async (fixtureValue) => {
    const observations = passingObservations(fixtureValue);
    observations[1] = observation(fixtureValue, 'unit', 'head', 'Failed', 1);
    const evaluation = await evaluate(fixtureValue, observations);

    assert.equal(evaluation.result.verdict, 'Failed');
    assert.ok(reasonCodes(evaluation).includes('failed.candidate-regression'));
    assert.ok(evaluation.result.limitations.some((item) => item.includes('unit')));
  });
});

test('a failing base is disclosed and never called a candidate regression', async () => {
  await withFixture(async (fixtureValue) => {
    const observations = passingObservations(fixtureValue);
    observations[0] = observation(fixtureValue, 'unit', 'base', 'Failed', 2);
    observations[1] = observation(fixtureValue, 'unit', 'head', 'Failed', 2);
    const evaluation = await evaluate(fixtureValue, observations);

    assert.equal(evaluation.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(evaluation).includes('incomplete.base-failure'));
    assert.equal(reasonCodes(evaluation).includes('failed.candidate-regression'), false);
    assert.ok(evaluation.result.limitations.some((item) => item.includes('base')));
  });
});

test('missing required, regression or generated observations are incomplete', async () => {
  await withFixture(async (fixtureValue) => {
    const missingRequired = passingObservations(fixtureValue).filter(
      (item) => !(item.checkId === 'types' && item.revision === 'head'),
    );
    const requiredEvaluation = await evaluate(fixtureValue, missingRequired);
    assert.equal(requiredEvaluation.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(requiredEvaluation).includes('incomplete.missing-check'));

    const missingRegression = passingObservations(fixtureValue).filter((item) => item.checkId !== 'smoke');
    const regressionEvaluation = await evaluate(fixtureValue, missingRegression);
    assert.equal(regressionEvaluation.result.verdict, 'Incomplete');

    const missingGenerated = passingObservations(fixtureValue).filter((item) => item.checkId !== 'generated-edge');
    const generatedEvaluation = await evaluate(fixtureValue, missingGenerated);
    assert.equal(generatedEvaluation.result.verdict, 'Incomplete');
  });
});

test('contradictory records are incomplete: exit code, status and executed must agree', async () => {
  await withFixture(async (fixtureValue) => {
    const badExit = passingObservations(fixtureValue);
    badExit[1] = observation(fixtureValue, 'unit', 'head', 'Verified', 1);
    const exitEvaluation = await evaluate(fixtureValue, badExit);
    assert.equal(exitEvaluation.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(exitEvaluation).includes('incomplete.observation'));

    const badFlag = passingObservations(fixtureValue);
    badFlag[1] = observation(fixtureValue, 'unit', 'head', 'Verified', 0, { executed: false });
    const flagEvaluation = await evaluate(fixtureValue, badFlag);
    assert.equal(flagEvaluation.result.verdict, 'Incomplete');

    const nullExit = passingObservations(fixtureValue);
    nullExit[1] = observation(fixtureValue, 'unit', 'head', 'Verified', null);
    const nullEvaluation = await evaluate(fixtureValue, nullExit);
    assert.equal(nullEvaluation.result.verdict, 'Incomplete');
  });
});

test('records must target the correct commit, command and test digest', async () => {
  await withFixture(async (fixtureValue) => {
    const wrongCommit = passingObservations(fixtureValue);
    wrongCommit[1] = observation(fixtureValue, 'unit', 'head', 'Verified', 0, { commitSha: BASE_SHA });
    const commitEvaluation = await evaluate(fixtureValue, wrongCommit);
    assert.equal(commitEvaluation.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(commitEvaluation).includes('incomplete.observation'));

    const wrongCommand = passingObservations(fixtureValue);
    wrongCommand[1] = observation(fixtureValue, 'unit', 'head', 'Verified', 0, {
      commandDigest: sha256Hex('node scripts/other.mjs'),
    });
    const commandEvaluation = await evaluate(fixtureValue, wrongCommand);
    assert.equal(commandEvaluation.result.verdict, 'Incomplete');

    const wrongDigest = passingObservations(fixtureValue);
    wrongDigest[1] = observation(fixtureValue, 'unit', 'head', 'Verified', 0, {
      testContentSha256: sha256Hex('different test bytes\n'),
    });
    const digestEvaluation = await evaluate(fixtureValue, wrongDigest);
    assert.equal(digestEvaluation.result.verdict, 'Incomplete');

    const noEvidence = passingObservations(fixtureValue);
    noEvidence[1] = observation(fixtureValue, 'unit', 'head', 'Verified', 0, { artifactRefs: [] });
    const evidenceEvaluation = await evaluate(fixtureValue, noEvidence);
    assert.equal(evidenceEvaluation.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(evidenceEvaluation).includes('incomplete.evidence'));
  });
});

test('tampered test bytes on disk invalidate the evaluation', async () => {
  await withFixture(async (fixtureValue) => {
    const definition = fixtureValue.planned.plan.requiredChecks[0]!;
    await writeFile(artifactFilePath(fixtureValue.root, definition.contentSha256), 'swapped at rest\n', 'utf8');

    const evaluation = await evaluate(fixtureValue, passingObservations(fixtureValue));
    assert.equal(evaluation.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(evaluation).includes('incomplete.artifacts'));
  });
});

test('flaky duplicate observations are unknown, not verified or failed', async () => {
  await withFixture(async (fixtureValue) => {
    const observations = [
      ...passingObservations(fixtureValue),
      observation(fixtureValue, 'unit', 'head', 'Failed', 1),
    ];
    const evaluation = await evaluate(fixtureValue, observations);
    assert.equal(evaluation.result.verdict, 'Unknown');
    assert.ok(reasonCodes(evaluation).includes('unknown.flaky'));
  });
});

test('an unknown observation is unknown when nothing else is incomplete', async () => {
  await withFixture(async (fixtureValue) => {
    const observations = passingObservations(fixtureValue);
    observations[1] = observation(fixtureValue, 'unit', 'head', 'Unknown', 0);
    const evaluation = await evaluate(fixtureValue, observations);
    assert.equal(evaluation.result.verdict, 'Unknown');
    assert.ok(reasonCodes(evaluation).includes('unknown.status'));
  });
});

test('model opinion cannot override recorded checks', async () => {
  await withFixture(async (fixtureValue) => {
    const passing = await evaluate(fixtureValue, passingObservations(fixtureValue), { modelOpinion: 'Failed' });
    assert.equal(passing.result.verdict, 'Verified');
    assert.ok(passing.result.limitations.some((item) => item.includes('model opinion')));

    const failingObservations = passingObservations(fixtureValue);
    failingObservations[1] = observation(fixtureValue, 'unit', 'head', 'Failed', 1);
    const failing = await evaluate(fixtureValue, failingObservations, { modelOpinion: 'Verified' });
    assert.equal(failing.result.verdict, 'Failed');
  });
});

test('cleanup and supersession gates are incomplete', async () => {
  await withFixture(async (fixtureValue) => {
    const cleanup = await evaluate(fixtureValue, passingObservations(fixtureValue), { cleanupComplete: false });
    assert.equal(cleanup.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(cleanup).includes('incomplete.cleanup'));

    const superseded = await evaluate(fixtureValue, passingObservations(fixtureValue), { superseded: true });
    assert.equal(superseded.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(superseded).includes('incomplete.superseded'));
  });
});

test('a generated test failure fails the candidate', async () => {
  await withFixture(async (fixtureValue) => {
    const observations = passingObservations(fixtureValue);
    observations[6] = observation(fixtureValue, 'generated-edge', 'head', 'Failed', 1);
    const evaluation = await evaluate(fixtureValue, observations);
    assert.equal(evaluation.result.verdict, 'Failed');
    assert.ok(reasonCodes(evaluation).includes('failed.candidate-regression'));
  });
});

test('an approved check removed or weakened in the plan is rejected', async () => {
  await withFixture(async (fixtureValue) => {
    const weakened = structuredClone(fixtureValue.planned.plan);
    weakened.requiredChecks = weakened.requiredChecks.filter((check) => check.checkId !== 'types');
    weakened.planDigest = computePlanDigest(weakened);
    const evaluation = await evaluate(fixtureValue, passingObservations(fixtureValue), { plan: weakened });
    assert.equal(evaluation.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(evaluation).includes('incomplete.plan'));

    const swapped = structuredClone(fixtureValue.planned.plan);
    swapped.requiredChecks[0]!.contentSha256 = sha256Hex('weaker test\n');
    swapped.requiredChecks[0]!.artifactRef = `artifact://tests/${sha256Hex('weaker test\n')}`;
    swapped.planDigest = computePlanDigest(swapped);
    const swappedEvaluation = await evaluate(fixtureValue, passingObservations(fixtureValue), { plan: swapped });
    assert.equal(swappedEvaluation.result.verdict, 'Incomplete');
  });
});

test('a candidate outside the approved profile repository is incomplete', async () => {
  await withFixture(async (fixtureValue) => {
    const evaluation = await evaluate(fixtureValue, passingObservations(fixtureValue), {
      candidate: { ...CANDIDATE, repository: 'other/repo' },
    });
    assert.equal(evaluation.result.verdict, 'Incomplete');
    assert.ok(reasonCodes(evaluation).includes('incomplete.profile'));
  });
});

test('a same-command replay cannot serve as the independent regression check', async () => {
  await withFixture(async (fixtureValue) => {
    const weakBase = {
      ...PROFILE,
      regressionCheck: { ...PROFILE.regressionCheck, command: PROFILE.requiredChecks[0]!.command },
    };
    const weakProfile: PrCheckProfile = { ...weakBase, profileDigest: computeProfileDigest(weakBase) };

    const evaluation = await evaluate(fixtureValue, passingObservations(fixtureValue), { profile: weakProfile });
    assert.equal(evaluation.result.verdict, 'Incomplete');
    assert.ok(evaluation.reasons.some((reason) => reason.detail.includes('same-command replay')));
  });
});

test('the evidence manifest is deterministic and changes with records', async () => {
  await withFixture(async (fixtureValue) => {
    const first = passingObservations(fixtureValue);
    const second = [...first].reverse();

    const digestOne = computeEvidenceManifestSha256({
      candidate: CANDIDATE,
      plan: fixtureValue.planned.plan,
      observations: first,
      cleanupComplete: true,
      superseded: false,
    });
    const digestTwo = computeEvidenceManifestSha256({
      candidate: CANDIDATE,
      plan: fixtureValue.planned.plan,
      observations: second,
      cleanupComplete: true,
      superseded: false,
    });
    assert.equal(digestOne, digestTwo);
    assert.match(digestOne, /^[0-9a-f]{64}$/);

    const changed = passingObservations(fixtureValue);
    changed[0] = observation(fixtureValue, 'unit', 'base', 'Failed', 1);
    const digestThree = computeEvidenceManifestSha256({
      candidate: CANDIDATE,
      plan: fixtureValue.planned.plan,
      observations: changed,
      cleanupComplete: true,
      superseded: false,
    });
    assert.notEqual(digestThree, digestOne);
  });
});
