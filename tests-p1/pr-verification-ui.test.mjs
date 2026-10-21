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

// The shape the controller stores: PrJob, CheckPlan, CheckObservation and
// PrVerificationResult from packages/contracts. A Finished job whose result
// is Incomplete, with one check that ran on the base and one that never ran
// on the head.
const STORED_JOB_FINISHED_INCOMPLETE = {
  id: 'prjob-7f3c1b62-0f5a-4d61-9c1e-2b8a5f0d4e77',
  ownerId: 'owner-controlled',
  request: { repository: 'octocat/Hello-World', pullRequest: 7, expectedHeadSha: HEAD_SHA },
  requestKey: 'prv-controlled-key',
  phase: 'Finished',
  cancelRequested: false,
  candidate: {
    repository: 'octocat/Hello-World',
    pullRequest: 7,
    headRepository: 'octocat',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    mergeBaseSha: 'c'.repeat(40),
    changedFiles: ['README.md', 'index.js'],
    diffDigest: 'd'.repeat(64),
  },
  plan: {
    policyVersion: 'pr-verification-policy-v1',
    profileId: 'pr-demo-profile',
    profileDigest: 'e'.repeat(64),
    requiredChecks: [{ checkId: 'lint', artifactRef: 'checks/lint', contentSha256: 'f'.repeat(64), origin: 'approved' }],
    generatedTests: [{ checkId: 'unit-generated', artifactRef: 'tests/generated-unit', contentSha256: '1'.repeat(64), origin: 'generated' }],
    planDigest: '2'.repeat(64),
  },
  resourceIds: [],
  result: {
    candidate: {
      repository: 'octocat/Hello-World',
      pullRequest: 7,
      headRepository: 'octocat',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeBaseSha: 'c'.repeat(40),
      changedFiles: ['README.md', 'index.js'],
      diffDigest: 'd'.repeat(64),
    },
    plan: {
      policyVersion: 'pr-verification-policy-v1',
      profileId: 'pr-demo-profile',
      profileDigest: 'e'.repeat(64),
      requiredChecks: [{ checkId: 'lint', artifactRef: 'checks/lint', contentSha256: 'f'.repeat(64), origin: 'approved' }],
      generatedTests: [{ checkId: 'unit-generated', artifactRef: 'tests/generated-unit', contentSha256: '1'.repeat(64), origin: 'generated' }],
      planDigest: '2'.repeat(64),
    },
    observations: [
      { checkId: 'lint', revision: 'base', commitSha: BASE_SHA, status: 'Verified', executed: true, exitCode: 0, artifactRefs: ['artifacts/base-lint.json'], commandDigest: '3'.repeat(64), testContentSha256: 'f'.repeat(64) },
      { checkId: 'lint', revision: 'head', commitSha: HEAD_SHA, status: 'Incomplete', executed: false, exitCode: null, artifactRefs: [], commandDigest: '3'.repeat(64), testContentSha256: 'f'.repeat(64) },
    ],
    verdict: 'Incomplete',
    limitations: ['the head check never ran'],
    evidenceManifestSha256: '4'.repeat(64),
    cleanupComplete: true,
    superseded: false,
  },
  verdict: 'Incomplete',
  failure: { code: 'EXECUTION_RUNTIME_UNAVAILABLE', message: 'the execution runtime is not configured' },
  limitations: ['the execution runtime is not configured'],
  version: 3,
  createdAt: '2026-10-21T10:00:00.000Z',
  updatedAt: '2026-10-21T10:00:12.000Z',
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
    return jsonResponse({ job: polls === 1 ? CONTROLLED_JOB_EXECUTING : STORED_JOB_FINISHED_INCOMPLETE });
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
    ? jsonResponse({ job: STORED_JOB_FINISHED_INCOMPLETE }, { status: 202 })
    : jsonResponse({ job: STORED_JOB_FINISHED_INCOMPLETE })));

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('Finished')));

  const rendered = doc.getElementById('prVerificationResult').innerHTML;
  assert.match(rendered, /prjob-7f3c1b62-0f5a-4d61-9c1e-2b8a5f0d4e77/);
  assert.match(rendered, /Incomplete/);
  assert.match(rendered, new RegExp(BASE_SHA));
  assert.match(rendered, new RegExp(HEAD_SHA));
  assert.match(rendered, /lint/);
  assert.match(rendered, /cleanup complete/);
  assert.match(rendered, /the execution runtime is not configured/);
  assert.doesNotMatch(rendered, /data-action="create-|Create PR|pull request created/i, 'no pull request action on this screen');
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

test('a stored finished job renders the exact contract fields', async () => {
  const { doc } = openPrScreen(async (url, options) => (options.method === 'POST'
    ? jsonResponse({ job: STORED_JOB_FINISHED_INCOMPLETE }, { status: 202 })
    : jsonResponse({ job: STORED_JOB_FINISHED_INCOMPLETE })));

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('prjob-7f3c1b62')));

  const rendered = doc.getElementById('prVerificationResult').innerHTML;
  // the job itself
  assert.match(rendered, /prjob-7f3c1b62-0f5a-4d61-9c1e-2b8a5f0d4e77/);
  assert.match(rendered, /Finished/);
  assert.match(rendered, /Incomplete/);
  assert.match(rendered, /EXECUTION_RUNTIME_UNAVAILABLE/);
  assert.match(rendered, /the execution runtime is not configured/);
  // the request and the candidate
  assert.match(rendered, /expected head/);
  assert.match(rendered, new RegExp(HEAD_SHA));
  assert.match(rendered, /resolved base/);
  assert.match(rendered, new RegExp(BASE_SHA));
  assert.match(rendered, /merge base/);
  assert.match(rendered, new RegExp('c'.repeat(40)));
  assert.match(rendered, /README\.md/);
  // the plan
  assert.match(rendered, /pr-verification-policy-v1/);
  assert.match(rendered, /pr-demo-profile/);
  assert.match(rendered, new RegExp('2'.repeat(64)));
  assert.match(rendered, /Required checks \(1\)/);
  assert.match(rendered, /Generated tests \(1\)/);
  assert.match(rendered, /unit-generated/);
  // every observation field
  assert.match(rendered, /revision: base/);
  assert.match(rendered, /revision: head/);
  assert.match(rendered, /executed: yes/);
  assert.match(rendered, /executed: no/);
  assert.match(rendered, /exit code: 0/);
  assert.match(rendered, /exit code: Not reported/);
  assert.match(rendered, /artifacts: artifacts\/base-lint\.json/);
  assert.match(rendered, /artifacts: None recorded/);
  assert.match(rendered, new RegExp('3'.repeat(64)));
  assert.match(rendered, new RegExp('f'.repeat(64)));
  // cleanup, evidence and limitations
  assert.match(rendered, /cleanup complete/);
  assert.match(rendered, /superseded/);
  assert.match(rendered, new RegExp('4'.repeat(64)));
  assert.match(rendered, /Job limitations \(1\)/);
  assert.match(rendered, /Result limitations \(1\)/);
  assert.match(rendered, /the head check never ran/);
});

test('a resolved job that failed before the checks shows the failure, not a JSON dump', async () => {
  const resolvedButUnplanned = {
    id: 'prjob-resolved-0003',
    phase: 'Finished',
    verdict: 'Incomplete',
    request: { repository: 'octocat/Hello-World', pullRequest: 80, expectedHeadSha: HEAD_SHA },
    candidate: {
      repository: 'octocat/Hello-World',
      pullRequest: 80,
      headRepository: 'octocat',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeBaseSha: 'c'.repeat(40),
      changedFiles: ['README.md'],
      diffDigest: 'd'.repeat(64),
    },
    failure: { code: 'PLANNER_UNAVAILABLE', message: 'no approved profile is configured for this repository' },
    limitations: ['the check plan could not be built'],
  };
  const { doc } = openPrScreen(async (url, options) => (options.method === 'POST'
    ? jsonResponse({ job: resolvedButUnplanned }, { status: 202 })
    : jsonResponse({ job: resolvedButUnplanned })));

  fillForm(doc, { pullRequest: '80' });
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('PLANNER_UNAVAILABLE')));

  const rendered = doc.getElementById('prVerificationResult').innerHTML;
  assert.match(rendered, /PLANNER_UNAVAILABLE/);
  assert.match(rendered, /no approved profile is configured for this repository/);
  assert.doesNotMatch(rendered, /\"code\"|\"message\"/, 'the failure is not a JSON dump');
  assert.match(rendered, /resolved base/);
  assert.match(rendered, new RegExp(BASE_SHA));
  assert.match(rendered, /resolved head/);
  const testedBase = rendered.match(/<dt>tested base commit<\/dt><dd[^>]*>([^<]*)</);
  const testedHead = rendered.match(/<dt>tested head commit<\/dt><dd[^>]*>([^<]*)</);
  assert.equal(testedBase[1], 'Not tested', 'a resolved base is not a tested base');
  assert.equal(testedHead[1], 'Not tested', 'a resolved head is not a tested head');
  assert.ok(!rendered.includes('no observations were recorded'), 'the wording stays plain');
});

test('an expected head is never reported as a tested commit', async () => {
  const { doc } = openPrScreen(async (url, options) => (options.method === 'POST'
    ? jsonResponse({ job: STORED_JOB_FINISHED_INCOMPLETE }, { status: 202 })
    : jsonResponse({ job: STORED_JOB_FINISHED_INCOMPLETE })));

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('prjob-7f3c1b62')));

  const rendered = doc.getElementById('prVerificationResult').innerHTML;
  const testedBase = rendered.match(/<dt>tested base commit<\/dt><dd[^>]*>([^<]*)</);
  const testedHead = rendered.match(/<dt>tested head commit<\/dt><dd[^>]*>([^<]*)</);
  assert.ok(testedBase, 'the tested base is reported');
  assert.equal(testedBase[1], BASE_SHA, 'the base that ran is the tested base');
  assert.ok(testedHead, 'the tested head is reported');
  assert.equal(testedHead[1], 'Not tested', 'the head that never ran is not called tested, even though the request expected it');
  assert.match(rendered, /No evidence was recorded for this check\./, 'the check that never ran carries no evidence claim');
  assert.match(rendered, /expected head/, 'the request head is shown as the expectation');
});

test('the evidence endpoint reports an unavailable terminal job with its verdict', async () => {
  const terminalWithoutResult = {
    id: 'prjob-terminal-0002',
    phase: 'Finished',
    verdict: 'Incomplete',
    limitations: ['the job finished without a recorded result'],
  };
  const { doc } = openPrScreen(async (url, options) => {
    if (url.endsWith('/evidence')) return jsonResponse({ status: 'Unavailable', verdict: 'Incomplete', limitations: ['the job finished without a recorded result'] });
    if (options.method === 'POST') return jsonResponse({ job: terminalWithoutResult }, { status: 202 });
    return jsonResponse({ job: terminalWithoutResult });
  });

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('prjob-terminal-0002')));

  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'load-pr-evidence'), preventDefault() {} });
  assert.ok(await waitFor(() => doc.getElementById('prVerificationEvidence').innerHTML.includes('Unavailable')));

  const evidence = doc.getElementById('prVerificationEvidence').innerHTML;
  assert.match(evidence, /Unavailable/);
  assert.match(evidence, /Verdict: Incomplete/);
  assert.match(evidence, /the job finished without a recorded result/);
  assert.doesNotMatch(evidence, /Pending/, 'a terminal job is not left pending');
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
    if (url.endsWith('/evidence')) return jsonResponse({
      status: 'Available',
      candidate: STORED_JOB_FINISHED_INCOMPLETE.candidate,
      plan: STORED_JOB_FINISHED_INCOMPLETE.plan,
      result: STORED_JOB_FINISHED_INCOMPLETE.result,
    });
    if (options.method === 'POST') return jsonResponse({ job: STORED_JOB_FINISHED_INCOMPLETE }, { status: 202 });
    return jsonResponse({ job: STORED_JOB_FINISHED_INCOMPLETE });
  });

  fillForm(doc);
  doc.getElementById('prVerificationForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('prVerificationResult').innerHTML.includes('Finished')));

  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'load-pr-evidence'), preventDefault() {} });
  assert.ok(await waitFor(() => doc.getElementById('prVerificationEvidence').innerHTML.includes('Available')));
  const evidence = doc.getElementById('prVerificationEvidence').innerHTML;
  assert.match(evidence, /Available/);
  assert.match(evidence, /pr-demo-profile/);
  assert.match(evidence, new RegExp('2'.repeat(64)));
  assert.match(evidence, /observations/);
  assert.match(evidence, new RegExp('4'.repeat(64)));
  const request = calls.find(call => call.url.endsWith('/evidence'));
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
});
