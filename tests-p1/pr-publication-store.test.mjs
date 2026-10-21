import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { FilePrChecksPublicationStore } from '../services/pr-verification/publication-store.mjs';

const record = { key: 'example/app:12:head', repository: 'example/app', pullRequest: 12,
  headSha: 'a'.repeat(40), checkRunId: 123, commentId: 456,
  externalId: 'verifai-runtime:12', principal: 'operator', updatedAt: new Date(0).toISOString() };

test('publication records survive restart with private modes and immutable returned snapshots', async t => {
  const root = await mkdtemp('/tmp/opencode/pr-publication-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new FilePrChecksPublicationStore(join(root, 'records'));
  await first.save(record);
  const loaded = await new FilePrChecksPublicationStore(first.directory).get(record.key);
  assert.deepEqual(loaded, record);
  loaded.commentId = 999;
  assert.equal((await first.get(record.key)).commentId, 456);
  assert.equal((await stat(first.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(first.path(record.key))).mode & 0o777, 0o600);
  assert.equal(await first.get('unpublished-key'), undefined);
});

test('corrupt, mismatched and symlink records are refused without replacing unrelated files', async t => {
  const root = await mkdtemp('/tmp/opencode/pr-publication-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FilePrChecksPublicationStore(join(root, 'records'));
  await store.init();
  const target = store.path(record.key);
  await writeFile(target, '{broken', { mode: 0o600 });
  await assert.rejects(store.get(record.key));
  await writeFile(target, JSON.stringify({ ...record, key: 'another-job' }));
  await assert.rejects(store.get(record.key), /invalid PR publication/);
  await rm(target);
  const outside = join(root, 'outside.json');
  await writeFile(outside, JSON.stringify(record), { mode: 0o600 });
  await symlink(outside, target);
  await assert.rejects(store.get(record.key));
  assert.equal((await stat(outside)).isFile(), true);
});
