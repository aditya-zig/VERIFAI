import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateRevision } from '../packages/contracts/src/index.js';
import {
  PLANNER_LIMITS,
  PlanValidationError,
  computePlanDigest,
  generatedTestCommand,
  planChecks,
  type PlannerModelAdapter,
  type PlannerModelRequest,
} from '../services/pr-verification/planner.js';
import { defineApprovedProfile, sha256Hex, type PrCheckProfile } from '../services/pr-verification/profile.js';
import { TestArtifactStore, artifactFilePath } from '../services/pr-verification/evidence.js';

// The repository's minimal node shim omits rm; tests need it for cleanup.
const fs: any = await import('node:fs/promises');

const ROOT = '/tmp/opencode/pr-policy-planner';
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

async function freshRoot(): Promise<string> {
  const root = join(ROOT, randomUUID());
  await mkdir(root, { recursive: true });
  return root;
}

class ScriptedModel implements PlannerModelAdapter {
  readonly requests: PlannerModelRequest[] = [];
  readonly #responses: unknown[];

  constructor(responses: unknown[]) {
    this.#responses = responses;
  }

  async propose(request: PlannerModelRequest): Promise<unknown> {
    this.requests.push(request);
    const response = this.#responses[Math.min(this.requests.length - 1, this.#responses.length - 1)];
    if (response instanceof Error) throw response;
    return response;
  }
}

async function withPlan(
  responses: unknown[],
  run: (result: Awaited<ReturnType<typeof planChecks>>, model: ScriptedModel, root: string) => Promise<void>,
): Promise<void> {
  const root = await freshRoot();
  try {
    const model = new ScriptedModel(responses);
    const result = await planChecks({
      profile: PROFILE,
      candidate: CANDIDATE,
      artifactStore: new TestArtifactStore(root),
      model,
    });
    await run(result, model, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('plans immutable approved checks and persists their bytes before execution', async () => {
  await withPlan([{ generatedTests: [{ checkId: 'generated-edge', script: 'edge bytes\n' }] }], async (result, model, root) => {
    assert.equal(model.requests.length, 1);
    assert.deepEqual(
      result.plan.requiredChecks.map((check) => check.checkId),
      ['unit', 'types'],
    );
    assert.deepEqual(
      result.plan.requiredChecks.map((check) => check.origin),
      ['approved', 'approved'],
    );
    assert.equal(result.plan.generatedTests.length, 1);
    assert.equal(result.plan.generatedTests[0]!.origin, 'generated');
    assert.equal(result.plan.policyVersion, PROFILE.policyVersion);
    assert.equal(result.plan.profileId, PROFILE.profileId);
    assert.equal(result.plan.profileDigest, PROFILE.profileDigest);
    assert.equal(result.plan.planDigest, computePlanDigest(result.plan));

    for (const [index, check] of PROFILE.requiredChecks.entries()) {
      const definition = result.plan.requiredChecks[index]!;
      assert.equal(definition.contentSha256, sha256Hex(check.script));
      assert.deepEqual(await readFile(artifactFilePath(root, definition.contentSha256)), Buffer.from(check.script));
    }
    assert.equal(result.regression.checkId, 'smoke');
    assert.deepEqual(
      await readFile(artifactFilePath(root, result.regression.contentSha256)),
      Buffer.from(PROFILE.regressionCheck.script),
    );

    const generated = result.plan.generatedTests[0]!;
    assert.equal(generatedTestCommand(generated), `node --test ${generated.artifactRef}`);
    assert.deepEqual(await readFile(artifactFilePath(root, generated.contentSha256)), Buffer.from('edge bytes\n'));
    assert.deepEqual(result.limitations, []);
  });
});

test('model output cannot remove approved checks, add tools or weaken commands', async () => {
  const hostile = {
    generatedTests: [],
    requiredChecks: [],
    tools: ['shell', 'aws'],
    commands: { unit: 'true' },
  };
  await withPlan([hostile, hostile], async (result, model) => {
    assert.equal(model.requests.length, PLANNER_LIMITS.maxModelCalls);
    assert.deepEqual(
      result.plan.requiredChecks.map((check) => check.checkId),
      ['unit', 'types'],
    );
    assert.equal(result.plan.generatedTests.length, 0);
    assert.equal(JSON.stringify(result.plan).includes('shell'), false);
    assert.equal(PROFILE.requiredChecks[0]!.command, 'node scripts/unit.mjs');
    assert.ok(result.limitations.some((item) => item.includes('model output rejected')));
  });
});

test('rejects more generated tests than the server bound allows', async () => {
  const tooMany = {
    generatedTests: Array.from({ length: PLANNER_LIMITS.maxGeneratedTests + 1 }, (_, index) => ({
      checkId: `generated-${index}`,
      script: `test ${index}\n`,
    })),
  };
  await withPlan([tooMany, tooMany], async (result, model) => {
    assert.equal(model.requests.length, 2);
    assert.equal(result.plan.generatedTests.length, 0);
    assert.ok(result.limitations.some((item) => item.includes(`at most ${PLANNER_LIMITS.maxGeneratedTests}`)));
  });
});

test('rejects generated tests that collide with approved or regression check ids', async () => {
  const collisions = {
    generatedTests: [
      { checkId: 'unit', script: 'replacement unit\n' },
      { checkId: 'smoke', script: 'replacement smoke\n' },
    ],
  };
  await withPlan([collisions, collisions], async (result) => {
    assert.equal(result.plan.generatedTests.length, 0);
    assert.equal(result.plan.requiredChecks[0]!.contentSha256, sha256Hex(PROFILE.requiredChecks[0]!.script));
    assert.equal(result.regression.contentSha256, sha256Hex(PROFILE.regressionCheck.script));
  });
});

test('rejects unknown fields, duplicate generated ids and oversized scripts', async () => {
  const unknownField = {
    generatedTests: [{ checkId: 'generated-edge', script: 'ok\n', tools: ['shell'] }],
  };
  await withPlan([unknownField, unknownField], async (result) => {
    assert.equal(result.plan.generatedTests.length, 0);
  });

  await withPlan(
    [
      {
        generatedTests: [
          { checkId: 'generated-edge', script: 'one\n' },
          { checkId: 'generated-edge', script: 'two\n' },
        ],
      },
    ],
    async (result) => {
      assert.equal(result.plan.generatedTests.length, 0);
    },
  );

  await withPlan(
    [{ generatedTests: [{ checkId: 'generated-edge', script: 'x'.repeat(PLANNER_LIMITS.maxScriptBytes + 1) }] }],
    async (result) => {
      assert.equal(result.plan.generatedTests.length, 0);
    },
  );
});

test('adapter failures stay bounded and leave the approved plan intact', async () => {
  await withPlan([new Error('model unavailable')], async (result, model) => {
    assert.equal(model.requests.length, 2);
    assert.equal(result.plan.requiredChecks.length, 2);
    assert.equal(result.plan.generatedTests.length, 0);
    assert.ok(result.limitations.some((item) => item.includes('model output rejected')));
  });
});

test('refuses a candidate from another repository before any model call', async () => {
  const root = await freshRoot();
  try {
    const model = new ScriptedModel([{ generatedTests: [] }]);
    let rejection: unknown;
    try {
      await planChecks({
        profile: PROFILE,
        candidate: { ...CANDIDATE, repository: 'other/repo' },
        artifactStore: new TestArtifactStore(root),
        model,
      });
    } catch (error) {
      rejection = error;
    }
    if (!(rejection instanceof PlanValidationError)) throw new Error(`unexpected rejection: ${String(rejection)}`);
    assert.match(rejection.message, /repository/);
    assert.equal(model.requests.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
