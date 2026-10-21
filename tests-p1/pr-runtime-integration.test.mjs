import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrVerificationRuntime } from '../services/pr-verification/runtime.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const request = { repository: 'example/app', pullRequest: 12, expectedHeadSha: headSha };
const principal = { id: 'agent-a', kind: 'agent', repositories: ['example/app'] };
const changed = { filename: 'server.js', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' };
const metadata = {
  number: 12, state: 'open', draft: false, merged: false, changed_files: 1,
  base: { ref: 'main', sha: baseSha, repo: { id: 1, full_name: 'example/app', private: false } },
  head: { ref: 'candidate', sha: headSha, repo: { id: 1, full_name: 'example/app', private: false } },
};
const profile = {
  profileId: 'node-api', policyVersion: 'v1', repository: 'example/app', policyCommitSha: baseSha,
  imageDigest: `sha256:${'c'.repeat(64)}`, dependencyDigests: [{ name: 'package-lock.json', sha256: 'd'.repeat(64) }],
  requiredChecks: [{ checkId: 'http-invariant', command: 'node test.js', script: 'process.exit(0)', timeoutMs: 1000 }],
  regressionCheck: { checkId: 'independent-regression', command: 'node regression.js', script: 'console.log("regression")', timeoutMs: 1000 },
};

async function serve(t, directory, options = {}) {
  let calls = 0;
  const runtime = createPrVerificationRuntime({
    directory, env: {}, profile,
    authenticate(req) {
      if (req.headers.authorization !== 'Bearer controlled-token') throw Object.assign(new Error('authentication required'), { statusCode: 401 });
      return principal;
    },
    transport: { async request(_method, path) {
      calls++;
      if (path.includes('/compare/')) return { status: 'ahead', base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha }, files: [changed] };
      if (path.includes('/files?')) return [changed];
      return structuredClone(metadata);
    } },
    ...options,
  });
  const server = createServer((req, res) => runtime.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.shutdown(); await new Promise(resolve => server.close(resolve)); });
  return { runtime, base: `http://127.0.0.1:${server.address().port}/api/local/pr-verifications`, calls: () => calls };
}

test('actual HTTP, disk jobs, candidate resolution and trusted planning stop Incomplete without execution', async t => {
  const directory = await mkdtemp('/tmp/opencode/pr-runtime-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { runtime, base } = await serve(t, directory);
  const admitted = await fetch(base, { method: 'POST', headers: {
    authorization: 'Bearer controlled-token', 'content-type': 'application/json', 'idempotency-key': 'runtime-test-12',
  }, body: JSON.stringify(request) });
  assert.equal(admitted.status, 202, await admitted.clone().text());
  const { job } = await admitted.json();
  await runtime.waitForIdle();
  const response = await fetch(`${base}/${job.id}`, { headers: { authorization: 'Bearer controlled-token' } });
  const finished = (await response.json()).job;
  assert.equal(finished.phase, 'Finished');
  assert.equal(finished.verdict, 'Incomplete');
  assert.equal(finished.failure.code, 'EXECUTOR_UNAVAILABLE');
  assert.equal(finished.candidate.headSha, headSha);
  assert.equal(finished.plan.generatedTests.length, 0);
  assert.deepEqual(finished.result.observations, []);
  assert.match(finished.limitations.join(' '), /no execution adapter/);
  assert.ok(finished.plan.requiredChecks.length > 0);
});

test('authentication rejection cannot initialize state or call GitHub', async t => {
  const parent = await mkdtemp('/tmp/opencode/pr-runtime-');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'private-jobs');
  const { base, calls } = await serve(t, directory);
  const rejected = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(rejected.status, 401);
  assert.equal(calls(), 0);
  await assert.rejects(access(directory));
});

test('finished jobs and their exact revision survive a new local runtime', async t => {
  const directory = await mkdtemp('/tmp/opencode/pr-runtime-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await serve(t, directory);
  const start = await fetch(first.base, { method: 'POST', headers: {
    authorization: 'Bearer controlled-token', 'content-type': 'application/json', 'idempotency-key': 'restart-test-12',
  }, body: JSON.stringify(request) });
  const { job } = await start.json();
  await first.runtime.waitForIdle();
  const second = await serve(t, directory);
  const after = await fetch(`${second.base}/${job.id}`, { headers: { authorization: 'Bearer controlled-token' } });
  const persisted = (await after.json()).job;
  assert.equal(persisted.candidate.headSha, headSha);
  assert.equal(persisted.verdict, 'Incomplete');
  assert.equal(second.calls(), 0);
});
