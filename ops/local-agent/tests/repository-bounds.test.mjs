// Behavioral bounds for repository admission and materialization (PR80 F5).
// No network: local git fixtures plus a controlled process seam stand in for
// git clone, so every limit is exercised against real filesystem state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as localRepository from '../../../services/local-repository.mjs';
import { registerWorkspace, removeWorkspace, repositoryWorkspaceRoot } from '../../../services/repository-workspaces.mjs';
import { runOwnedProcess } from '../../../services/local-command.mjs';

const { LocalRepositoryService, defaultRepositoryBounds, workspaceUsage } = localRepository;

const repositoryUrl = (slug) => `https://github.com/acme/${slug}`;

function fixtureArgs(args, fixturePath) {
  return args.map((argument) => (argument.startsWith('https://github.com/') ? fixturePath : argument));
}

async function realRunGit(args, { signal, timeoutMs = 119_000, cwd } = {}) {
  const result = await runOwnedProcess('/usr/bin/git', args, { timeoutMs, signal, cwd });
  if (result.status !== 'Completed') throw new Error(result.stderr.trim() || `git ${args[0]} Incomplete (${result.status})`);
  return result;
}

// Process seam: same argv contract as the service's git wrapper, but the
// remote is rewritten to a local fixture so nothing touches the network.
function fixtureRunGit(fixturePath, counter = { spawns: 0 }) {
  counter.runGit = (args, options) => {
    if (args[0] === 'clone') counter.spawns += 1;
    return realRunGit(fixtureArgs(args, fixturePath), options);
  };
  return counter;
}

// Process seam: simulates a slow materialization. It writes files into the
// workspace the service registered and only ever settles when the service
// aborts the clone signal, mirroring how the owned git process is killed.
function slowMaterializationRunGit({ chunkBytes, chunkCount, gapMs }, state = { spawns: 0, aborted: false }) {
  state.runGit = (args, { signal } = {}) => new Promise((resolve, reject) => {
    state.spawns += 1;
    state.workspace = args.at(-1);
    let index = 0;
    let timer;
    const settle = (fn, value) => {
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      state.aborted = true;
      settle(reject, new Error('git clone aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setInterval(() => {
      const file = join(state.workspace, `chunk-${index}.bin`);
      writeFile(file, Buffer.alloc(chunkBytes, 0x61))
        .then(() => {
          index += 1;
          if (index >= chunkCount) settle(resolve, { status: 'Completed', stdout: '' });
        })
        .catch((error) => settle(reject, error));
    }, gapMs);
  });
  return state;
}

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'verifai-fixture-'));
  await realRunGit(['init', '--quiet', directory]);
  await writeFile(join(directory, 'README.md'), '# fixture repository\n');
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src', 'app.js'), 'export const answer = 42;\n');
  await realRunGit(['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'add', '-A'], { cwd: directory });
  await realRunGit(['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '--quiet', '-m', 'fixture'], { cwd: directory });
  return directory;
}

async function registryCount() {
  const names = await readdir(repositoryWorkspaceRoot).catch(() => []);
  return names.filter((name) => name.startsWith('.owner-')).length;
}

async function waitUntil(condition, label, timeoutMs = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function expectMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT', `${path} must not exist`);
}

test('clone bounds options must be positive integers', () => {
  assert.equal(defaultRepositoryBounds.workspaceBytes, 100 * 1024 * 1024);
  assert.equal(defaultRepositoryBounds.workspaceEntries, 20_000);
  assert.ok(Number.isInteger(defaultRepositoryBounds.retainedWorkspaces) && defaultRepositoryBounds.retainedWorkspaces >= 1);
  assert.doesNotThrow(() => new LocalRepositoryService());
  for (const option of ['maxWorkspaceBytes', 'maxWorkspaceEntries', 'maxRetainedWorkspaces', 'workspaceCheckIntervalMs']) {
    for (const value of [0, -1, 1.5, Infinity, NaN, '10']) {
      assert.throws(() => new LocalRepositoryService({ [option]: value }), new RegExp(option), `${option}=${value} must be rejected`);
    }
  }
});

test('bounded accounting counts files and stops at both ceilings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verifai-usage-'));
  try {
    await writeFile(join(directory, 'a.txt'), 'aaaa');
    await writeFile(join(directory, 'b.txt'), 'bbbbbb');
    await mkdir(join(directory, 'sub'));
    await writeFile(join(directory, 'sub', 'c.txt'), 'c');

    const within = await workspaceUsage(directory, { maxBytes: 1_000_000, maxEntries: 10 });
    assert.equal(within.overrun, null);
    assert.equal(within.entries, 4, 'a.txt, b.txt, sub, sub/c.txt');
    assert.equal(within.bytes, 11);

    const tooManyEntries = await workspaceUsage(directory, { maxBytes: 1_000_000, maxEntries: 3 });
    assert.equal(tooManyEntries.overrun, 'entries');

    const tooManyBytes = await workspaceUsage(directory, { maxBytes: 10, maxEntries: 10 });
    assert.equal(tooManyBytes.overrun, 'bytes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded accounting never follows symlinks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'verifai-usage-symlink-'));
  try {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'big.bin'), Buffer.alloc(1024 * 1024));
    const outsideDirectory = join(outside, 'many');
    await mkdir(outsideDirectory);
    for (let index = 0; index < 40; index += 1) await writeFile(join(outsideDirectory, `file-${index}.txt`), 'x');
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'small.txt'), 'hello world');
    await symlink(join(outside, 'big.bin'), join(workspace, 'big.bin'));
    await symlink(outsideDirectory, join(workspace, 'many'));

    const usage = await workspaceUsage(workspace, { maxBytes: 256 * 1024, maxEntries: 20 });
    assert.equal(usage.overrun, null, 'an outside 1 MiB target and 40 outside files must not count');
    assert.equal(usage.entries, 3, 'small.txt plus two symlink entries');
    assert.equal(usage.bytes, 11, 'only the regular file inside the workspace is counted');

    const strict = await workspaceUsage(workspace, { maxBytes: 5, maxEntries: 20 });
    assert.equal(strict.overrun, 'bytes', 'the real inside file still participates in byte accounting');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a second clone while one is materializing is rejected before a second process spawn', async () => {
  const state = slowMaterializationRunGit({ chunkBytes: 1, chunkCount: 1_000_000, gapMs: 1_000 });
  const service = new LocalRepositoryService({ runGit: state.runGit, workspaceCheckIntervalMs: 50 });
  const before = await registryCount();
  const first = service.clone(repositoryUrl('alpha'));
  await waitUntil(() => state.spawns === 1, 'first clone to spawn');
  // Attach the rejection expectation before cleanupAll aborts the clone.
  const firstRejected = assert.rejects(first, /aborted/);
  try {
    await assert.rejects(service.clone(repositoryUrl('beta')), /already in progress/);
    assert.equal(state.spawns, 1, 'the rejected call must not spawn a second materialization');
    assert.equal(await registryCount(), before + 1, 'the rejected call must not register a second workspace');
  } finally {
    await service.cleanupAll();
  }
  await firstRejected;
  assert.equal(await registryCount(), before, 'the aborted clone must clean its own workspace');
});

test('the retained workspace cap rejects a clone before any spawn or registration', async () => {
  const fixture = await makeFixture();
  const counter = fixtureRunGit(fixture);
  const service = new LocalRepositoryService({ maxRetainedWorkspaces: 1, runGit: counter.runGit });
  const before = await registryCount();
  try {
    const first = await service.clone(repositoryUrl('alpha'));
    assert.equal(counter.spawns, 1);
    assert.equal(first.clone.success, true);

    await assert.rejects(service.clone(repositoryUrl('beta')), /workspace limit reached/);
    assert.equal(counter.spawns, 1, 'the capped clone must be rejected before spawning');
    assert.equal(await registryCount(), before + 1, 'the capped clone must not register a workspace');

    await service.cleanup(first.id);
    const second = await service.clone(repositoryUrl('beta'));
    assert.equal(second.clone.success, true, 'cleanup must free a retained slot');
    await service.cleanup(second.id);
  } finally {
    await service.cleanupAll();
    await rm(fixture, { recursive: true, force: true });
  }
  assert.equal(await registryCount(), before);
});

for (const mode of [
  { label: 'byte', options: { chunkBytes: 64 * 1024, chunkCount: 50, gapMs: 10 }, limits: { maxWorkspaceBytes: 150 * 1024, workspaceCheckIntervalMs: 5 }, reason: /limit of 153600 bytes/ },
  { label: 'entry', options: { chunkBytes: 16, chunkCount: 500, gapMs: 2 }, limits: { maxWorkspaceEntries: 20, workspaceCheckIntervalMs: 5 }, reason: /limit of 20 entries/ },
]) {
  test(`a workspace ${mode.label} overrun aborts the running materialization and cleans up`, async () => {
    const state = slowMaterializationRunGit(mode.options);
    const service = new LocalRepositoryService({ ...mode.limits, runGit: state.runGit });
    const before = await registryCount();
    await assert.rejects(service.clone(repositoryUrl(`overrun-${mode.label}`)), mode.reason);
    assert.equal(state.aborted, true, 'the materialization must be aborted while still in flight, not after it finishes');
    assert.equal(await registryCount(), before, 'the overrun workspace and registry entry must be removed');
    await expectMissing(state.workspace);
  });
}

test('a clone that finishes over the ceiling between checks is still rejected and cleaned up', async () => {
  const fixture = await makeFixture();
  const state = fixtureRunGit(fixture);
  const oversized = async (args, options) => {
    const result = await state.runGit(args, options);
    if (args[0] === 'clone') {
      state.workspace = args.at(-1);
      await writeFile(join(args.at(-1), 'oversized.bin'), Buffer.alloc(512 * 1024));
    }
    return result;
  };
  // A long interval guarantees the settled-workspace recheck, not the poller,
  // is what rejects this clone.
  const service = new LocalRepositoryService({ maxWorkspaceBytes: 128 * 1024, workspaceCheckIntervalMs: 60_000, runGit: oversized });
  const before = await registryCount();
  try {
    await assert.rejects(service.clone(repositoryUrl('oversized')), /limit of 131072 bytes/);
    await assert.rejects(
      service.clone(repositoryUrl('oversized'), { maxWorkspaceBytes: Number.MAX_SAFE_INTEGER }),
      /limit of 131072 bytes/,
      'per-call options must not relax the operator-configured ceiling',
    );
    assert.equal(state.spawns, 2);
    assert.equal(await registryCount(), before, 'the over-ceiling workspace must be removed, never retained');
    await expectMissing(state.workspace);
  } finally {
    await service.cleanupAll();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('a tiny clone within every bound is accepted and retained', async () => {
  const fixture = await makeFixture();
  const counter = fixtureRunGit(fixture);
  const service = new LocalRepositoryService({ runGit: counter.runGit });
  const before = await registryCount();
  let record;
  try {
    record = await service.clone(repositoryUrl('tiny'));
    assert.equal(record.clone.success, true);
    assert.match(record.repository.commit, /^[0-9a-f]{40}$/);
    assert.equal(record.files.count, 2);
    assert.ok(record.files.items.includes('README.md'));
    assert.equal(record.info.hasReadme, true);
    await access(record.clone.workspacePath);
    assert.equal(await registryCount(), before + 1);
    assert.equal(await service.get(record.id), record);
  } finally {
    if (record) await service.cleanup(record.id);
    else await service.cleanupAll();
    await rm(fixture, { recursive: true, force: true });
  }
  assert.equal(await registryCount(), before);
  await expectMissing(record.clone.workspacePath);
});

test('failed clones and cleanup touch only the task-owned workspace', async () => {
  const fixture = await makeFixture();
  const state = fixtureRunGit(fixture);
  const failingUrl = `${repositoryUrl('fails')}.git`;
  const selective = (args, options) => {
    if (args.includes(failingUrl)) throw new Error('simulated clone failure');
    return state.runGit(args, options);
  };
  const service = new LocalRepositoryService({ runGit: selective });
  const unrelated = await registerWorkspace(randomUUID());
  const sentinelDirectory = await mkdtemp(join(tmpdir(), 'verifai-sentinel-'));
  const sentinelFile = join(sentinelDirectory, 'keep.txt');
  await writeFile(sentinelFile, 'keep me');
  const before = await registryCount();
  try {
    await assert.rejects(service.clone(repositoryUrl('fails')), /simulated clone failure/);
    assert.equal(await registryCount(), before, 'the failed clone cleaned only its own registry entry');

    const owned = await service.clone(repositoryUrl('owned'));
    await service.cleanup(owned.id);
    assert.equal(await registryCount(), before, 'cleanup removes the owned workspace and registry entry');
    await service.cleanupAll();

    await access(unrelated.workspacePath);
    await access(sentinelFile);
  } finally {
    await removeWorkspace(unrelated.workspacePath, unrelated.registry);
    await rm(sentinelDirectory, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});
