import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrJobCommand } from '../services/pr-verification/client.mjs';

const env = { VERIFIAI_AGENT_TOKEN: 'test-agent-token', VERIFIAI_API_URL: 'http://127.0.0.1:4173' };
const sha = 'a'.repeat(40);

test('agent start sends exact head, scoped bearer and stable idempotency key only', async () => {
  let captured;
  const result = await runPrJobCommand(['start', '--repository', 'example/app', '--pr', '12', '--expected-head', sha, '--idempotency-key', 'job-start-12'], {
    env, fetchImpl: async (url, request) => {
      captured = { url, request };
      return Response.json({ job: { phase: 'Queued' } }, { status: 202 });
    },
  });
  assert.equal(captured.url, 'http://127.0.0.1:4173/api/local/pr-verifications');
  assert.deepEqual(JSON.parse(captured.request.body), { repository: 'example/app', pullRequest: 12, expectedHeadSha: sha });
  assert.equal(captured.request.headers.authorization, 'Bearer test-agent-token');
  assert.equal(captured.request.headers['idempotency-key'], 'job-start-12');
  assert.equal(captured.request.redirect, 'error');
  assert.equal(result.job.phase, 'Queued');
});

test('agent cannot send tokens to remote URLs or follow redirects', async () => {
  let calls = 0;
  for (const url of ['https://example.com', 'http://127.0.0.1@example.com', 'http://127.0.0.1:4173/other', 'http://user:password@localhost', 'http://localhost/#fragment']) {
    await assert.rejects(runPrJobCommand(['capabilities'], { env: { ...env, VERIFIAI_API_URL: url }, fetchImpl: () => { calls++; } }), /loopback HTTP/);
  }
  assert.equal(calls, 0);
});

test('agent routes status, cancel and evidence to the selected owned job', async () => {
  const requests = [];
  for (const command of ['status', 'cancel', 'evidence']) {
    await runPrJobCommand([command, '--job', 'job-12'], {
      env, fetchImpl: async (url, init) => { requests.push([url, init.method]); return Response.json({}); },
    });
  }
  assert.deepEqual(requests, [
    ['http://127.0.0.1:4173/api/local/pr-verifications/job-12', 'GET'],
    ['http://127.0.0.1:4173/api/local/pr-verifications/job-12/cancel', 'POST'],
    ['http://127.0.0.1:4173/api/local/pr-verifications/job-12/evidence', 'GET'],
  ]);
});

test('missing auth, client-authored evidence and repair publication commands are rejected before fetch', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; };
  await assert.rejects(runPrJobCommand(['capabilities'], { env: {}, fetchImpl }), /AGENT_TOKEN/);
  for (const command of ['approve', 'publish', 'merge', 'submit-evidence']) {
    await assert.rejects(runPrJobCommand([command], { env, fetchImpl }), /expected start/);
  }
  await assert.rejects(runPrJobCommand(['status', '--job', '../other'], { env, fetchImpl }), /identifier/);
  assert.equal(calls, 0);
});

test('missing capability is an error rather than manufactured job success', async () => {
  await assert.rejects(runPrJobCommand(['capabilities'], { env, fetchImpl: async () => Response.json({ error: 'missing executor' }, { status: 503 }) }), /HTTP 503/);
  const help = await runPrJobCommand(['--help'], { env: {} });
  assert.match(help.help, /cannot submit execution records/);
});
