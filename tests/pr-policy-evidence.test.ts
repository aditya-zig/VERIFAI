import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestDefinition } from '../packages/contracts/src/index.js';
import {
  ARTIFACT_LIMITS,
  ArtifactError,
  EvidenceWriter,
  TestArtifactStore,
  artifactFilePath,
  artifactRefFor,
  evidenceFilePath,
} from '../services/pr-verification/evidence.js';
import { sha256Hex } from '../services/pr-verification/profile.js';

// The repository's minimal node shim declares only the fs functions the
// production code needs. Tests add rm/stat/symlink through a typed-any view.
const fs: any = await import('node:fs/promises');

const ROOT = '/tmp/opencode/pr-policy-artifacts';

async function freshRoot(): Promise<string> {
  const root = join(ROOT, randomUUID());
  await mkdir(root, { recursive: true });
  return root;
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

async function artifactError(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw new Error(`expected ArtifactError, got ${String(error)}`);
    return error.code;
  }
  throw new Error('expected an ArtifactError');
}

test('persists immutable content-addressed test bytes before any execution', async () => {
  const root = await freshRoot();
  try {
    const store = new TestArtifactStore(root);
    const source = 'export const answer = 42;\n';
    const stored = await store.persist(source);
    const digest = sha256Hex(source);

    assert.equal(stored.contentSha256, digest);
    assert.equal(stored.artifactRef, `artifact://tests/${digest}`);
    assert.equal(stored.bytes, Buffer.byteLength(source));

    const path = artifactFilePath(root, digest);
    assert.deepEqual(await readFile(path), Buffer.from(source, 'utf8'));
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(join(root, 'tests'))).mode & 0o777, 0o700);

    const again = await store.persist(source);
    assert.deepEqual(again, stored);
    assert.deepEqual(await store.load(stored.artifactRef), Buffer.from(source, 'utf8'));
  } finally {
    await cleanup(root);
  }
});

test('reloads artifacts after a restart and detects tampered bytes', async () => {
  const root = await freshRoot();
  try {
    const source = 'generated check bytes\n';
    const digest = sha256Hex(source);
    const stored = await new TestArtifactStore(root).persist(source);
    const path = artifactFilePath(root, digest);

    const afterRestart = new TestArtifactStore(root);
    assert.deepEqual(await afterRestart.load(stored.artifactRef), Buffer.from(source, 'utf8'));

    await writeFile(path, 'replaced bytes\n', 'utf8');
    assert.equal(await artifactError(() => new TestArtifactStore(root).load(stored.artifactRef)), 'TAMPERED');
    assert.equal(await artifactError(() => afterRestart.persist(source)), 'TAMPERED');
  } finally {
    await cleanup(root);
  }
});

test('rejects missing, traversal and non-canonical artifact references', async () => {
  const root = await freshRoot();
  try {
    const store = new TestArtifactStore(root);
    assert.equal(await artifactError(() => store.load(`artifact://tests/${'a'.repeat(64)}`)), 'MISSING');

    for (const ref of [
      'artifact://tests/../../etc/passwd',
      `artifact://tests/${'a'.repeat(64)}/extra`,
      `artifact://tests/${'A'.repeat(64)}`,
      'artifact://tests/',
      '/etc/passwd',
      'artifact:',
      `artifact://tests/${'a'.repeat(63)}`,
      `artifact://tests/${'a'.repeat(64)}\0`,
    ]) {
      assert.equal(await artifactError(() => store.load(ref)), 'INVALID_REF', ref);
    }
  } finally {
    await cleanup(root);
  }
});

test('bounds artifact size and rejects symlinked artifact files', async () => {
  const root = await freshRoot();
  try {
    const store = new TestArtifactStore(root);
    await assert.rejects(store.persist('x'.repeat(ARTIFACT_LIMITS.maxArtifactBytes + 1)), (error: unknown) => {
      return error instanceof ArtifactError && error.code === 'TOO_LARGE';
    });

    const source = 'same bytes\n';
    const stored = await store.persist(source);
    const path = artifactFilePath(root, stored.contentSha256);
    const copy = join(root, 'copy.txt');
    await writeFile(copy, source, 'utf8');
    await fs.rm(path);
    await fs.symlink(copy, path);
    assert.equal(await artifactError(() => store.load(stored.artifactRef)), 'NOT_REGULAR');
  } finally {
    await cleanup(root);
  }
});

test('verifies a plan test definition against its content digest', async () => {
  const root = await freshRoot();
  try {
    const store = new TestArtifactStore(root);
    const source = 'definition bytes\n';
    const stored = await store.persist(source);
    const definition: TestDefinition = {
      checkId: 'unit',
      artifactRef: stored.artifactRef,
      contentSha256: stored.contentSha256,
      origin: 'approved',
    };
    assert.deepEqual(await store.verify(definition), Buffer.from(source, 'utf8'));

    const swapped: TestDefinition = { ...definition, contentSha256: sha256Hex('different') };
    assert.equal(await artifactError(() => store.verify(swapped)), 'INVALID_REF');

    const wrongRef: TestDefinition = { ...definition, artifactRef: artifactRefFor(sha256Hex('different')) };
    assert.equal(await artifactError(() => store.verify(wrongRef)), 'INVALID_REF');

    const absent = sha256Hex('never stored');
    const missing: TestDefinition = {
      ...definition,
      artifactRef: artifactRefFor(absent),
      contentSha256: absent,
    };
    assert.equal(await artifactError(() => store.verify(missing)), 'MISSING');
  } finally {
    await cleanup(root);
  }
});

test('requires an absolute private artifact root', () => {
  assert.throws(() => new TestArtifactStore('relative/path'), /absolute/);
  assert.throws(() => new TestArtifactStore(''), /absolute/);
});

test('EvidenceWriter persists caller records and rehashes them after restart', async () => {
  const root = await freshRoot();
  try {
    const writer = new EvidenceWriter(root);
    const record = { checkId: 'unit', revision: 'head', status: 'Verified', exitCode: 0 };
    const stored = await writer.write(record);

    assert.equal(stored.evidenceRef, `evidence://records/${stored.contentSha256}`);
    assert.equal(stored.bytes, Buffer.byteLength(JSON.stringify(record)));

    const path = evidenceFilePath(root, stored.contentSha256);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(join(root, 'records'))).mode & 0o777, 0o700);

    const restarted = new EvidenceWriter(root);
    const loaded = await restarted.read(stored.evidenceRef);
    assert.deepEqual(loaded.record, record);
    assert.equal(loaded.contentSha256, stored.contentSha256);
    assert.deepEqual(Buffer.from(loaded.bytes), Buffer.from(await readFile(path)));
  } finally {
    await cleanup(root);
  }
});

test('EvidenceWriter rejects tampering, non-JSON values and invalid bounds', async () => {
  const root = await freshRoot();
  try {
    const writer = new EvidenceWriter(root);
    const stored = await writer.write({ ok: true });
    await writeFile(evidenceFilePath(root, stored.contentSha256), '{"ok":false}', 'utf8');
    assert.equal(await artifactError(() => writer.read(stored.evidenceRef)), 'TAMPERED');

    assert.equal(await artifactError(() => writer.read(`evidence://records/${'a'.repeat(64)}`)), 'MISSING');

    await assert.rejects(writer.write(undefined), (error: unknown) => {
      return error instanceof ArtifactError && error.code === 'INVALID_SOURCE';
    });
    await assert.rejects(writer.write({ callback: () => 1 }), (error: unknown) => {
      return error instanceof ArtifactError && error.code === 'INVALID_SOURCE';
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(writer.write(cyclic), (error: unknown) => {
      return error instanceof ArtifactError && error.code === 'INVALID_SOURCE';
    });
    await assert.rejects(writer.write({ bad: Number.NaN }), (error: unknown) => {
      return error instanceof ArtifactError && error.code === 'INVALID_SOURCE';
    });

    assert.throws(() => new EvidenceWriter(root, { maxRecordBytes: 0 }), /maxRecordBytes/);
    assert.throws(() => new EvidenceWriter(root, { maxRecordBytes: 5 * 1024 * 1024 }), /maxRecordBytes/);

    const small = new EvidenceWriter(root, { maxRecordBytes: 8 });
    assert.equal(await artifactError(() => small.write({ long: '0123456789' })), 'TOO_LARGE');
  } finally {
    await cleanup(root);
  }
});
