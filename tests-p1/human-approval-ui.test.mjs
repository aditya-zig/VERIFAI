// Behaviour tests for the human approval step in front of the pull request.
//
// The repair, proof and publish gates are unchanged. The screen adds one
// thing: a human approves the repair in an explicit action, and only then
// can the pull request be opened. Both actions carry the human token, and
// neither token nor approval id is ever rendered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openApp, waitFor, jsonResponse } from './audit-app-harness.mjs';

const HUMAN_TOKEN = 'controlled-human-token-value';
const AUDIT_ID = 'audit-controlled-h1';

const VERIFIED_REPAIR_RUN = {
  id: AUDIT_ID,
  status: 'Completed',
  repository: { fullName: 'octocat/Hello-World', commit: 'a'.repeat(40) },
  files: { count: 2 },
  model: { provider: 'bedrock', model: 'unit-model' },
  durationMs: 1200,
  stages: { clone: { status: 'Completed' }, analysis: { status: 'Completed' } },
  execution: {
    status: 'Failed', exitCode: 1, durationMs: 12, command: 'node --check broken.js', source: 'git',
    stdout: '', stderr: '', sandbox: { started: true, removed: true, name: 'unit-sandbox', memoryBytes: 0, nanoCpus: 0, privileged: false },
  },
  repair: {
    verdict: 'VerifiedRepair',
    before: { exitCode: 1 },
    after: { exitCode: 0 },
    originalUnchanged: true,
    verifiedBaseCommitSha: 'b'.repeat(40),
    verifiedTarget: { command: 'node --check broken.js', exitCode: 0 },
    coverage: { label: 'SAME-COMMAND REPLAY / limited coverage' },
    changedFiles: [{ path: 'broken.js', beforeHash: 'c'.repeat(64), afterHash: 'd'.repeat(64) }],
    diff: '--- a/broken.js\n+++ b/broken.js',
  },
  cleanup: { repositoryRemoved: true, sandboxRemoved: true },
};

function openRepairScreen(fetchImpl) {
  const app = openApp({ fetchImpl });
  app.doc.getElementById('localRepoUrl').value = 'https://github.com/octocat/Hello-World';
  return app;
}

async function startRepairRun(app) {
  app.doc.getElementById('localRepositoryForm').requestSubmit();
  const ready = await waitFor(() => app.doc.getElementById('localRepoResult').innerHTML.includes('Verified repair'), { timeoutMs: 6000 });
  assert.ok(ready, 'the verified repair card is rendered');
  return app.doc.getElementById('localRepoResult').innerHTML;
}

function stubbed(overrides = {}) {
  return async (url, options) => {
    if (url.endsWith('/approval')) {
      const body = overrides.approval || { approved: true, approvalId: 'approval-controlled-1', expiresAt: '2026-10-21T11:00:00.000Z' };
      const status = overrides.approvalStatus || 201;
      return jsonResponse(body, { status, ok: status < 400 });
    }
    if (url.endsWith('/pr')) return jsonResponse(overrides.pr || { pullRequest: { url: 'https://example.test/pull/1' } }, { status: 201 });
    if (options.method === 'POST') return jsonResponse({ id: AUDIT_ID, status: 'Running' }, { status: 202 });
    return jsonResponse(VERIFIED_REPAIR_RUN);
  };
}

test('a verified repair asks for a human approval before the pull request', async () => {
  const { doc, calls } = openRepairScreen(stubbed());
  const rendered = await startRepairRun({ doc, calls });

  assert.match(rendered, /Human approval/);
  assert.match(rendered, /id="localApprovalToken"/);
  assert.match(rendered, /type="password"/);
  assert.match(rendered, /id="localApprovalReviewed"/);
  assert.match(rendered, /type="checkbox"/);
  assert.match(rendered, /data-action="approve-local-repair"/);
  assert.match(rendered, /data-action="create-local-pr"/);
  assert.match(rendered, /id="localCreatePr"[^>]*disabled/, 'publishing stays disabled until a human approves');
  assert.match(rendered, /single use/, 'the single use and stale behaviour is stated');
  assert.doesNotMatch(rendered, /data-action="create-deep-pr"|Merge/, 'no other publish control');
});

test('approving without a token or without the review sends nothing', async () => {
  const { doc, calls } = openRepairScreen(stubbed());
  await startRepairRun({ doc, calls });

  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'approve-local-repair'), preventDefault() {} });
  await waitFor(() => doc.getElementById('localApprovalState').innerHTML.includes('human token is required'));
  assert.equal(calls.filter(call => call.url.includes('/approval')).length, 0);

  doc.getElementById('localApprovalToken').value = HUMAN_TOKEN;
  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'approve-local-repair'), preventDefault() {} });
  await waitFor(() => doc.getElementById('localApprovalState').innerHTML.includes('reviewed the immutable proof'));
  assert.equal(calls.filter(call => call.url.includes('/approval')).length, 0);
  assert.equal(calls.filter(call => call.url.includes('/pr')).length, 0);
});

test('approving posts the approval only, and the publish is a second explicit action', async () => {
  const { doc, calls } = openRepairScreen(stubbed());
  await startRepairRun({ doc, calls });

  doc.getElementById('localApprovalToken').value = HUMAN_TOKEN;
  doc.getElementById('localApprovalReviewed').checked = true;
  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'approve-local-repair'), preventDefault() {} });
  assert.ok(await waitFor(() => doc.getElementById('localApprovalState').innerHTML.includes('Approved')));

  const approval = calls.find(call => call.url.includes('/approval'));
  assert.equal(approval.method, 'POST');
  assert.equal(approval.url, `/api/local/audits/${AUDIT_ID}/approval`);
  assert.equal(approval.headers.authorization, `Bearer ${HUMAN_TOKEN}`);
  assert.equal(calls.filter(call => call.url.endsWith('/pr')).length, 0, 'approving never opens a pull request');

  const publishButton = doc.getElementById('localCreatePr');
  assert.equal(publishButton.disabled, false, 'the publish action is unlocked by the approval');

  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'create-local-pr'), preventDefault() {} });
  assert.ok(await waitFor(() => calls.some(call => call.url.endsWith('/pr'))));

  const publish = calls.find(call => call.url.endsWith('/pr'));
  assert.equal(publish.method, 'POST');
  assert.equal(publish.url, `/api/local/audits/${AUDIT_ID}/pr`);
  assert.equal(publish.headers.authorization, `Bearer ${HUMAN_TOKEN}`);
  const body = JSON.parse(publish.body);
  assert.equal(body.approvalId, 'approval-controlled-1', 'the publish carries the approval id');
  assert.equal(Object.keys(body).length, 1, 'the publish body carries the approval id and nothing else');
});

test('the token and the approval id are never rendered, stored or put in a url', async () => {
  const { doc, calls, location, storage } = openRepairScreen(stubbed());
  await startRepairRun({ doc, calls });

  doc.getElementById('localApprovalToken').value = HUMAN_TOKEN;
  doc.getElementById('localApprovalReviewed').checked = true;
  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'approve-local-repair'), preventDefault() {} });
  assert.ok(await waitFor(() => doc.getElementById('localApprovalState').innerHTML.includes('Approved')));
  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'create-local-pr'), preventDefault() {} });
  assert.ok(await waitFor(() => doc.getElementById('localPrResult').innerHTML.includes('PR created')));

  const rendered = doc.getElementById('localRepoResult').innerHTML;
  assert.ok(!rendered.includes(HUMAN_TOKEN), 'the token is not rendered');
  assert.ok(!rendered.includes('approval-controlled-1'), 'the approval id is not rendered');
  assert.ok(!doc.app.innerHTML.includes(HUMAN_TOKEN), 'the token is not in the page');
  assert.deepEqual(storage.touched, [], 'no storage was read or written');
  assert.ok(!location.hash.includes(HUMAN_TOKEN), 'the token is not in the route');
  for (const call of calls) {
    assert.ok(!call.url.includes(HUMAN_TOKEN), 'the token is not in a request url');
  }
});

test('an agent token is refused and the publish stays locked', async () => {
  for (const [status, expected] of [[401, /rejected the token \(401\)/], [403, /human token is required/]]) {
    const { doc, calls } = openRepairScreen(stubbed({ approval: { error: 'human principal required' }, approvalStatus: status }));
    await startRepairRun({ doc, calls });

    doc.getElementById('localApprovalToken').value = HUMAN_TOKEN;
    doc.getElementById('localApprovalReviewed').checked = true;
    doc.dispatch('click', { target: doc.findByAttribute('data-action', 'approve-local-repair'), preventDefault() {} });
    assert.ok(await waitFor(() => doc.getElementById('localApprovalState').innerHTML.includes('human') || doc.getElementById('localApprovalState').innerHTML.includes('rejected')));

    const state = doc.getElementById('localApprovalState').innerHTML;
    assert.match(state, expected);
    assert.equal(doc.getElementById('localCreatePr').disabled, true, 'the publish stays locked');
    assert.equal(calls.filter(call => call.url.endsWith('/pr')).length, 0, 'a refused approval never opens a pull request');
  }
});

test('the repair and publish gates are unchanged for every other run', async () => {
  const { doc } = openRepairScreen(async () => jsonResponse({}));
  doc.getElementById('localRepoUrl').value = 'https://github.com/octocat/Hello-World';
  doc.getElementById('localRepositoryForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('localRepoResult').innerHTML.includes('Cleanup')));

  const rendered = doc.getElementById('localRepoResult').innerHTML;
  assert.doesNotMatch(rendered, /data-action="approve-local-repair"/, 'no approval without a verified repair');
  assert.doesNotMatch(rendered, /data-action="create-local-pr"/, 'no publish without a verified repair');
  assert.doesNotMatch(rendered, /id="localApprovalToken"/);
});
