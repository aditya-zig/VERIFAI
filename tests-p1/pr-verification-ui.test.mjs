// Behaviour tests for the pull request verification screen.
//
// The HTTP responses here are controlled fixtures for the UI tests only. They
// are not product defaults and the page ships no fixture data: the screen
// renders only what the controller returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openApp, waitFor, jsonResponse } from './audit-app-harness.mjs';

const TOKEN = 'controlled-test-token-value';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

const CONTROLLED_JOB_QUEUED = {
  id: 'prjob-controlled-0001',
  phase: 'Queued',
};

const CONTROLLED_JOB_EXECUTING = {
  id: 'prjob-controlled-0001',
  phase: 'Executing',
};

const CONTROLLED_JOB_FINISHED = {
  id: 'prjob-controlled-0001',
  phase: 'Finished',
  verdict: 'Incomplete',
  result: {
    status: 'notVerified',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    checks: ['lint', 'unit'],
    cleanup: { workspaceRemoved: true, containerRemoved: true },
  },
  limitations: ['the execution runtime is not configured'],
};

const CONTROLLED_CAPABILITIES = {
  executionConfigured: false,
  publicationConfigured: false,
  liveAwsAccepted: false,
};

function fillForm(doc, { repository = 'octocat/Hello-World', pullRequest = '7', head = HEAD_SHA, token = TOKEN } = {}) {
  doc.getElementById('prRepository').value = repository;
  doc.getElementById('prPullRequest').value = pullRequest;
  doc.getElementById('prHeadSha').value = head;
  doc.getElementById('prToken').value = token;
}

function openPrScreen(fetchImpl) {
  const app = openApp({ fetchImpl });
  app.doc.dispatch('click', { target: app.doc.findByAttribute('data-nav', 'pr-verification'), preventDefault() {} });
  return app;
}

test('the screen offers the one job above the fold and starts with an empty result area', () => {
  const { doc } = openPrScreen(async () => jsonResponse({}));
  const markup = doc.app.innerHTML;
  assert.match(markup, /Pull request verification/);
  assert.match(markup, /id="prRepository"/);
  assert.match(markup, /id="prPullRequest"/);
  assert.match(markup, /id="prHeadSha"/);
  assert.match(markup, /id="prToken"/);
  assert.equal((markup.match(/type="submit"/g) || []).length, 1, 'one action on the screen');
  assert.match(markup, /id="startPrVerification"/);
  assert.match(markup, /No verification job yet/);
  assert.doesNotMatch(markup, /data-action="create-(local-pr|deep-pr|merge)/, 'no pull request or merge control here');
  assert.doesNotMatch(markup, /<button[^>]*>(Create PR|Merge)/i, 'no pull request or merge button here');
});

test('a malformed form is refused before any request goes out', () => {
  const { doc, calls } = openPrScreen(async () => jsonResponse({}));
  fillForm(doc, { repository: 'not-a-repo', pullRequest: '0', head: 'abc' });
  doc.getElementById('prVerificationForm').requestSubmit();

  const rendered = doc.getElementById('prVerificationResult').innerHTML;
  assert.equal(calls.length, 0, 'nothing is sent while the form is wrong');
  assert.match(rendered, /The form needs a fix/);
  assert.match(rendered, /owner\/repository/);
  assert.match(rendered, /positive whole number/);
  assert.match(rendered, /40 hexadecimal characters/);
  assert.equal(doc.focused && doc.focused.id, 'prRepository', 'focus moves to the first field that needs a fix');
  assert.equal(doc.getElementById('startPrVerification').disabled, false);
});

test('a started job posts the payload, the bearer token and an idempotency key', async () => {
  const { doc, calls } = openPrScreen(async (url, options) => (options.method === 'POST'
    ? jsonResponse({ job: CONTROLLED_JOB_QUEUED }, { status: 202 })
    : jsonResponse({ job: CONTROLLED_JOB_FINISHED })));

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('prjob-controlled-0001')));

  const post = calls.find(call => call.url === '/api/local/pr-verifications');
  assert.equal(post.method, 'POST');
  assert.deepEqual(JSON.parse(post.body), { repository: 'octocat/Hello-World', pullRequest: 7, expectedHeadSha: HEAD_SHA });
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
  const key = post.headers['idempotency-key'];
  assert.ok(key && key.length >= 8 && key.length <= 128, 'the idempotency key is 8 to 128 characters');
  assert.match(key, /^[A-Za-z0-9._-]+$/, 'the idempotency key holds safe characters only');
});

test('the token stays in memory and never reaches storage, the URL or the page', async () => {
  const { doc, calls, location, storage } = openPrScreen(async (url, options) => (options.method === 'POST'
    ? jsonResponse({ job: CONTROLLED_JOB_QUEUED }, { status: 202 })
    : jsonResponse({ job: CONTROLLED_JOB_FINISHED })));

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('prjob-controlled-0001')));

  assert.deepEqual(storage.touched, [], 'no storage was read or written');
  assert.ok(!location.hash.includes(TOKEN), 'the token is not in the route');
  for (const call of calls) {
    assert.ok(!call.url.includes(TOKEN), 'the token is not in a request URL');
    assert.ok(!String(call.body || '').includes(TOKEN), 'the token is not in a request body');
  }
  assert.ok(!doc.getElementById('prVerificationResult').innerHTML.includes(TOKEN), 'the token is not rendered');
  assert.ok(!doc.app.innerHTML.includes(TOKEN), 'the token is not in the page');
});

test('the job polls while it is active and stops once it is finished', async () => {
  let polls = 0;
  const { doc, calls } = openPrScreen(async (url, options) => {
    if (options.method === 'POST') return jsonResponse({ job: CONTROLLED_JOB_QUEUED }, { status: 202 });
    polls += 1;
    return jsonResponse({ job: polls === 1 ? CONTROLLED_JOB_EXECUTING : CONTROLLED_JOB_FINISHED });
  });

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => calls.some(call => call.url === '/api/local/pr-verifications/prjob-controlled-0001' && call.method === 'GET'), { timeoutMs: 6000 }));
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('Finished'), { timeoutMs: 6000 }));

  const pollsAtFinish = polls;
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(polls, pollsAtFinish, 'a finished job is not polled again');
  const get = calls.find(call => call.url.endsWith('/prjob-controlled-0001') && call.method === 'GET');
  assert.equal(get.headers.authorization, `Bearer ${TOKEN}`);
});

test('leaving the screen stops the polling', async () => {
  const { doc, calls, context } = openPrScreen(async (url, options) => (options.method === 'POST'
    ? jsonResponse({ job: CONTROLLED_JOB_QUEUED }, { status: 202 })
    : jsonResponse({ job: CONTROLLED_JOB_EXECUTING })));

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => calls.some(call => call.method === 'GET'), { timeoutMs: 6000 }));

  context.VERIFAI.navigate('landing');
  const pollsAfterExit = calls.filter(call => call.method === 'GET').length;
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(calls.filter(call => call.method === 'GET').length, pollsAfterExit, 'the poll stops when the route is left');
});

test('cancelling a job is its own action and stops the polling', async () => {
  const { doc, calls } = openPrScreen(async (url, options) => {
    if (options.method === 'POST' && url.endsWith('/cancel')) return jsonResponse({ job: { ...CONTROLLED_JOB_EXECUTING, phase: 'Cleaning' } }, { status: 202 });
    if (options.method === 'POST') return jsonResponse({ job: CONTROLLED_JOB_QUEUED }, { status: 202 });
    return jsonResponse({ job: CONTROLLED_JOB_EXECUTING });
  });

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => calls.some(call => call.method === 'GET'), { timeoutMs: 6000 }));

  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'cancel-pr-job'), preventDefault() {} });
  assert.ok(await waitFor(() => calls.some(call => call.url.endsWith('/prjob-controlled-0001/cancel'))));

  const cancel = calls.find(call => call.url.endsWith('/cancel'));
  assert.equal(cancel.method, 'POST');
  assert.equal(cancel.body, undefined, 'the cancel request carries no body');
  assert.equal(cancel.headers.authorization, `Bearer ${TOKEN}`);

  const pollsAfterCancel = calls.filter(call => call.method === 'GET').length;
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(calls.filter(call => call.method === 'GET').length, pollsAfterCancel, 'the poll stops after the cancel');
});

test('a finished job shows only the facts the controller recorded', async () => {
  const { doc } = openPrScreen(async (url, options) => (options.method === 'POST'
    ? jsonResponse({ job: CONTROLLED_JOB_FINISHED }, { status: 202 })
    : jsonResponse({ job: CONTROLLED_JOB_FINISHED })));

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('Finished')));

  const rendered = doc.getElementById('prVerificationResult').innerHTML;
  assert.match(rendered, /prjob-controlled-0001/);
  assert.match(rendered, /Incomplete/);
  assert.match(rendered, /notVerified/);
  assert.match(rendered, new RegExp(BASE_SHA));
  assert.match(rendered, new RegExp(HEAD_SHA));
  assert.match(rendered, /lint/);
  assert.match(rendered, /workspaceRemoved/);
  assert.match(rendered, /the execution runtime is not configured/);
  assert.doesNotMatch(rendered, /Create PR|Merge|pull request created/i, 'no pull request action on this screen');
});

test('the runtime card reports the controller capabilities as they came', async () => {
  const { doc, calls } = openPrScreen(async (url, options) => {
    if (url.endsWith('/capabilities')) return jsonResponse(CONTROLLED_CAPABILITIES);
    if (options.method === 'POST') return jsonResponse({ job: CONTROLLED_JOB_QUEUED }, { status: 202 });
    return jsonResponse({ job: CONTROLLED_JOB_QUEUED });
  });

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => calls.some(call => call.url.endsWith('/capabilities'))));
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('execution configured')));

  const rendered = doc.getElementById('prVerificationResult').innerHTML;
  assert.match(rendered, /execution configured/);
  assert.match(rendered, /publication configured/);
  assert.match(rendered, /live AWS accepted/);
  const capabilities = calls.find(call => call.url.endsWith('/capabilities'));
  assert.equal(capabilities.headers.authorization, `Bearer ${TOKEN}`);
});

test('a refused start explains the status, keeps the input and gives the focus back', async () => {
  for (const [status, expected] of [[401, /rejected the token \(401\)/], [403, /refused this request \(403\)/], [429, /busy \(429\)/], [503, /unavailable \(503\)/]]) {
    const { doc } = openPrScreen(async () => jsonResponse({ error: 'controlled refusal' }, { ok: false, status }));
    fillForm(doc);
    doc.getElementById('prVerificationForm').requestSubmit();
    assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('The verification did not start')));

    const rendered = doc.getElementById('prVerificationResult').innerHTML;
    assert.match(rendered, expected);
    assert.match(rendered, /controlled refusal/);
    assert.equal(doc.getElementById('prRepository').value, 'octocat/Hello-World', 'the input is kept');
    assert.equal(doc.getElementById('prPullRequest').value, '7');
    assert.equal(doc.getElementById('prHeadSha').value, HEAD_SHA);
    assert.equal(doc.getElementById('startPrVerification').disabled, false, 'the button is restored');
    assert.equal(doc.getElementById('startPrVerification').textContent.trim(), 'Verify pull request');
    assert.equal(doc.focused && doc.focused.id, 'prVerificationError', 'the focus lands on the error');
  }
});

test('a network error is named and the form stays ready for another attempt', async () => {
  const { doc } = openPrScreen(async () => { throw new Error('controlled network failure'); });
  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('did not reach the server')));

  const rendered = doc.getElementById('prVerificationResult').innerHTML;
  assert.match(rendered, /controlled network failure/);
  assert.equal(doc.getElementById('startPrVerification').disabled, false);
  assert.equal(doc.focused && doc.focused.id, 'prVerificationError');
});

test('the evidence endpoint renders what it returns', async () => {
  const { doc, calls } = openPrScreen(async (url, options) => {
    if (url.endsWith('/evidence')) return jsonResponse({ status: 'partial', candidate: 'candidate-ref', plan: ['lint'], result: 'no verdict' });
    if (options.method === 'POST') return jsonResponse({ job: CONTROLLED_JOB_FINISHED }, { status: 202 });
    return jsonResponse({ job: CONTROLLED_JOB_FINISHED });
  });

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('Finished')));

  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'load-pr-evidence'), preventDefault() {} });
  assert.ok(await waitFor(() => doc.getElementById('prVerificationEvidence').innerHTML.includes('candidate-ref')));
  const evidence = doc.getElementById('prVerificationEvidence').innerHTML;
  assert.match(evidence, /Status: partial/);
  assert.match(evidence, /candidate-ref/);
  assert.match(evidence, /lint/);
  const request = calls.find(call => call.url.endsWith('/evidence'));
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
});
