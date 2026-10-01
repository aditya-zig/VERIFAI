import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadResultPage, renderWithHelpers, functionSource, RESULT_HELPERS } from './result-renderer-harness.mjs';

// Adapted from PR #66 (remote/ui-result-readability, 086bc30) presentation helpers
// and CSS, reworked for local evidence-ownership semantics: strict repair gates,
// full hashes, Not reported unknowns, neutral provenance, collapsed diagnostics.
const page = await loadResultPage();
const { html } = page;

function render(extra = {}) {
  return renderWithHelpers(page, { id: 'unit-ui', status: 'Incomplete', stages: {}, ...extra });
}

function helpers() {
  // escapeHtml stays in scope because the real helpers call it; only the
  // presentation helpers are handed back for direct assertion.
  const sources = RESULT_HELPERS.map(name => functionSource(html, name)).join('\n\n');
  return vm.runInNewContext(`(() => {\n${sources}\nreturn { resultTone, factTone, resultBadge, chip, monoChip, fact, factGrid, evidenceCard, sandboxDisplay, hashChip };\n})()`, {});
}

function execution(exitCode, extra = {}) {
  return {
    exitCode,
    status: exitCode === 0 ? 'Completed' : 'Failed',
    command: 'node --check broken.js',
    source: 'pnpm script: check',
    durationMs: 3,
    stdout: 'out',
    stderr: 'err',
    sandbox: { started: true, removed: true, name: 'unit-fixture', memoryBytes: 1073741824, nanoCpus: 2000000000, privileged: false },
    ...extra,
  };
}

test('stages and sandbox have structured observable fact cards', () => {
  const markup = render({ execution: execution(1), stages: { clone: { status: 'Completed', detail: '12 tracked files' }, cleanup: { status: 'Completed' } } });
  assert.match(markup, /id="localAuditStagesCard"/);
  assert.match(markup, /id="localAuditStages"[^>]*class="[^"]*stage-facts/);
  assert.match(markup, /<dt>network<\/dt>/);
  assert.match(markup, /<dt>privileged<\/dt>/);
});

test('presentation helpers ship with local-safe unknown handling', () => {
  const h = helpers();
  assert.equal(h.resultTone('Completed'), 'verified');
  assert.equal(h.resultTone('VerifiedRepair'), 'verified');
  assert.equal(h.resultTone('Running'), 'running');
  assert.equal(h.resultTone('Incomplete'), 'failed');
  assert.equal(h.resultTone('Failed'), 'failed');
  assert.equal(h.resultTone('Nope'), 'unknown');
  assert.equal(h.factTone('Completed'), 'good');
  assert.equal(h.factTone('Nope'), '');
  assert.match(h.resultBadge('Completed', 'Completed limited check'), /status verified/);
  assert.match(h.chip('Audit id', 'abc'), /class="chip"/);
  assert.equal(h.chip('Audit id', ''), '');
  assert.match(h.monoChip('before', 'abcdef'), /class="chip mono"/);
  assert.equal(h.monoChip('before', ''), '');
  assert.match(h.fact('exit code', '1', undefined, true), /<dd class="mono">1<\/dd>/);
  assert.match(h.fact('source', undefined), /Missing/);
  assert.match(h.factGrid([h.fact('a', '1'), '']), /fact-grid/);
  assert.equal(h.factGrid([]), '');
  assert.match(h.evidenceCard('x', 'Title', '', '<p>hi</p>'), /evidence-card/);
  assert.equal(h.sandboxDisplay(true), 'yes');
  assert.equal(h.sandboxDisplay(false), 'no');
  assert.equal(h.sandboxDisplay(undefined), 'Not reported');
  assert.equal(h.sandboxDisplay(null), 'Not reported');
  const full = 'b'.repeat(64);
  const chipMarkup = h.hashChip('before', full);
  assert.match(chipMarkup, new RegExp(full));
  assert.match(chipMarkup, /bbbbbbbbbbbb/);
  assert.equal(h.hashChip('before', ''), '');
});

test('result page styles ship overflow guards without class collisions', () => {
  assert.match(html, /\.result-root\s*\{\s*display:\s*grid/);
  assert.match(html, /\.evidence-card\s*\{\s*display:\s*grid;\s*gap:\s*12px;\s*min-width:\s*0/);
  assert.match(html, /\.fact-grid\s*\{[^}]*grid-template-columns/);
  assert.match(html, /\.fact dd\.mono\s*\{[^}]*font-family:\s*ui-monospace/);
  assert.match(html, /@media\(max-width:720px\)\{\s*\.fact-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(html, /\.evidence-card > \.result-chips \{ justify-self: start; \}/);
  assert.match(html, /#localRepoResult \.status \{ max-width: 100%; white-space: normal; overflow-wrap: anywhere; line-height: 1\.3; \}/);
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const resultBlock = style.match(/\/\* Local result page[\s\S]*?\/\* Zapier/);
  assert.ok(resultBlock, 'the adapted result style block exists');
  const owned = new Set();
  for (const match of resultBlock[0].matchAll(/(?:^|})\s*([^{}]+)\{/g)) {
    for (const compound of match[1].split(',')) {
      const leading = compound.trim().match(/^\.([A-Za-z][\w-]*)/);
      if (leading) owned.add(leading[1]);
    }
  }
  const restOfPage = style.replace(resultBlock[0], '');
  const collisions = [...owned].filter((name) => name !== 'status' && name !== 'mono' && new RegExp(`\\.${name}(?![\\w-])`).test(restOfPage));
  assert.deepEqual(collisions, [], 'adapted result classes do not collide with landing styles');
  const script = (html.match(/<script>[\s\S]*?<\/script>/g) || []).join('\n');
  const unused = [...owned].filter((name) => !new RegExp(`class="[^"]*\\b${name}\\b`).test(script));
  assert.deepEqual(unused, [], 'every adapted result class is actually rendered');
});

test('completed limited check stays LIMITED with Unconfirmed hypothesis and scope', () => {
  const markup = render({
    status: 'Completed',
    execution: execution(0),
    finding: {
      title: 'Model claim', severity: 'high', description: 'opinion', evidence: { file: 'README.md' },
      assessment: { findingState: 'Unconfirmed', scope: 'limited-check: tracked README — not a test suite, not security verification', reason: 'single check' },
    },
  });
  assert.match(markup, /Completed limited check/);
  assert.match(markup, /Model hypothesis.*Unconfirmed/);
  assert.match(markup, /Executed check/);
  assert.match(markup, /not a test suite/);
  assert.match(markup, /single check/);
  assert.doesNotMatch(markup, /One real base API call/);
  assert.match(markup, /Base model|missing/);
});

test('strict repair gate never loosens for non-executed or ambiguous runs', () => {
  for (const extra of [{}, { execution: { ...execution(null), status: 'Incomplete' } }, { execution: { ...execution(1), sandbox: { started: false } } }, { execution: { ...execution(1), timedOut: true } }, { execution: { ...execution(1), aborted: true } }, { execution: { ...execution(1), executed: false } }]) {
    assert.doesNotMatch(render(extra), /data-action="repair-local-audit"|data-action="create-local-pr"/);
  }
  const markup = render({ execution: execution(1) });
  assert.match(markup, /data-action="repair-local-audit"/);
  assert.doesNotMatch(markup, /data-action="create-local-pr"/);
  assert.doesNotMatch(render({ execution: execution(0) }), /data-action="repair-local-audit"|data-action="create-local-pr"/);
  assert.match(render({ execution: execution(1), repair: { verdict: 'VerifiedRepair', before: { exitCode: 1 }, after: { exitCode: 0 }, originalUnchanged: true } }), /data-action="create-local-pr"/);
});

test('verified repair shows full hashes, verified base, exits, unchanged, coverage and bounded diff', () => {
  const beforeHash = 'b'.repeat(64);
  const afterHash = 'c'.repeat(64);
  const base = 'a'.repeat(40);
  const diff = `--- a/broken.js\n+++ b/broken.js\n${'x'.repeat(5000)}`;
  const markup = render({
    execution: execution(1),
    repair: {
      verdict: 'VerifiedRepair', before: { exitCode: 1 }, after: { exitCode: 0 },
      originalUnchanged: true, verifiedBaseCommitSha: base,
      coverage: { label: 'SAME-COMMAND REPLAY / limited coverage' },
      verifiedTarget: { command: 'node --check broken.js', exitCode: 0 },
      changedFiles: [{ path: 'broken.js', beforeHash, afterHash }],
      diff,
    },
  });
  assert.match(markup, new RegExp(beforeHash));
  assert.match(markup, new RegExp(afterHash));
  assert.match(markup, /bbbbbbbbbbbb/);
  assert.match(markup, /cccccccccccc/);
  assert.match(markup, new RegExp(base));
  assert.match(markup, /Verified target:/);
  assert.match(markup, /node --check broken\.js/);
  assert.match(markup, /Original unchanged: yes/);
  assert.match(markup, /SAME-COMMAND REPLAY/);
  assert.match(markup, /<details><summary>Diff ·/);
  assert.match(markup, /\.\.\.\[truncated\]/);
  assert.match(markup, /Review proof first/);
});

test('generic regressions without a coverage label are never assumed SAME-COMMAND', () => {
  const markup = render({
    execution: execution(1),
    repair: {
      verdict: 'VerifiedRepair', before: { exitCode: 1 }, after: { exitCode: 0 },
      originalUnchanged: true, regressions: [{ name: 'other-check' }],
      verifiedTarget: { command: 'node --check broken.js', exitCode: 0 },
      changedFiles: [],
    },
  });
  assert.doesNotMatch(markup, /SAME-COMMAND REPLAY/);
  assert.match(markup, /coverage Not reported \(not assumed SAME-COMMAND\)/);
});

test('proof keeps full hashes, Present/Missing labels and download only when Present', () => {
  const manifestHash = 'a'.repeat(64);
  const artifactHash = 'b'.repeat(64);
  const markup = render({
    execution: execution(0),
    proof: {
      manifest: { id: 'proof:x:manifest', sha256: manifestHash },
      artifacts: [
        { name: 'run', status: 'Present', path: 'run.json', sha256: artifactHash },
        { name: 'repair-diff', status: 'Missing', reason: 'no repair' },
      ],
    },
  });
  assert.match(markup, new RegExp(manifestHash));
  assert.match(markup, new RegExp(artifactHash));
  assert.match(markup, /SHA-256/);
  assert.match(markup, /Download run/);
  assert.match(markup, /Missing<\/span> repair-diff/);
  assert.doesNotMatch(markup, /Download repair-diff/);
  const incomplete = render({ execution: execution(0), proof: { status: 'Incomplete', error: 'bundle unavailable' } });
  assert.match(incomplete, /localProofArtifacts/);
  assert.match(incomplete, /Incomplete: bundle unavailable/);
});

test('unknown sandbox facts stay Not reported, never no or green', () => {
  const missing = render({ execution: { ...execution(0), sandbox: { name: 'x' } } });
  assert.match(missing, /status Not reported/);
  assert.match(missing, /Cleanup Not reported/);
  assert.match(missing, /<dt>privileged<\/dt><dd>Not reported<\/dd>/);
  assert.doesNotMatch(missing, /<dd>undefined<\/dd>/);
  const started = render({ execution: execution(0) });
  assert.match(started, /Docker sandbox started/);
  assert.match(started, /Removed after execution/);
  assert.match(started, /<dt>privileged<\/dt><dd>no<\/dd>/);
});

test('execution card names its server-owned source marker', () => {
  const markup = render({ execution: execution(0) });
  assert.match(markup, /id="localExecutionSource"/);
  assert.match(markup, /Source:.*pnpm script: check/);
});

test('stdout, stderr and browser rows stay collapsed with counts', () => {
  const markup = render({
    execution: { ...execution(0), stdout: 'a\nb', stderr: 'e' },
    browser: { status: 'Completed', target: 'fixture', screenshotRefs: [], consoleErrors: [{ text: 't' }], networkEvidence: [{ url: 'http://x.test/' }], cleanup: {} },
  });
  assert.match(markup, /<details><summary>stdout · 3 chars · 2 lines/);
  assert.match(markup, /<details><summary>stderr · 1 chars · 1 lines/);
  assert.match(markup, /<details><summary>Console rows \(1\)/);
  assert.match(markup, /<details><summary>Network rows \(1\)/);
  assert.doesNotMatch(markup, /<details open/);
});

test('browser keeps fixture scope with real CDP values and explicit truncation', () => {
  const fields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`unknown-${i}`, 'a']));
  const markup = render({
    execution: execution(0),
    browser: {
      status: 'Completed', target: 'fixture', screenshotRefs: ['/api/local/audits/x/browser/screenshot'],
      consoleErrors: [
        { method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'Observed favicon failure', url: 'http://fixture.test/favicon.ico' } } },
        { method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ value: 'Observed runtime error' }], stackTrace: { callFrames: [{ url: 'http://fixture.test/app.js' }] } } },
        fields,
      ],
      networkEvidence: [{ params: { response: { status: 404, url: 'http://127.0.0.1/app' } } }, { method: 'GET' }],
      cleanup: { browserClosed: true, profileRemoved: false },
      assertion: { expected: 'Purchased', observed: 'Purchased', passed: true },
    },
  });
  assert.match(markup, /not verification of the cloned application/);
  assert.match(markup, /Open server screenshot \(fixture scope only\)/);
  assert.match(markup, /Observed favicon failure/);
  assert.match(markup, /Observed runtime error/);
  assert.match(markup, /http:\/\/fixture.test\/app\.js/);
  assert.match(markup, /Status: 404/);
  assert.match(markup, /http:\/\/127\.0\.0\.1\/app/);
  assert.match(markup, /Click assertion: expected Purchased · observed Purchased · Passed/);
  assert.match(markup, /\.\.\.\[truncated\]/);
  assert.match(markup, /browserClosed/);
  assert.match(markup, /profileRemoved/);
  assert.match(markup, /fixtureStopped/);
});

test('stages keep name and status text with duration detail', () => {
  const markup = render({ stages: { clone: { status: 'Completed', detail: '12 tracked files', durationMs: 900 }, cleanup: { status: 'Completed' } } });
  assert.match(markup, /<ol id="localAuditStages"/);
  assert.match(markup, /clone: Completed/);
  assert.match(markup, /12 tracked files · 900 ms/);
  assert.match(markup, /cleanup: Completed/);
});

test('evidence never reaches the page unescaped', () => {
  const markup = render({ execution: execution(0), finding: { title: '<img src=x onerror=alert(1)>', severity: 'high', description: '<script>alert(2)</script>', evidence: { file: 'README.md' } } });
  assert.doesNotMatch(markup, /<img src=x/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;img/);
});

test('hypothesis, scope, replay, exact hashes and strict guard render together', () => {
  const beforeHash = 'd'.repeat(64);
  const afterHash = 'e'.repeat(64);
  const markup = render({
    status: 'Incomplete',
    repository: { fullName: 'owner/repo', commit: 'f'.repeat(40) },
    files: { count: 7 },
    model: { provider: 'xkiro', model: 'm' },
    durationMs: 42,
    execution: execution(1),
    finding: {
      title: 'Model claim', severity: 'high', description: 'opinion', evidence: { file: 'README.md' },
      assessment: { findingState: 'Unconfirmed', scope: 'limited-check: tracked README — not a test suite', reason: 'single bounded command' },
    },
    repair: {
      verdict: 'VerifiedRepair', before: { exitCode: 1 }, after: { exitCode: 0 },
      originalUnchanged: true, verifiedBaseCommitSha: 'a'.repeat(40),
      coverage: { label: 'SAME-COMMAND REPLAY / limited coverage' },
      verifiedTarget: { command: 'node --check broken.js', exitCode: 0 },
      changedFiles: [{ path: 'broken.js', beforeHash, afterHash }],
      diff: '--- a\n+++ b',
    },
    proof: { manifest: { id: 'proof:unit-ui:manifest', sha256: 'a'.repeat(64) }, artifacts: [{ name: 'run', status: 'Present', path: 'run.json', sha256: 'b'.repeat(64) }] },
  });
  assert.match(markup, /Model hypothesis.*Unconfirmed/);
  assert.match(markup, /limited-check: tracked README/);
  assert.match(markup, /Verified target:/);
  assert.match(markup, /node --check broken\.js/);
  assert.match(markup, new RegExp(beforeHash));
  assert.match(markup, new RegExp(afterHash));
  assert.match(markup, /data-action="create-local-pr"/);
  assert.match(markup, /Download run/);
  assert.match(markup, /Completed limited check|Incomplete/);
});
