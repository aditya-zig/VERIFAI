import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPrVerificationHttpHandler } from '../services/pr-verification/http.mjs';

const principal = { id: 'local-agent', kind: 'agent', repositories: ['example/app'] };
const input = { repository: 'example/app', pullRequest: 12, expectedHeadSha: 'a'.repeat(40) };

async function fixture(t, options = {}) {
  const calls = [];
  const job = { id: 'job-12', ownerId: principal.id, request: input, phase: 'Queued', cancelRequested: false };
  const controller = {
    async start(...args) { calls.push(['start', ...args]); return structuredClone(job); },
    async get(...args) { calls.push(['get', ...args]); return structuredClone(job); },
    async cancel(...args) { calls.push(['cancel', ...args]); job.cancelRequested = true; },
  };
  const handle = createPrVerificationHttpHandler({ controller, authenticate: () => principal, ...options });
  const server = createServer((req, res) => {
    handle(req, res).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(error => { res.writeHead(500); res.end(error.message); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/local/pr-verifications`;
  const start = (body = input, headers = {}) => fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'start-job-12', ...headers },
    body: JSON.stringify(body),
  });
  return { base, calls, job, start };
}

test('PR job start passes only validated input and server-owned principal', async t => {
  const { start, calls } = await fixture(t);
  const response = await start();
  assert.equal(response.status, 202);
  assert.equal((await response.json()).job.phase, 'Queued');
  assert.deepEqual(calls, [['start', input, principal, 'start-job-12']]);
});

test('client cannot author principals, execution evidence or verdicts', async t => {
  const { start, calls } = await fixture(t);
  for (const extra of [{ principal: { kind: 'human' } }, { verdict: 'Verified' }, { observations: [] }, { result: {} }]) {
    assert.equal((await start({ ...input, ...extra })).status, 400);
  }
  assert.deepEqual(calls, []);
});

test('missing authentication stops before job admission', async t => {
  const { start, calls } = await fixture(t, {
    authenticate() { throw Object.assign(new Error('authentication required'), { statusCode: 401 }); },
  });
  assert.equal((await start()).status, 401);
  assert.deepEqual(calls, []);
});

test('JSON, identity and idempotency requirements are checked before admission', async t => {
  const { start, calls } = await fixture(t);
  assert.equal((await start(input, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await start(input, { 'idempotency-key': '' })).status, 400);
  assert.equal((await start({ ...input, expectedHeadSha: 'mutable-branch' })).status, 400);
  assert.equal((await start({ ...input, pullRequest: -1 })).status, 400);
  assert.equal((await start({ ...input, repository: '../app' })).status, 400);
  assert.deepEqual(calls, []);
});

test('status, evidence and cancel always use authenticated ownership checks', async t => {
  const { base, calls } = await fixture(t);
  const status = await fetch(`${base}/job-12`);
  assert.equal(status.status, 200);
  const evidence = await fetch(`${base}/job-12/evidence`);
  assert.equal(evidence.status, 200);
  assert.deepEqual(await evidence.json(), { status: 'Pending' });
  const cancel = await fetch(`${base}/job-12/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 202);
  assert.equal((await cancel.json()).job.cancelRequested, true);
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ['get', 'job-12', principal], ['get', 'job-12', principal],
    ['cancel', 'job-12', principal], ['get', 'job-12', principal],
  ]);
});

test('malformed identifiers and unexpected methods return errors without stopping HTTP', async t => {
  const { base, calls } = await fixture(t);
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
  assert.equal((await fetch(`${base}/job-12`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/job-12`)).status, 200);
  assert.equal(calls.length, 1);
});

test('unconfigured execution is disclosed and missing controller cannot admit a job', async t => {
  const { base, start, calls } = await fixture(t, { controller: undefined });
  const capabilities = await fetch(`${base}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).executionConfigured, false);
  assert.equal((await start()).status, 503);
  assert.deepEqual(calls, []);
});

test('finished jobs without a plan disclose unavailable evidence rather than permanent Pending', async t => {
  const { base, job } = await fixture(t);
  job.phase = 'Finished';
  job.verdict = 'Incomplete';
  job.limitations = ['no approved profile configured'];
  const response = await fetch(`${base}/job-12/evidence`);
  assert.deepEqual(await response.json(), { status: 'Unavailable', verdict: 'Incomplete', limitations: ['no approved profile configured'] });
});

test('internal controller errors do not expose secrets or crash the server', async t => {
  const { start, base } = await fixture(t, { controller: {
    async start() { throw new Error('private-credential-value'); },
    async get() { return { id: 'job-12' }; },
  } });
  const failed = await start();
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /private-credential-value/);
  assert.equal((await fetch(`${base}/job-12`)).status, 200);
});

test('check publication uses only a stored terminal result and an explicit authenticated human', async t => {
  const published = [];
  const human = { ...principal, id: 'operator', kind: 'human' };
  const { base, job } = await fixture(t, { authenticate: () => human, publish: async (...args) => { published.push(args); return { outcome: 'published' }; } });
  job.phase = 'Finished'; job.result = { verdict: 'Incomplete', observations: [] };
  const injected = await fetch(`${base}/job-12/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: { verdict: 'Verified' } }) });
  assert.equal(injected.status, 400);
  assert.equal(published.length, 0);
  const response = await fetch(`${base}/job-12/publish`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(published[0][0].result.verdict, 'Incomplete');
  assert.deepEqual(published[0][1], human);
});

test('agent principals cannot request GitHub writes through the verification API', async t => {
  let writes = 0;
  const { base } = await fixture(t, { publish: async () => { writes++; } });
  assert.equal((await fetch(`${base}/job-12/publish`, { method: 'POST' })).status, 403);
  assert.equal(writes, 0);
});
