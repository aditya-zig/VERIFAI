import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
const body = html.match(/function renderMasterAudit\(run, host\) \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(body, 'master renderer exists');

function render(extra = {}) {
  const host = { innerHTML: '', querySelector: () => null };
  vm.runInNewContext(`function renderMasterAudit(run,host){${body}\n}\nrenderMasterAudit(run,host);`, {
    run: { id: 'unit-ui', status: 'Incomplete', stages: {}, ...extra }, host, escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  });
  return host.innerHTML;
}
function execution(exitCode) {
  return { exitCode, status: exitCode === 0 ? 'Completed' : 'Failed', command: 'node --check broken.js', source: 'fixture', durationMs: 3, stdout: 'out', stderr: 'err', sandbox: { started: true, removed: true, name: 'unit-fixture', memoryBytes: 1073741824, nanoCpus: 2000000000, privileged: false } };
}

test('missing or unexecuted command never offers repair or Create PR', () => {
  for (const extra of [{}, { execution: { ...execution(null), status: 'Incomplete' } }, { execution: { ...execution(1), sandbox: { started: false } } }]) {
    assert.doesNotMatch(render(extra), /data-action="repair-local-audit"|data-action="create-local-pr"/);
  }
});

test('nonzero executed-shaped evidence offers deliberate patch verification, not PR', () => {
  const markup = render({ execution: execution(1) });
  assert.match(markup, /data-action="repair-local-audit"/);
  assert.doesNotMatch(markup, /data-action="create-local-pr"/);
});

test('only VerifiedRepair exposes the explicit human Create PR control', () => {
  assert.match(render({ execution: execution(1), repair: { verdict: 'VerifiedRepair', before: { exitCode: 1 }, after: { exitCode: 0 } } }), /data-action="create-local-pr"/);
  assert.doesNotMatch(render({ execution: execution(0) }), /data-action="repair-local-audit"|data-action="create-local-pr"/);
});

test('compact summary names status, id, commit, files, model and duration', () => {
  const markup = render({ status: 'Completed', repository: { fullName: 'owner/repo', commit: 'abc123' }, files: { count: 7 }, model: { provider: 'xkiro', model: 'm' }, durationMs: 42, execution: execution(0) });
  assert.match(markup, /Completed limited check/);
  assert.match(markup, /unit-ui/);
  assert.match(markup, /abc123/);
  assert.match(markup, /Tracked files/);
  assert.match(markup, /xkiro/);
  assert.match(markup, /42 ms/);
});

test('model hypothesis stays Unconfirmed and distinct from executed evidence', () => {
  const markup = render({ execution: execution(0), finding: { title: 'Model claim', severity: 'high', description: 'opinion', evidence: { file: 'README.md' }, assessment: { findingState: 'Unconfirmed', scope: 'limited-check: tracked README — not a test suite, not security verification', reason: 'single check' } } });
  assert.match(markup, /Model hypothesis.*Unconfirmed/);
  assert.match(markup, /Executed check/);
  assert.match(markup, /not a test suite/);
});

test('stdout and stderr show bounded labelled blocks with counts', () => {
  const markup = render({ execution: { ...execution(0), stdout: 'a\nb', stderr: 'e' } });
  assert.match(markup, /stdout.*3 chars.*2 lines/);
  assert.match(markup, /stderr.*1 chars.*1 lines/);
});

test('cleanup names missing fields explicitly', () => {
  const markup = render({ execution: execution(0), cleanup: { repositoryRemoved: true } });
  assert.match(markup, /repositoryRemoved/);
  assert.match(markup, /sandboxRemoved/);
  assert.match(markup, /missing/);
});

test('artifacts label Present and Missing with hash and download only when Present', () => {
  const markup = render({ execution: execution(0), proof: { manifest: { id: 'proof:x:manifest', sha256: 'a'.repeat(64) }, artifacts: [{ name: 'run', status: 'Present', path: 'run.json', sha256: 'b'.repeat(64) }, { name: 'repair-diff', status: 'Missing', reason: 'no repair' }] } });
  assert.match(markup, /SHA-256/);
  assert.match(markup, new RegExp('b'.repeat(64)));
  assert.match(markup, /Download run/);
  assert.match(markup, /repair-diff.*Missing/);
  assert.doesNotMatch(markup, /Download repair-diff/);
});

test('browser keeps fixture scope and expandable console and network rows', () => {
  const markup = render({ execution: execution(0), browser: { status: 'Completed', target: 'Local integration fixture; not verification of the cloned application', screenshotRefs: ['/api/local/audits/x/browser/screenshot'], consoleErrors: [{ unknownKey: 'kept' }], networkEvidence: [{ url: 'http://example.test/very/long/path', unknownRow: 1 }] } });
  assert.match(markup, /fixture only/i);
  assert.match(markup, /not verification of the cloned application/);
  assert.match(markup, /Open server screenshot/);
  assert.match(markup, /Console rows \(1\)/);
  assert.match(markup, /Network rows \(1\)/);
  assert.match(markup, /unknownKey/);
  assert.match(markup, /unknownRow/);
});

test('escaping blocks markup injection', () => {
  const markup = render({ execution: execution(0), finding: { title: '<img src=x onerror=alert(1)>', severity: 'high', description: '<script>alert(2)</script>', evidence: { file: 'README.md' } } });
  assert.doesNotMatch(markup, /<img src=x/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;img/);
});

test('long commands, urls and hashes wrap without overflow CSS', () => {
  assert.match(html, /overflow-wrap:\s*anywhere/);
  assert.match(html, /max-width:\s*100%/);
  const longCommand = `node --check ${'a'.repeat(300)}.js`;
  const markup = render({ execution: { ...execution(0), command: longCommand } });
  assert.match(markup, /wrap-anywhere/);
});
