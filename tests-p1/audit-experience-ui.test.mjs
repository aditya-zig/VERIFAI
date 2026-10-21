// Behaviour tests for the delivered VERIFAI screen.
//
// Every test drives the real page script through a small DOM harness and
// asserts on the markup the app renders: the navigation state, the busy and
// error states, the result hierarchy and the gates that must stay closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openApp, waitFor, jsonResponse, collectTags } from './audit-app-harness.mjs';

const noFetch = async () => jsonResponse({});

function navLinks(doc) {
  return collectTags(doc.app.innerHTML, 'a').filter(tag => (tag.attributes.class || '').split(/\s+/).includes('nav-link'));
}

function completedLocalRun() {
  return {
    id: 'audit-1',
    status: 'Completed',
    repository: { fullName: 'octocat/Hello-World', commit: 'abc123' },
    files: { count: 3 },
    model: { provider: 'bedrock', model: 'unit-model' },
    durationMs: 1200,
    outputHash: 'a'.repeat(64),
    selectedCommand: 'git ls-files --error-unmatch -- README',
    stages: {
      clone: { status: 'Completed', detail: '3 tracked files cloned' },
      analysis: { status: 'Completed', detail: 'bedrock / unit-model' },
      sandbox: { status: 'Completed', detail: 'Docker sandbox: unit' },
      execution: { status: 'Completed', detail: 'Exit 0' },
      finding: { status: 'Completed', detail: 'Model hypothesis kept separate from server-owned executed evidence' },
      cleanup: { status: 'Completed', detail: 'Temporary repository and sandbox removed' },
    },
    execution: {
      status: 'Completed', exitCode: 0, durationMs: 12, command: 'git ls-files --error-unmatch -- README',
      source: 'git', stdout: 'README\n', stderr: '', sandbox: { started: true, removed: true, name: 'unit-sandbox', memoryBytes: 0, nanoCpus: 0, privileged: false },
    },
    finding: {
      title: 'Unit finding', severity: 'low', description: 'A model claim about the repository',
      evidence: { file: 'README.md' },
      assessment: { findingState: 'Unconfirmed', scope: 'limited-check: tracked README — not a test suite, not security verification', reason: 'single bounded command' },
    },
    cleanup: { repositoryRemoved: true, sandboxRemoved: true },
  };
}

function deepAuditRun() {
  return {
    runId: 'deep-unit-1',
    status: 'completed',
    mode: 'deep-audit',
    repository: 'acme/checkout',
    overall: 'Issues confirmed — repair requires real swarm',
    engines: [
      { name: 'api', status: 'pass', state: 'completed', confidence: 'Confirmed', reason: 'API invariant passed', costUsd: 0.03 },
      { name: 'leakage', status: 'fail', state: 'completed', confidence: 'Confirmed', reason: '1 credential-like value detected', costUsd: 0.02 },
      { name: 'computer', status: 'unknown', state: 'incomplete', confidence: 'Incomplete', reason: 'VERIFIAI_CUA_URL is not configured', costUsd: 0.08 },
      { name: 'deployed', status: 'unknown', state: 'unknown', confidence: 'Unknown', reason: 'No deployed URL supplied or discovered', costUsd: 0.03 },
    ],
    findings: [
      { id: 'FND-LEAKAGE', category: 'Leakage', impact: 'Critical', state: 'Confirmed', summary: 'Potential secret material is present in repository content', rootCause: 'credential-like value committed to source-controlled content' },
      { id: 'INC-COMPUTER', category: 'Incomplete', impact: 'Unknown', state: 'Incomplete', summary: 'computer check could not complete', rootCause: 'VERIFIAI_CUA_URL is not configured' },
    ],
    coverage: { total: 4, tested: 2, incomplete: 1, unknown: 1, pending: 0, confirmed: 1, percentage: 50, limitations: [{ engine: 'computer', state: 'incomplete', reason: 'VERIFIAI_CUA_URL is not configured' }] },
    guardrails: { estimatedRunSpendUsd: 0.16, hardRunCapUsd: 2.5, httpRequests: 12, maxHttpRequests: 80, maxDurationMs: 180000, withinGuardrails: true },
    events: [{ type: 'run.started', at: '2026-10-21T10:00:00.000Z', message: 'Deep Audit started' }],
    fix: { status: 'not-run', reason: 'Legacy deterministic Deep Audit cannot repair or verify its own finding. Use the real Strands repair + independent re-verification workers.', pr: { ready: false, autoMerge: false, requiresHumanApproval: true } },
  };
}

test('the shell offers every mode, marks the current one and moves focus on a switch', () => {
  const { doc, context } = openApp({ fetchImpl: noFetch });
  const links = navLinks(doc);
  assert.equal(links.length, 3);
  assert.deepEqual(links.map(link => link.attributes['data-nav']).sort(), ['deep-audit', 'landing', 'pr-verification']);
  const current = links.filter(link => link.attributes['aria-current'] === 'page');
  assert.equal(current.length, 1);
  assert.equal(current[0].attributes['data-nav'], 'landing');
  assert.ok(links.every(link => link.tagName === 'a' && link.attributes.href), 'modes are real links, so Tab and Enter reach them');
  assert.match(doc.app.innerHTML, /Local controller/, 'the header no longer claims the analysis is local');

  doc.dispatch('click', { target: doc.findByAttribute('data-nav', 'deep-audit'), preventDefault() {} });

  const after = navLinks(doc);
  const afterCurrent = after.filter(link => link.attributes['aria-current'] === 'page');
  assert.equal(afterCurrent.length, 1);
  assert.equal(afterCurrent[0].attributes['data-nav'], 'deep-audit');
  assert.equal(context.document.title, 'Deep audit | VERIFAI');
  assert.ok(doc.app.innerHTML.includes('id="deepAuditForm"'));
  assert.equal(doc.focused && doc.focused.id, 'deepAuditTitle');

  doc.dispatch('click', { target: doc.findByAttribute('data-nav', 'pr-verification'), preventDefault() {} });
  const prCurrent = navLinks(doc).filter(link => link.attributes['aria-current'] === 'page');
  assert.equal(prCurrent.length, 1);
  assert.equal(prCurrent[0].attributes['data-nav'], 'pr-verification');
  assert.equal(context.document.title, 'PR verification | VERIFAI');
  assert.ok(doc.app.innerHTML.includes('id="prVerificationForm"'));
  assert.equal(doc.focused && doc.focused.id, 'prVerificationTitle');
});

test('a retired or unknown hash never brings a retired screen back', () => {
  const { doc, context } = openApp({ hash: '#/verified', fetchImpl: noFetch });
  assert.equal(context.document.title, 'Local repository check | VERIFAI');
  assert.ok(doc.app.innerHTML.includes('id="localRepositoryForm"'));
  const before = doc.app.innerHTML;
  context.VERIFAI.navigate('repair');
  assert.equal(doc.app.innerHTML, before);
  assert.equal(context.VERIFAI.state.screen, 'landing');
});

test('the result area states that nothing ran yet before the first check', () => {
  const { doc } = openApp({ fetchImpl: noFetch });
  assert.match(doc.app.innerHTML, /No check has run yet/);
  assert.match(doc.app.innerHTML, /id="localRepoResult"/);
});

test('a local check shows a busy state, the live stage trace, then the server result', async () => {
  const runs = [
    { id: 'audit-1', status: 'Running', stages: { clone: { status: 'Running' }, analysis: { status: 'Pending' } } },
    completedLocalRun(),
  ];
  const { doc, calls } = openApp({
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') return jsonResponse({ id: 'audit-1', status: 'Running' }, { status: 202 });
      return jsonResponse(runs.shift() || completedLocalRun());
    },
  });

  doc.getElementById('localRepoUrl').value = 'https://github.com/octocat/Hello-World';
  doc.getElementById('localRepositoryForm').requestSubmit();

  const button = doc.getElementById('startLocalAudit');
  assert.equal(button.disabled, true, 'the run button is busy while the check runs');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.match(button.textContent, /running/i);
  assert.equal(doc.getElementById('localRepositoryForm').dataset.auditId, undefined);

  assert.ok(await waitFor(() => doc.getElementById('localAuditStages').innerHTML.includes('clone: Running')));
  assert.match(doc.getElementById('localAuditStages').innerHTML, /analysis: Pending/);

  assert.ok(await waitFor(() => doc.getElementById('localRepoResult').innerHTML.includes('Completed limited check')));
  const rendered = doc.getElementById('localRepoResult').innerHTML;
  assert.match(rendered, /Unit finding/);
  assert.match(rendered, /cleanup: Completed/);
  assert.match(rendered, /analysis: Completed/);
  assert.match(rendered, /Exit: 0/);
  assert.match(rendered, /Docker sandbox started/);
  assert.match(rendered, /not a test suite/);
  assert.ok(button.disabled === false, 'the run button is released when the check ends');
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(doc.getElementById('localRepositoryForm').dataset.auditId, 'audit-1');
  assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [
    'POST /api/local/audits',
    'GET /api/local/audits/audit-1',
    'GET /api/local/audits/audit-1',
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), { url: 'https://github.com/octocat/Hello-World' });
});

test('a completed check keeps the contract the browser check waits for', async () => {
  const run = completedLocalRun();
  const { doc } = openApp({
    fetchImpl: async (url, options) => (options.method === 'POST'
      ? jsonResponse({ id: 'audit-1', status: 'Running' }, { status: 202 })
      : jsonResponse(run)),
  });
  doc.getElementById('localRepoUrl').value = 'https://github.com/octocat/Hello-World';
  doc.getElementById('localRepositoryForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('localRepoResult').innerHTML.includes('Completed limited check')));

  const rendered = doc.getElementById('localRepoResult').innerHTML;
  const status = rendered.match(/<p id="localAuditStatus"[^>]*>([^<]*)<\/p>/);
  assert.ok(status, 'the status element is rendered');
  assert.equal(status[1], 'Completed limited check');
  assert.match(rendered, /id="localExecutionEvidence"/);
  assert.match(rendered, /data-action="run-fixture-browser"/);
  assert.match(rendered, /not verification of the cloned application/);
});

test('a run that ends incomplete shows the failed stage and offers a retry', async () => {
  const run = {
    ...completedLocalRun(),
    status: 'Incomplete',
    failedStage: 'analysis',
    error: 'VERIFIAI_BEDROCK_MODEL_ID (or VERIFAI_MODEL_ID) is required',
    finding: undefined,
    execution: undefined,
    stages: {
      clone: { status: 'Completed', detail: '1 tracked files cloned', durationMs: 1015 },
      analysis: { status: 'Incomplete', detail: 'model is not configured', durationMs: 4 },
      sandbox: { status: 'Skipped' },
      execution: { status: 'Skipped' },
      finding: { status: 'Skipped' },
      cleanup: { status: 'Completed', detail: 'Temporary repository and sandbox removed', durationMs: 8 },
    },
  };
  const { doc } = openApp({
    fetchImpl: async (url, options) => (options.method === 'POST'
      ? jsonResponse({ id: 'audit-1', status: 'Running' }, { status: 202 })
      : jsonResponse(run)),
  });
  doc.getElementById('localRepoUrl').value = 'https://github.com/octocat/Hello-World';
  doc.getElementById('localRepositoryForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('localRepoResult').innerHTML.includes('Incomplete')));

  const rendered = doc.getElementById('localRepoResult').innerHTML;
  assert.match(rendered, /The run stopped at the analysis stage/);
  assert.match(rendered, /VERIFIAI_BEDROCK_MODEL_ID \(or VERIFAI_MODEL_ID\) is required/);
  assert.match(rendered, /analysis: Incomplete/);
  assert.match(rendered, /sandbox: Skipped/);
  assert.match(rendered, /data-action="retry-local-audit"/);
  assert.doesNotMatch(rendered, /Model hypothesis/, 'no hypothesis is claimed when the run stopped before it');
});

test('the form carries a short limits summary and the scope detail is kept', () => {
  const { doc } = openApp({ fetchImpl: noFetch });
  const markup = doc.app.innerHTML;
  assert.match(markup, /class="form-limits"/);
  assert.match(markup, /A limited check\. It does not run your test suite/);
  assert.match(markup, /This run does<\/h2>/);
  assert.match(markup, /This run does not<\/h2>/);
  const form = markup.indexOf('id="localRepositoryForm"');
  const limits = markup.indexOf('class="form-limits"');
  const result = markup.indexOf('id="localRepoResult"');
  const scope = markup.indexOf('class="scope-grid"');
  assert.ok(form >= 0 && limits > form, 'the limits summary sits with the action');
  assert.ok(result > form, 'the result follows the action');
  assert.ok(scope > result, 'the scope detail comes after the job, so a phone reaches the start action first');
});

test('a refused run shows the reason and a retry that runs the check again', async () => {
  let attempts = 0;
  const { doc, calls } = openApp({
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse({ error: 'model provider is not configured' }, { ok: false, status: 503 });
    },
  });

  doc.getElementById('localRepoUrl').value = 'https://github.com/octocat/Hello-World';
  doc.getElementById('localRepositoryForm').requestSubmit();

  assert.ok(await waitFor(() => doc.getElementById('localRepoResult').innerHTML.includes('model provider is not configured')));
  const rendered = doc.getElementById('localRepoResult').innerHTML;
  assert.match(rendered, /The check did not finish/);
  assert.match(rendered, /data-action="retry-local-audit"/);
  assert.equal(doc.getElementById('startLocalAudit').disabled, false);

  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'retry-local-audit'), preventDefault() {} });
  assert.ok(await waitFor(() => calls.filter(call => call.method === 'POST').length === 2));
  assert.equal(attempts, 2);
});

test('the deep audit screen posts to the deep audit route and shows every lane state', async () => {
  const { doc, calls } = openApp({
    fetchImpl: async (url, options) => {
      if (options.method === 'POST' && url === '/api/demo/deep-audit') return jsonResponse({ run: deepAuditRun() });
      return jsonResponse({ run: deepAuditRun() });
    },
  });

  doc.dispatch('click', { target: doc.findByAttribute('data-nav', 'deep-audit'), preventDefault() {} });
  const form = doc.getElementById('deepAuditForm');
  assert.ok(form, 'the deep audit screen has its own form');
  assert.equal(doc.getElementById('deepAuditRepository').value, 'acme/checkout');
  form.requestSubmit();

  assert.ok(await waitFor(() => doc.getElementById('deepAuditResult').innerHTML.includes('lane-row')));
  const rendered = doc.getElementById('deepAuditResult').innerHTML;
  assert.match(rendered, /api/);
  assert.match(rendered, /leakage/);
  assert.match(rendered, /VERIFIAI_CUA_URL is not configured/);
  assert.match(rendered, /Incomplete/);
  assert.match(rendered, /<dt>lanes<\/dt><dd>4<\/dd>/);
  assert.match(rendered, /<dt>incomplete<\/dt><dd>1<\/dd>/);
  assert.equal(doc.getElementById('startDeepAudit').disabled, false);

  const post = calls.find(call => call.url === '/api/demo/deep-audit');
  assert.equal(post.method, 'POST');
  const body = JSON.parse(post.body);
  assert.equal(body.repository, 'acme/checkout');
  assert.match(body.runId, /^deep-/);
});

test('the deep audit pull request gate stays closed', async () => {
  const { doc } = openApp({
    fetchImpl: async () => jsonResponse({ run: deepAuditRun() }),
  });
  doc.dispatch('click', { target: doc.findByAttribute('data-nav', 'deep-audit'), preventDefault() {} });
  doc.getElementById('deepAuditForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('deepAuditResult').innerHTML.includes('Pull request gate closed')));
  assert.equal(doc.findByAttribute('data-action', 'create-deep-pr'), null, 'no pull request control while the gate is closed');
  assert.match(doc.getElementById('deepAuditResult').innerHTML, /cannot repair or verify its own finding/);
});

test('steering a deep audit posts the instruction to the same run', async () => {
  const { doc, calls } = openApp({
    fetchImpl: async (url, options) => {
      if (options.method === 'POST' && url.endsWith('/steer')) return jsonResponse({ event: { type: 'steering.completed', message: 'Steered investigation: check the duplicate payment path' } });
      return jsonResponse({ run: deepAuditRun() });
    },
  });
  doc.dispatch('click', { target: doc.findByAttribute('data-nav', 'deep-audit'), preventDefault() {} });
  doc.getElementById('deepAuditForm').requestSubmit();
  assert.ok(await waitFor(() => doc.getElementById('deepAuditResult').innerHTML.includes('Steer this run')));

  doc.getElementById('deepAuditInstruction').value = 'check the duplicate payment path';
  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'steer-deep-audit'), preventDefault() {} });

  assert.ok(await waitFor(() => calls.some(call => call.url === '/api/demo/deep-audit/deep-unit-1/steer')));
  const steer = calls.find(call => call.url.endsWith('/steer'));
  assert.equal(steer.method, 'POST');
  assert.deepEqual(JSON.parse(steer.body), { instruction: 'check the duplicate payment path' });
  assert.ok(await waitFor(() => doc.getElementById('deepAuditSteerResult').innerHTML.includes('Instruction recorded')));
});

test('a deep audit the server refuses shows the reason and a retry', async () => {
  const { doc, calls } = openApp({
    fetchImpl: async () => jsonResponse({ error: 'deep audit route is unavailable' }, { ok: false, status: 500 }),
  });
  doc.dispatch('click', { target: doc.findByAttribute('data-nav', 'deep-audit'), preventDefault() {} });
  doc.getElementById('deepAuditForm').requestSubmit();

  assert.ok(await waitFor(() => doc.getElementById('deepAuditResult').innerHTML.includes('deep audit route is unavailable')));
  assert.match(doc.getElementById('deepAuditResult').innerHTML, /data-action="retry-deep-audit"/);
  assert.equal(doc.getElementById('startDeepAudit').disabled, false);

  doc.dispatch('click', { target: doc.findByAttribute('data-action', 'retry-deep-audit'), preventDefault() {} });
  assert.ok(await waitFor(() => calls.filter(call => call.url === '/api/demo/deep-audit').length === 2));
});
