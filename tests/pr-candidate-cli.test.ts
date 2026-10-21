import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import type { CandidateRevision } from '../packages/contracts/src/index.js';
import {
  formatInspectionResult,
  parseInspectArguments,
} from '../services/pr-verification/cli.js';

const repositoryRoot = new URL('../..', import.meta.url);
const cliEntry = decodeURIComponent(new URL('scripts/verifai-pr.mjs', repositoryRoot).pathname);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 10_000);
    child.on('close', (status: number | null) => {
      clearTimeout(timer);
      resolveResult({ status, stdout, stderr });
    });
  });
}

test('CLI help exits zero and documents the inspect contract', async () => {
  const result = await runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /inspect --repository owner\/repo --pr 123 --expected-head <sha>/);
  assert.match(result.stdout, /15 second timeout/);
  assert.equal(result.stderr, '');
});

test('CLI reports a missing required option before any request', async () => {
  const result = await runCli(['inspect', '--repository', 'acme/shop', '--pr', '7']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing required option: --expected-head/);
  assert.equal(result.stdout, '');
});

test('CLI rejects a duplicated option before any request', async () => {
  const result = await runCli([
    'inspect',
    '--repository',
    'acme/shop',
    '--pr',
    '7',
    '--pr',
    '8',
    '--expected-head',
    'a'.repeat(40),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate option: --pr/);
  assert.equal(result.stdout, '');
});

test('CLI rejects an unknown option and a non-positive PR number', async () => {
  const unknown = await runCli([
    'inspect',
    '--repository',
    'acme/shop',
    '--pr',
    '7',
    '--expected-head',
    'a'.repeat(40),
    '--watch',
  ]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option: --watch/);

  const zero = await runCli(['inspect', '--repository', 'acme/shop', '--pr', '0', '--expected-head', 'a'.repeat(40)]);
  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /--pr must be a positive integer/);
});

test('parseInspectArguments accepts inline and separate option values', () => {
  const request = parseInspectArguments([
    'inspect',
    '--repository=acme/shop',
    '--pr',
    '7',
    '--expected-head',
    'a'.repeat(40),
  ]);

  assert.deepEqual(request, {
    repository: 'acme/shop',
    pullRequest: 7,
    expectedHeadSha: 'a'.repeat(40),
  });
});

test('parseInspectArguments fails closed on missing, duplicate and unknown options', () => {
  assert.throws(() => parseInspectArguments([]), /missing command: inspect/);
  assert.throws(() => parseInspectArguments(['verify']), /unknown command: verify/);
  assert.throws(
    () => parseInspectArguments(['inspect', '--repository', 'acme/shop', '--pr', '7']),
    /missing required option: --expected-head/,
  );
  assert.throws(
    () => parseInspectArguments(['inspect', '--repository', 'acme/shop', '--pr', '7', '--pr', '8', '--expected-head', 'a'.repeat(40)]),
    /duplicate option: --pr/,
  );
  assert.throws(
    () => parseInspectArguments(['inspect', '--repository', 'acme/shop', '--pr', '7', '--expected-head', 'a'.repeat(40), '--unknown']),
    /unknown option: --unknown/,
  );
});

test('formatInspectionResult always reports pending execution with no verdict', () => {
  const candidate: CandidateRevision = {
    repository: 'acme/shop',
    pullRequest: 7,
    headRepository: 'acme/shop',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    mergeBaseSha: 'd'.repeat(40),
    changedFiles: ['src/app.ts'],
    diffDigest: 'e'.repeat(64),
  };

  const output = formatInspectionResult(candidate);

  assert.deepEqual(output, {
    candidate,
    execution: {
      state: 'pending',
      runtimeChecksExecuted: false,
      detail: 'Candidate identity resolved only. No runtime verification was executed and no verdict is asserted.',
    },
    verdict: null,
  });
});
