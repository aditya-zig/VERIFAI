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
  assert.match(markup, /Missing<\/span> repair-diff/);
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

test('contradictory execution evidence never exposes repair controls', () => {
  for (const extra of [{timedOut:true}, {aborted:true}, {executed:false}]) {
    assert.doesNotMatch(render({execution:{...execution(1),...extra}}), /data-action="repair-local-audit"/);
  }
});

test('raw CDP console rows display their real text, level and location', () => {
  const markup=render({browser:{status:'Completed',consoleErrors:[
    {method:'Log.entryAdded',params:{entry:{level:'error',text:'Observed favicon failure',url:'http://fixture.test/favicon.ico'}}},
    {method:'Runtime.consoleAPICalled',params:{type:'error',args:[{value:'Observed runtime error'}],stackTrace:{callFrames:[{url:'http://fixture.test/app.js'}]}}},
  ]}});
  assert.match(markup,/Observed favicon failure/);
  assert.match(markup,/Observed runtime error/);
  assert.match(markup,/http:\/\/fixture.test\/app.js/);
  assert.doesNotMatch(markup,/Missing text/);
});

test('browser failures state the actual reason and null diagnostic rows stay readable',()=>{
  const markup=render({browser:{status:'Incomplete',error:'click assertion timed out',networkEvidence:[null]}});
  assert.match(markup,/click assertion timed out/);
  assert.match(markup,/Status: not-reported/);
});

test('pretty diagnostic truncation is explicitly disclosed even when compact JSON is shorter',()=>{
  const fields=Object.fromEntries(Array.from({length:100},(_,i)=>[`unknown-${i}`,'a']));
  assert.ok(JSON.stringify(fields).length<2000);
  assert.ok(JSON.stringify(fields,null,2).length>2000);
  const markup=render({browser:{status:'Completed',consoleErrors:[fields],networkEvidence:[fields]}});
  assert.equal((markup.match(/\.\.\.\[truncated\]/g)||[]).length,2);
});

test('long commands, urls and hashes wrap without overflow CSS', () => {
  assert.match(html, /overflow-wrap:\s*anywhere/);
  assert.match(html, /max-width:\s*100%/);
  const longCommand = `node --check ${'a'.repeat(300)}.js`;
  const markup = render({ execution: { ...execution(0), command: longCommand } });
  assert.match(markup, /wrap-anywhere/);
});

test('network rows surface nested observed status and Missing URL explicitly', () => {
  const markup = render({ execution: execution(0), browser: { status: 'Completed', target: 'Local integration fixture; not verification of the cloned application', screenshotRefs: [], consoleErrors: [], networkEvidence: [{ params: { response: { status: 200, url: 'http://127.0.0.1/app' } } }, { method: 'GET' }], cleanup: {} } });
  assert.match(markup, /Status: 200/);
  assert.match(markup, /http:\/\/127\.0\.0\.1\/app/);
  assert.match(markup, /Missing/);
  assert.match(markup, /not-reported/);
});

test('console rows show escaped text and location with unknown fields expandable', () => {
  const markup = render({ execution: execution(0), browser: { status: 'Completed', target: 'fixture', screenshotRefs: [], consoleErrors: [{ method: 'console.error', level: 'error', text: '<b>boom</b>', url: 'http://127.0.0.1/app.js', traceId: 'abc' }], networkEvidence: [], cleanup: {} } });
  assert.match(markup, /&lt;b&gt;boom&lt;\/b&gt;/);
  assert.match(markup, /http:\/\/127\.0\.0\.1\/app\.js/);
  assert.match(markup, /traceId/);
  assert.match(markup, /full fields/);
});

test('browser row overflow is bounded with explicit count notices', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ text: `msg ${i}`, url: 'http://x.test/' }));
  const markup = render({ execution: execution(0), browser: { status: 'Completed', target: 'fixture', screenshotRefs: [], consoleErrors: rows, networkEvidence: [], cleanup: {} } });
  assert.match(markup, /Console rows \(25\)/);
  assert.match(markup, /5 more console rows not shown \(showing 20 of 25\)/);
  assert.doesNotMatch(markup, /msg 24/);
});

test('browser cleanup names each flag and click assertion shows fixture scope', () => {
  const markup = render({ execution: execution(0), browser: { status: 'Completed', target: 'fixture', screenshotRefs: ['/api/local/audits/x/browser/screenshot'], consoleErrors: [], networkEvidence: [], cleanup: { browserClosed: true, profileRemoved: false }, assertion: { expected: 'Purchased', observed: 'Purchased', passed: true } } });
  assert.match(markup, /browserClosed/);
  assert.match(markup, /profileRemoved/);
  assert.match(markup, /fixtureStopped/);
  assert.match(markup, /missing/);
  assert.match(markup, /Click assertion: expected Purchased · observed Purchased · Passed/);
  assert.match(markup, /not verification of the cloned application/);
  assert.match(markup, /Open server screenshot \(fixture scope only\)/);
});

test('proof card restores manifest metadata with status badges', () => {
  const markup = render({ execution: execution(0), proof: { manifest: { id: 'proof:x:manifest', sha256: 'a'.repeat(64) }, artifacts: [{ name: 'run', status: 'Present', path: 'run.json', sha256: 'b'.repeat(64) }, { name: 'repair-diff', status: 'Missing', reason: 'no repair' }] } });
  assert.match(markup, /proof:x:manifest/);
  assert.match(markup, new RegExp('a'.repeat(64)));
  assert.match(markup, /Partial/);
  assert.match(markup, /Present<\/span> run/);
  assert.match(markup, /Missing<\/span> repair-diff/);
});

test('incomplete proof errors render explicitly instead of vanishing', () => {
  const markup = render({ execution: execution(0), proof: { status: 'Incomplete', error: 'bundle unavailable' } });
  assert.match(markup, /localProofArtifacts/);
  assert.match(markup, /Incomplete: bundle unavailable/);
});

test('stdout, stderr and browser rows default to collapsed details', () => {
  const markup = render({ execution: execution(0), browser: { status: 'Completed', target: 'fixture', screenshotRefs: [], consoleErrors: [{ text: 't' }], networkEvidence: [{ url: 'http://x.test/' }], cleanup: {} } });
  assert.match(markup, /<details><summary>stdout/);
  assert.match(markup, /<details><summary>stderr/);
  assert.match(markup, /<details><summary>Console rows/);
  assert.match(markup, /<details><summary>Network rows/);
  assert.doesNotMatch(markup, /<details open/);
});

test('command renders in a bounded scroll and wrap block', () => {
  const markup = render({ execution: execution(0) });
  assert.match(markup, /<pre class="local-log-block wrap-anywhere"[^>]*><code class="wrap-anywhere">node --check broken\.js<\/code><\/pre>/);
});

test('fixture browser path consumes the server record without a second raw dump', () => {
  const fn = html.match(/async function runFixtureBrowser\(button\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(fn, 'fixture browser flow exists');
  assert.doesNotMatch(fn, /JSON\.stringify\(result\.consoleErrors/);
  assert.doesNotMatch(fn, /JSON\.stringify\(result\.networkEvidence/);
  assert.doesNotMatch(fn, /JSON\.stringify\(result\.cleanup/);
  assert.match(fn, /renderMasterAudit/);
  assert.match(fn, /localBrowserStatus/);
});
