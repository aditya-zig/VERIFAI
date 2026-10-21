import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProfileValidationError,
  computeProfileDigest,
  defineApprovedProfile,
  loadApprovedProfile,
  type PrCheckProfileInput,
} from '../services/pr-verification/profile.js';

// The repository's minimal node shim omits rm/symlink; tests need them.
const fs: any = await import('node:fs/promises');
const ROOT = '/tmp/opencode/pr-policy-load';

async function freshRoot(): Promise<string> {
  const root = join(ROOT, randomUUID());
  await mkdir(root, { recursive: true });
  return root;
}

async function readDemoProfile(): Promise<PrCheckProfileInput> {
  return JSON.parse(await readFile('config/pr-demo-profile.json', 'utf8')) as PrCheckProfileInput;
}

async function rejection(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof ProfileValidationError)) {
      throw new Error(`expected ProfileValidationError, got ${String(error)}`);
    }
    return error.message;
  }
  throw new Error('expected the profile load to be rejected');
}

test('loads and validates an approved profile from an absolute file', async () => {
  const root = await freshRoot();
  try {
    const config = await readDemoProfile();
    const path = join(root, 'profile.json');
    await writeFile(path, JSON.stringify(config), 'utf8');

    const profile = await loadApprovedProfile(path);
    assert.equal(profile.profileId, 'verifai-pr-demo');
    assert.equal(profile.profileDigest, computeProfileDigest(config));
    assert.equal(profile.profileDigest, defineApprovedProfile(config).profileDigest);
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.requiredChecks), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('accepts a UTF-8 BOM but rejects invalid JSON and non-object profiles', async () => {
  const root = await freshRoot();
  try {
    const config = await readDemoProfile();
    const bomPath = join(root, 'bom.json');
    await writeFile(bomPath, `\uFEFF${JSON.stringify(config)}`, 'utf8');
    const profile = await loadApprovedProfile(bomPath);
    assert.equal(profile.profileId, config.profileId);

    const brokenPath = join(root, 'broken.json');
    await writeFile(brokenPath, '{"profileId":', 'utf8');
    assert.match(await rejection(() => loadApprovedProfile(brokenPath)), /valid JSON/);

    const arrayPath = join(root, 'array.json');
    await writeFile(arrayPath, '[]', 'utf8');
    assert.match(await rejection(() => loadApprovedProfile(arrayPath)), /profile must be an object/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects relative, missing, non-file and oversized profile paths', async () => {
  const root = await freshRoot();
  try {
    assert.match(await rejection(() => loadApprovedProfile('config/pr-demo-profile.json')), /absolute/);
    assert.match(await rejection(() => loadApprovedProfile(join(root, 'missing.json'))), /cannot be read/);
    assert.match(await rejection(() => loadApprovedProfile(root)), /regular file/);

    const config = await readDemoProfile();
    const path = join(root, 'profile.json');
    await writeFile(path, JSON.stringify(config), 'utf8');
    assert.match(await rejection(() => loadApprovedProfile(path, { maxBytes: 10 })), /exceeds 10 bytes/);
    assert.match(
      await rejection(() => loadApprovedProfile(path, { maxBytes: 8 * 1024 * 1024 })),
      /maxBytes must be an integer/,
    );

    const link = join(root, 'profile-link.json');
    await fs.symlink(path, link);
    assert.match(await rejection(() => loadApprovedProfile(link)), /regular file/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('profile file with no required checks is rejected', async () => {
  const root = await freshRoot();
  try {
    const config = (await readDemoProfile()) as unknown as Record<string, unknown>;
    const path = join(root, 'weak.json');
    await writeFile(path, JSON.stringify({ ...config, requiredChecks: [] }), 'utf8');
    assert.match(await rejection(() => loadApprovedProfile(path)), /requiredChecks/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
