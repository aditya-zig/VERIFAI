import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ProfileValidationError,
  computeProfileDigest,
  defineApprovedProfile,
  sha256Hex,
  type PrCheckProfileInput,
} from '../services/pr-verification/profile.js';

function profileInput(overrides: Partial<PrCheckProfileInput> = {}): PrCheckProfileInput {
  return {
    profileId: 'verifai-demo',
    policyVersion: '1',
    repository: 'acme/shop',
    policyCommitSha: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`,
    dependencyDigests: [{ name: 'package-lock.json', sha256: 'c'.repeat(64) }],
    requiredChecks: [
      { checkId: 'unit', command: 'node scripts/unit.mjs', script: 'export const unit = 1;\n', timeoutMs: 30_000 },
      { checkId: 'types', command: 'node scripts/types.mjs', script: 'export const types = 1;\n', timeoutMs: 30_000 },
    ],
    regressionCheck: { checkId: 'smoke', command: 'node scripts/smoke.mjs', script: 'export const smoke = 1;\n', timeoutMs: 30_000 },
    ...overrides,
  };
}

function rejection(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (!(error instanceof ProfileValidationError)) {
      throw new Error(`expected ProfileValidationError, got ${String(error)}`);
    }
    return error.message;
  }
  throw new Error('expected the profile to be rejected');
}

test('approved profile is frozen and its digest is content addressed', () => {
  const profile = defineApprovedProfile(profileInput());

  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.requiredChecks), true);
  assert.equal(Object.isFrozen(profile.requiredChecks[0]), true);
  assert.equal(profile.profileDigest, computeProfileDigest(profile));
  assert.match(profile.profileDigest, /^[0-9a-f]{64}$/);

  assert.throws(() => (profile.requiredChecks as unknown as Array<unknown>).push({ checkId: 'extra' }));
  assert.throws(() => {
    (profile.requiredChecks[0] as { command: string }).command = 'echo weakened';
  });

  const changedScript = defineApprovedProfile(
    profileInput({
      requiredChecks: [
        { checkId: 'unit', command: 'node scripts/unit.mjs', script: 'export const unit = 2;\n', timeoutMs: 30_000 },
        { checkId: 'types', command: 'node scripts/types.mjs', script: 'export const types = 1;\n', timeoutMs: 30_000 },
      ],
    }),
  );
  assert.notEqual(changedScript.profileDigest, profile.profileDigest);
});

test('required check scripts are content addressed with sha256', () => {
  const profile = defineApprovedProfile(profileInput());
  assert.equal(sha256Hex(profile.requiredChecks[0]!.script), sha256Hex('export const unit = 1;\n'));
  assert.match(sha256Hex(profile.requiredChecks[0]!.script), /^[0-9a-f]{64}$/);
});

test('regression check must be independent from every required command', () => {
  const message = rejection(() =>
    defineApprovedProfile(
      profileInput({
        regressionCheck: { checkId: 'smoke', command: 'node scripts/unit.mjs', script: 'export const smoke = 1;\n', timeoutMs: 30_000 },
      }),
    ),
  );
  assert.match(message, /independent/);
});

test('profile rejects malformed repository, policy commit, image and dependency digests', () => {
  assert.match(rejection(() => defineApprovedProfile(profileInput({ repository: 'acme' }))), /repository/);
  assert.match(rejection(() => defineApprovedProfile(profileInput({ policyCommitSha: 'abc' }))), /policyCommitSha/);
  assert.match(rejection(() => defineApprovedProfile(profileInput({ imageDigest: 'latest' }))), /imageDigest/);
  assert.match(
    rejection(() => defineApprovedProfile(profileInput({ dependencyDigests: [{ name: 'lock', sha256: 'nope' }] }))),
    /dependencyDigests/,
  );
  assert.match(rejection(() => defineApprovedProfile(profileInput({ requiredChecks: [] }))), /requiredChecks/);
});

test('profile rejects duplicate, reserved and unsafe check identifiers', () => {
  assert.match(
    rejection(() =>
      defineApprovedProfile(
        profileInput({
          requiredChecks: [
            { checkId: 'unit', command: 'node scripts/unit.mjs', script: 'a', timeoutMs: 30_000 },
            { checkId: 'unit', command: 'node scripts/types.mjs', script: 'b', timeoutMs: 30_000 },
          ],
        }),
      ),
    ),
    /duplicate/,
  );
  assert.match(
    rejection(() =>
      defineApprovedProfile(
        profileInput({
          regressionCheck: { checkId: 'smoke', command: 'node scripts/smoke.mjs', script: 'a', timeoutMs: 30_000 },
          requiredChecks: [{ checkId: 'smoke', command: 'node scripts/unit.mjs', script: 'b', timeoutMs: 30_000 }],
        }),
      ),
    ),
    /reserved|duplicate/,
  );
  assert.match(
    rejection(() =>
      defineApprovedProfile(
        profileInput({
          requiredChecks: [{ checkId: '../escape', command: 'node scripts/unit.mjs', script: 'a', timeoutMs: 30_000 }],
        }),
      ),
    ),
    /checkId/,
  );
});

test('demo profile in config validates and stays non-AWS', async () => {
  const raw = await readFile('config/pr-demo-profile.json', 'utf8');
  const config = JSON.parse(raw) as PrCheckProfileInput;
  const profile = defineApprovedProfile(config);

  assert.equal(profile.profileId, 'verifai-pr-demo');
  assert.equal(profile.repository, 'acme/shop');
  assert.ok(profile.requiredChecks.length >= 1);
  assert.equal(profile.profileDigest, computeProfileDigest(config));
  for (const check of [...profile.requiredChecks, profile.regressionCheck]) {
    assert.equal(/aws|bedrock|agentcore/i.test(check.command), false);
  }
});
