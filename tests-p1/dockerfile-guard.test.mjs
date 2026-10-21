import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArbitraryRepoBuildspec } from '../dist/services/bootstrap/aws-target-lifecycle.js';

test('generated build guard checks actual tracked files and rejects symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verifai-build-path-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init', '--quiet');
    await mkdir(join(directory, 'docker'));
    await writeFile(join(directory, 'docker', 'Dockerfile'), 'FROM scratch\n');
    await writeFile(join(directory, 'untracked'), 'FROM scratch\n');
    await symlink('docker/Dockerfile', join(directory, 'linked'));
    await symlink('docker', join(directory, 'linked-directory'));
    git('add', '--', 'docker/Dockerfile', 'linked', 'linked-directory');

    const runGuard = dockerfile => {
      const buildspec = buildArbitraryRepoBuildspec({
        repoUrl: 'https://github.com/example/app', branch: 'main',
        commitSha: 'a'.repeat(40), imageTag: 'audit', dockerfile,
      }, { region: 'us-west-2', ecrRegistry: 'example.registry', ecrRepository: 'targets' });
      // Decode the intentionally JSON-quoted YAML scalar, then execute its shell contract.
      const scalars = buildspec.split('\n').filter(line => line.startsWith('      - "'));
      assert.equal(scalars.length, 1);
      const command = JSON.parse(scalars[0].slice('      - '.length));
      return spawnSync('sh', ['-c', command], { cwd: directory, encoding: 'utf8' });
    };
    assert.equal(runGuard('docker/Dockerfile').status, 0);
    for (const path of ['missing', 'untracked', 'linked', 'linked-directory/Dockerfile', 'docker']) {
      const result = runGuard(path);
      assert.equal(result.status, 42, `${path}: ${result.stderr}`);
      assert.match(result.stderr, /VERIFIAI_UNSUPPORTED/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
