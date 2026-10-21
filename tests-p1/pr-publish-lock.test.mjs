// Regression for the per-job publication lock.
//
// A publisher that died while holding the lock must not block the job
// forever, and a lock held by a live publisher must never be taken. The test
// drives the real runtime over real HTTP and lets a second process really
// take the lock, so both cases are exercised end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrVerificationRuntime } from '../services/pr-verification/runtime.mjs';

const storeModuleUrl = new URL('../dist/services/pr-verification/store.js', import.meta.url).href;
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const repository = 'example/app';
const pullRequest = 12;
const changed = { filename: 'server.js', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' };
const metadata = {
  number: pullRequest, state: 'open', draft: false, merged: false, changed_files: 1,
  base: { ref: 'main', sha: baseSha, repo: { id: 1, full_name: repository, private: false } },
  head: { ref: 'candidate', sha: headSha, repo: { id: 1, full_name: repository, private: false } },
};
const profile = {
  profileId: 'node-api', policyVersion: 'v1', repository, policyCommitSha: baseSha,
  imageDigest: `sha256:${'c'.repeat(64)}`, dependencyDigests: [{ name: 'package-lock.json', sha256: 'd'.repeat(64) }],
  requiredChecks: [{ checkId: 'http-invariant', command: 'node test.js', script: 'process.exit(0)', timeoutMs: 1000 }],
  regressionCheck: { checkId: 'independent-regression', command: 'node regression.js', script: 'console.log("regression")', timeoutMs: 1000 },
};
const principal = { id: 'human-operator', kind: 'human', repositories: [repository] };
const authorization = 'Bearer operator-token';

function createTransport(state) {
  const calls = [];
  const checkRuns = [];
  const comments = [];
  let checkRunId = 7100;
  let commentId = 8100;
  return {
    calls,
    checkRuns,
    comments,
    async request(method, path, body) {
      calls.push({ method, path });
      if (state.observe) await state.observe(method, path);
      if (method === 'GET' && path === `/repos/${repository}/pulls/${pullRequest}`) return structuredClone(metadata);
      if (method === 'GET' && path.includes('/compare/')) {
        return { status: 'ahead', base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha }, files: [changed] };
      }
      if (method === 'GET' && path.includes('/check-runs?')) {
        return { total_count: checkRuns.length, check_runs: structuredClone(checkRuns) };
      }
      if (method === 'GET' && path.includes('/comments?')) return structuredClone(comments);
      if (method === 'POST' && path === `/repos/${repository}/check-runs`) {
        const created = { id: ++checkRunId, external_id: body.external_id, head_sha: body.head_sha, name: body.name };
        checkRuns.push(created);
        return structuredClone(created);
      }
      if (method === 'PATCH' && /\/check-runs\/\d+$/.test(path)) {
        const found = checkRuns.find((item) => item.id === Number(path.split('/').pop()));
        if (!found) throw new Error('unknown check run');
        found.external_id = body.external_id;
        return structuredClone(found);
      }
      if (method === 'POST' && path === `/repos/${repository}/issues/${pullRequest}/comments`) {
        const created = { id: ++commentId, body: body.body };
        comments.push(created);
        return structuredClone(created);
      }
      if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(path)) {
        const found = comments.find((item) => item.id === Number(path.split('/').pop()));
        if (!found) throw new Error('unknown comment');
        found.body = body.body;
        return structuredClone(found);
      }
      throw new Error(`unexpected GitHub request: ${method} ${path}`);
    },
  };
}

async function startRuntime(t, directory, transport) {
  const runtime = createPrVerificationRuntime({
    directory,
    env: { VERIFIAI_GITHUB_APP_TOKEN: 'app-token-not-a-real-secret', VERIFIAI_PR_STRICT_BRANCH_PROTECTION_ACK: '1' },
    profile,
    authenticate: async req => {
      if (req.headers.authorization !== authorization) {
        throw Object.assign(new Error('authentication required'), { statusCode: 401 });
      }
      return principal;
    },
    transport,
  });
  const server = createServer((req, res) => {
    runtime.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.shutdown(); await new Promise(resolve => server.close(resolve)); });
  return { runtime, base: `http://127.0.0.1:${server.address().port}/api/local/pr-verifications` };
}

/**
 * Start a second process that really takes the named lock with the real
 * store, then report when it holds it.
 */
async function startLockHolder(t, directory, lockName) {
  const script = join(directory, 'lock-holder.mjs');
  await writeFile(script, [
    `import { PrJobStore } from ${JSON.stringify(storeModuleUrl)};`,
    'const [directory, lockName] = process.argv.slice(2);',
    'const store = new PrJobStore({ directory });',
    'await store.init();',
    'await store.acquireLock(lockName);',
    "process.stdout.write('locked\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const child = spawn(process.execPath, [script, directory, lockName], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the lock holder did not report the lock')), 10_000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return {
    child,
    async kill() {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

test('a publication lock left by a dead publisher does not block the job, and a live one is never taken', async t => {
  const directory = await mkdtemp('/tmp/opencode/pr-publish-lock-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const locks = join(directory, 'locks');
  const state = {};
  const transport = createTransport(state);
  const { runtime, base } = await startRuntime(t, directory, transport);

  const admitted = await fetch(base, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'idempotency-key': 'publish-lock-test-12' },
    body: JSON.stringify({ repository, pullRequest, expectedHeadSha: headSha }),
  });
  assert.equal(admitted.status, 202, await admitted.clone().text());
  const { job } = await admitted.json();
  await runtime.waitForIdle();
  const stored = await (await fetch(`${base}/${job.id}`, { headers: { authorization } })).json();
  assert.equal(stored.job.phase, 'Finished');
  assert.ok(stored.job.result, 'a finished job must carry a publishable result');

  let locksDuringPublish = [];
  state.observe = async () => { locksDuringPublish = await readdir(locks); };
  const first = await fetch(`${base}/${job.id}/publish`, { method: 'POST', headers: { authorization } });
  assert.equal(first.status, 200, await first.clone().text());
  const published = await first.json();
  assert.equal(published.publication.outcome, 'published');
  assert.equal(transport.checkRuns.length, 1);
  assert.equal(transport.comments.length, 1);
  state.observe = null;

  const held = locksDuringPublish.filter(name => name.endsWith('.lock'));
  assert.equal(held.length, 1, `expected one publication lock, saw ${JSON.stringify(locksDuringPublish)}`);
  const lockName = held[0].slice(0, -'.lock'.length);
  assert.equal((await readdir(locks)).includes(held[0]), false, 'a finished publication must release its lock');

  // A publisher that dies while holding the lock leaves the lock file behind.
  const crashed = await startLockHolder(t, directory, lockName);
  await crashed.kill();
  await access(join(locks, held[0]));
  const callsBeforeRetry = transport.calls.length;
  const retry = await fetch(`${base}/${job.id}/publish`, { method: 'POST', headers: { authorization } });
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.ok(transport.calls.length > callsBeforeRetry, 'the retry must reach GitHub');
  assert.equal((await readdir(locks)).includes(held[0]), false, 'the recovered publication must release its lock');

  // A lock held by a live publisher is never taken.
  const live = await startLockHolder(t, directory, lockName);
  const callsBeforeBlocked = transport.calls.length;
  const blocked = await fetch(`${base}/${job.id}/publish`, { method: 'POST', headers: { authorization } });
  assert.equal(blocked.status, 409, await blocked.clone().text());
  assert.equal(transport.calls.length, callsBeforeBlocked, 'a blocked publication must not write to GitHub');
  assert.equal((await readdir(locks)).includes(held[0]), true, 'the live lock must survive the refused publication');
  await live.kill();
});
