import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in the result page`);
  const from = html.slice(Math.max(0, start - 6), start).endsWith('async ') ? start - 6 : start;
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    const char = html[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(from, index + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const HELPERS = [
  'escapeHtml', 'resultTone', 'factTone', 'resultBadge', 'chip', 'monoChip',
  'fact', 'factGrid', 'evidenceCard', 'codeLine', 'stream', 'jsonBlock',
  'extras', 'evidenceRows', 'stageRows', 'cleanupGrid', 'actionRows',
  'consoleErrorRows', 'networkRows', 'artifactList', 'proofSummary', 'proofBadge',
  'browserEvidenceBody', 'executionEvidenceCard', 'renderMasterAudit',
  'runFixtureBrowser', 'renderLocalFinding',
];

const EXPORTS = 'renderMasterAudit, runFixtureBrowser, renderLocalFinding, browserEvidenceBody, cleanupGrid, consoleErrorRows, networkRows, artifactList, proofSummary, proofBadge, stream, executionEvidenceCard';
const sandboxSource = `(() => {\n${HELPERS.map(functionSource).join('\n\n')}\nreturn {${EXPORTS}};\n})()`;

function buildContext(extra = {}) {
  return vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    document: {getElementById: () => null},
    ...extra,
  });
}

function callHelpers(extra = {}) {
  return vm.runInContext(sandboxSource, buildContext(extra));
}

function render(run, extra = {}) {
  const helpers = callHelpers(extra);
  const host = {innerHTML: '', querySelector: () => null};
  helpers.renderMasterAudit(run, host);
  return host.innerHTML;
}

function executed(exitCode) {
  return {
    exitCode,
    status: exitCode === 0 ? 'Completed' : 'Failed',
    command: 'node --check broken.js',
    source: 'pnpm script: check',
    durationMs: 12,
    stdout: 'checked ok\n',
    stderr: exitCode === 0 ? '' : 'SyntaxError: Unexpected end of input',
    sandbox: {
      engine: 'docker', name: 'verifai-audit-1', started: true, removed: true,
      memoryBytes: 1073741824, nanoCpus: 2000000000, privileged: false, network: 'none',
    },
  };
}

function baseRun(extra = {}) {
  return {
    id: 'ui-run', status: 'Incomplete', stages: {}, repository: {fullName: 'owner/repo', commit: 'a'.repeat(40)},
    files: {count: 12}, cleanup: {repositoryRemoved: true, sandboxRemoved: true}, ...extra,
  };
}

test('summary card leads the result page with badges and identifiers', () => {
  const markup = render(baseRun({
    status: 'Completed', durationMs: 4210,
    model: {provider: 'openai', model: 'gpt-x'},
  }));
  assert.match(markup, /class="result-root"/);
  assert.match(markup, /owner\/repo/);
  assert.match(markup, /<span id="localAuditStatus" class="status verified">Completed limited check<\/span>/);
  assert.match(markup, /<b>ui-run<\/b>/);
  assert.match(markup, /<b>12<\/b>/);
  assert.match(markup, /openai \/ gpt-x/);
  assert.match(markup, /4210 ms/);
});

test('Incomplete and Failed runs are visually distinct from Completed', () => {
  assert.match(render(baseRun({status: 'Incomplete'})), /class="status failed">Incomplete</);
  assert.match(render(baseRun({status: 'Failed'})), /class="status failed">Failed</);
  assert.match(render(baseRun({status: 'Running'})), /class="status running">Running</);
  assert.match(render(baseRun({status: 'Completed'})), /class="status verified">Completed limited check</);
});

test('VerifiedRepair is called out beside the run status once the server owns that verdict', () => {
  const markup = render(baseRun({status: 'Incomplete', execution: executed(1), repair: {verdict: 'VerifiedRepair', before: {exitCode: 1}, after: {exitCode: 0}, originalUnchanged: true}}));
  assert.match(markup, /<span id="localAuditStatus" class="status failed">Incomplete<\/span>/);
  assert.match(markup, /<span class="status verified">Repair VerifiedRepair<\/span>/);
  assert.match(markup, /<dt>verified base commit<\/dt>/);
  assert.match(markup, /Review the proof first\. PR creation is a separate explicit human action/);
});

test('command and exit code render as a scrollable code line plus a fact grid', () => {
  const markup = render(baseRun({execution: executed(1)}));
  assert.match(markup, /<section id="localExecutionEvidence" class="card pad section evidence-card">/);
  assert.match(markup, /<pre class="code-line">node --check broken\.js<\/pre>/);
  assert.match(markup, /<dt>exit code<\/dt><dd class="mono">1<\/dd>/);
  assert.match(markup, /<dt>removed after run<\/dt><dd>yes<\/dd>/);
  assert.match(markup, /container<\/dt><dd class="mono">verifai-audit-1/);
});

test('stdout and stderr keep their full text inside labelled wrapping blocks', () => {
  const long = 'x'.repeat(400);
  const stderr = `${long}\nsecond line`;
  const markup = render(baseRun({execution: {...executed(1), stdout: long, stderr}}));
  assert.match(markup, /<span>stdout<\/span>/);
  assert.match(markup, /<span>stderr<\/span>/);
  assert.ok(markup.includes(long), 'stdout text is not truncated');
  assert.ok(markup.includes(stderr), 'stderr text is not truncated');
  assert.match(markup, /400 chars/);
  assert.match(markup, /412 chars/);
});

test('stages become per-stage fact cells with detail and duration', () => {
  const markup = render(baseRun({stages: {
    clone: {status: 'Completed', detail: '12 tracked files cloned', durationMs: 900},
    execution: {status: 'Failed', detail: 'Exit 1', durationMs: 40},
  }}));
  assert.match(markup, /<dt>clone<\/dt>\s*<dd>Completed<\/dd>/);
  assert.match(markup, /12 tracked files cloned · 900 ms/);
  assert.match(markup, /<dt>execution<\/dt>\s*<dd>Failed<\/dd>/);
  assert.doesNotMatch(markup, /<ol|<li>/, 'no bare stage list remains');
});

test('run cleanup renders as readable booleans and never as a raw blob', () => {
  const {cleanupGrid} = callHelpers();
  const markup = cleanupGrid({repositoryRemoved: true, sandboxRemoved: false, extraKey: 'kept'});
  assert.match(markup, /<dt>repository removed<\/dt><dd class="mono">true<\/dd>/);
  assert.match(markup, /<dt>sandbox removed<\/dt><dd class="mono">false<\/dd>/);
  assert.match(markup, /<dt>extra key<\/dt>/);
  assert.doesNotMatch(markup, /\{"/, 'cleanup is not a JSON blob');
  assert.match(cleanupGrid(undefined), /unproven/);
});

test('browser cleanup booleans and assertion render as structured evidence', () => {
  const {browserEvidenceBody} = callHelpers();
  const markup = browserEvidenceBody({
    status: 'Completed', durationMs: 1056, journeyId: 'browser-1',
    startUrl: 'http://127.0.0.1:36223/', finalUrl: 'http://127.0.0.1:36223/#done',
    assertion: {expected: 'Action completed', observed: 'Action completed', passed: true},
    cleanup: {browserClosed: true, profileRemoved: true, fixtureStopped: true},
    actions: [{action: 'open-fixture', url: 'http://127.0.0.1:36223/'}, {action: 'assert-visible-text', expected: 'Action completed', observed: 'Action completed', passed: true}],
    consoleErrors: [{text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', url: 'http://127.0.0.1:36223/missing'}],
    networkEvidence: [{url: 'http://127.0.0.1:36223/', method: 'GET', status: 200}],
    screenshotRefs: ['/api/local/audits/ui-run/browser/screenshot'],
  }, 'ui-run');
  assert.match(markup, /<dt>browser closed<\/dt><dd class="mono">true<\/dd>/);
  assert.match(markup, /<dt>profile removed<\/dt><dd class="mono">true<\/dd>/);
  assert.match(markup, /<dt>fixture stopped<\/dt><dd class="mono">true<\/dd>/);
  assert.match(markup, /<dt>assertion<\/dt><dd>passed<\/dd>/);
  assert.match(markup, /<dt>expected<\/dt><dd>Action completed<\/dd>/);
  assert.match(markup, /<span class="row-value">open-fixture<\/span>/);
  assert.match(markup, /<span class="row-value">assert-visible-text<\/span>/);
  assert.match(markup, /<span class="row-value">http:\/\/127\.0\.0\.1:36223\/<\/span>/);
  assert.match(markup, /<span class="row-value">Failed to load resource: the server responded with a status of 404 \(Not Found\)<\/span>/);
  assert.match(markup, /<span class="row-sub">http:\/\/127\.0\.0\.1:36223\/missing<\/span>/);
  assert.match(markup, /GET 200/);
  assert.match(markup, /id="localBrowserScreenshot"/);
  assert.doesNotMatch(markup, /\[\{"|\[\{"url"/, 'console and network evidence are not raw JSON arrays');
});

test('a 404 network entry is badged as Failed and a missing console list says so plainly', () => {
  const {consoleErrorRows, networkRows} = callHelpers();
  assert.match(networkRows([{url: 'http://x/', status: 404}]), /class="status failed">404<\/span>/);
  assert.match(networkRows([{url: 'http://x/', status: 200}]), /class="status verified">200<\/span>/);
  assert.match(networkRows([{url: 'http://x/'}]), /status missing/);
  assert.match(consoleErrorRows([]), /None recorded/);
  assert.match(networkRows([{url: 'http://x/', status: 200, fromCache: true}]), /&quot;fromCache&quot;: true/);
});

test('unrecognised evidence keys still surface as formatted JSON', () => {
  const {consoleErrorRows} = callHelpers();
  const markup = consoleErrorRows([{text: 'boom', url: 'http://x/', stack: 'a\nb', attempt: 2}]);
  assert.match(markup, /<pre class="json-block">/);
  assert.match(markup, /&quot;stack&quot;: &quot;a\\nb&quot;/);
  assert.match(markup, /&quot;attempt&quot;: 2/);
});

test('proof artifacts are listed with status, path, hash and download links', () => {
  const {artifactList, proofSummary, proofBadge} = callHelpers();
  const proof = {
    manifest: {id: 'proof:ui-run:manifest', sha256: 'b'.repeat(64)},
    totalBytes: 2048,
    artifacts: [
      {name: 'run', status: 'Present', path: 'run.json', sha256: 'c'.repeat(64)},
      {name: 'screenshots', status: 'Missing', reason: 'browser screenshot evidence not present'},
    ],
  };
  const markup = artifactList(proof, 'ui-run');
  assert.match(markup, /class="status verified">Present<\/span>/);
  assert.match(markup, /class="status failed">Missing<\/span>/);
  assert.match(markup, /href="\/api\/local\/audits\/ui-run\/artifacts\/run\.json"/);
  assert.match(markup, /browser screenshot evidence not present/);
  const missingRow = markup.split('</li>').find(row => row.includes('Missing'));
  assert.doesNotMatch(missingRow, /<a /, 'a missing artifact is never offered as a download');
  const summary = proofSummary(proof);
  assert.match(summary, /<div class="fact good"><dt>artifacts present<\/dt><dd>1<\/dd><\/div>/);
  assert.match(summary, /<div class="fact bad"><dt>artifacts missing<\/dt><dd>1<\/dd><\/div>/);
  assert.match(proofSummary({}), /manifest is missing/);
  assert.match(proofBadge(proof), /class="status failed">1 missing<\/span>/);
  assert.match(proofBadge({manifest: {id: 'm'}, artifacts: [{status: 'Present'}]}), /class="status verified">All present<\/span>/);
  assert.match(proofBadge({}), /class="status failed">No manifest<\/span>/);
});

test('hash chips keep their label so a digest is never a bare value', () => {
  const {artifactList} = callHelpers();
  const markup = artifactList({artifacts: [{name: 'run', status: 'Present', path: 'run.json', sha256: 'c'.repeat(64)}]}, 'ui-run');
  assert.match(markup, /<span class="chip mono">sha256 <b>cccccccccccccccc<\/b><\/span>/);
});

test('server-owned browser evidence survives a re-render of the audit', () => {
  const markup = render(baseRun({status: 'Completed', browser: {status: 'Completed', journeyId: 'browser-9', cleanup: {browserClosed: true, profileRemoved: true, fixtureStopped: true}, assertion: {expected: 'Action completed', observed: 'Action completed', passed: true}, consoleErrors: [], networkEvidence: [], screenshotRefs: ['/api/local/audits/ui-run/browser/screenshot']}}));
  assert.match(markup, /id="localBrowserJourney"/);
  assert.match(markup, /<dt>journey id<\/dt><dd class="mono">browser-9<\/dd>/);
  assert.match(markup, /id="localBrowserScreenshot"/);
});

test('evidence never reaches the page unescaped', () => {
  const markup = render(baseRun({
    error: '<img src=x onerror=alert(1)>', failedStage: 'execution',
    execution: {...executed(1), stdout: '<script>alert(1)</script>'},
  }));
  assert.doesNotMatch(markup, /<img src=x/);
  assert.doesNotMatch(markup, /<script>alert\(1\)<\/script>/);
  assert.match(markup, /&lt;img src=x/);
});

test('the incomplete-check safety message stays on the page', () => {
  const markup = render(baseRun({status: 'Completed'}));
  assert.match(markup, /A completed limited check is not a full test-suite or security verification\. Cleanup is automatic\./);
  assert.match(markup, /class="evidence-note safety"/);
});

test('missing or unexecuted command never offers repair or Create PR', () => {
  for (const extra of [{}, {execution: {...executed(null), status: 'Incomplete'}}]) {
    assert.doesNotMatch(render(baseRun(extra)), /data-action="repair-local-audit"|data-action="create-local-pr"/);
  }
  assert.doesNotMatch(render(baseRun({execution: executed(0)})), /data-action="repair-local-audit"|data-action="create-local-pr"/);
});

test('nonzero executed-shaped evidence offers patch verification, not PR', () => {
  const markup = render(baseRun({execution: executed(1)}));
  assert.match(markup, /data-action="repair-local-audit"/);
  assert.doesNotMatch(markup, /data-action="create-local-pr"/);
});

test('only VerifiedRepair exposes the explicit human Create PR control', () => {
  const markup = render(baseRun({execution: executed(1), repair: {verdict: 'VerifiedRepair', before: {exitCode: 1}, after: {exitCode: 0}, originalUnchanged: true}}));
  assert.match(markup, /data-action="create-local-pr"/);
  assert.match(markup, /Review the proof first\. PR creation is a separate explicit human action/);
  assert.doesNotMatch(render(baseRun({execution: executed(1), repair: {verdict: 'RejectedRepair'}})), /data-action="create-local-pr"/);
});

test('the fixture browser control only appears for a Completed run', () => {
  assert.match(render(baseRun({status: 'Completed'})), /data-action="run-fixture-browser"/);
  assert.doesNotMatch(render(baseRun({status: 'Incomplete'})), /data-action="run-fixture-browser"/);
});

test('runFixtureBrowser renders the journey with structured evidence, not a JSON dump', async () => {
  const result = {
    status: 'Completed', durationMs: 1056, journeyId: 'browser-2',
    startUrl: 'http://127.0.0.1:1/', finalUrl: 'http://127.0.0.1:1/',
    assertion: {expected: 'Action completed', observed: 'Action completed', passed: true},
    cleanup: {browserClosed: true, profileRemoved: true, fixtureStopped: true},
    actions: [{action: 'open-fixture', url: 'http://127.0.0.1:1/'}],
    consoleErrors: [{text: 'boom', url: 'http://127.0.0.1:1/x'}],
    networkEvidence: [{url: 'http://127.0.0.1:1/', status: 404}],
    screenshotRefs: ['/api/local/audits/ui-run/browser/screenshot'],
  };
  const host = {innerHTML: '', textContent: ''};
  const button = {disabled: true, dataset: {auditId: 'ui-run'}};
  const {runFixtureBrowser} = callHelpers({
    document: {getElementById: id => (id === 'localBrowserEvidence' ? host : null)},
    fetch: async () => ({ok: true, json: async () => result}),
  });
  await runFixtureBrowser(button);
  assert.match(host.innerHTML, /id="localBrowserStatus" class="status verified">Completed fixture journey/);
  assert.match(host.innerHTML, /id="localBrowserEvidenceDetail"/);
  assert.match(host.innerHTML, /<dt>browser closed<\/dt><dd class="mono">true<\/dd>/);
  assert.match(host.innerHTML, /<span class="row-value">boom<\/span>/);
  assert.match(host.innerHTML, /class="status failed">404<\/span>/);
  assert.equal(button.disabled, false, 'the control is re-enabled after the journey');
  assert.doesNotMatch(functionSource('runFixtureBrowser'), /JSON\.stringify/, 'the journey renderer never dumps raw JSON');
});

test('a failed browser journey keeps its reason and marks cleanup unproven', async () => {
  const host = {innerHTML: '', textContent: ''};
  const {runFixtureBrowser} = callHelpers({
    document: {getElementById: id => (id === 'localBrowserEvidence' ? host : null)},
    fetch: async () => ({ok: true, json: async () => ({status: 'Incomplete', failedStage: 'assertion', error: 'Visible text was "Waiting for action"', cleanup: {browserClosed: false, profileRemoved: true, fixtureStopped: true}, consoleErrors: [], networkEvidence: []})}),
  });
  await runFixtureBrowser({disabled: true, dataset: {auditId: 'ui-run'}});
  assert.match(host.innerHTML, /class="status failed">Incomplete fixture journey/);
  assert.match(host.innerHTML, /assertion: Visible text was/);
  assert.match(host.innerHTML, /<dt>browser closed<\/dt><dd class="mono">false<\/dd>/);
  assert.match(host.innerHTML, /Screenshot: Missing \(not captured\)/);
});

test('the single-repository finding path uses the same evidence blocks', async () => {
  const host = {innerHTML: ''};
  const {renderLocalFinding} = callHelpers({
    document: {getElementById: () => host},
    fetch: async () => ({ok: true, json: async () => ({
      status: 'Incomplete', failedStage: 'execution',
      finding: {title: 'Broken syntax', severity: 'High', description: 'line one\nline two', evidence: {file: 'broken.js'}},
      model: {provider: 'openai', model: 'gpt-x'},
      execution: {...executed(1), stdout: 'partial'},
    })}),
  });
  await renderLocalFinding('repo-1');
  assert.match(host.innerHTML, /<pre class="code-line">node --check broken\.js<\/pre>/);
  assert.match(host.innerHTML, /<span>stdout<\/span>/);
  assert.match(host.innerHTML, /id="localFindingTitle"/);
  assert.doesNotMatch(host.innerHTML, /<pre style=/, 'no inline pre overrides remain');
});

test('result page styles ship the overflow guards the evidence blocks depend on', () => {
  assert.match(html, /\.code-line\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(html, /\.json-block\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(html, /\.stream pre\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(html, /\.evidence-card\s*\{\s*display:\s*grid;\s*gap:\s*12px;\s*min-width:\s*0/);
  assert.match(html, /@media\(max-width:720px\)\{\s*\.fact-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(html, /<pre style="white-space:pre-wrap;overflow-wrap:anywhere">/, 'inline pre overrides are gone');
});

test('result page class names do not collide with the rest of the stylesheet', () => {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const resultBlock = style.match(/\/\* Local result page[\s\S]*?\/\* Zapier/);
  assert.ok(resultBlock, 'the result page style block exists');
  const owned = new Set();
  for (const match of resultBlock[0].matchAll(/(?:^|})\s*([^{}]+)\{/g)) {
    for (const compound of match[1].split(',')) {
      const leading = compound.trim().match(/^\.([A-Za-z][\w-]*)/);
      if (leading) owned.add(leading[1]);
    }
  }
  const reusedComponents = ['status', 'mono'];
  const restOfPage = style.replace(resultBlock[0], '');
  const collisions = [...owned].filter(name => !reusedComponents.includes(name) && new RegExp(`\\.${name}(?![\\w-])`).test(restOfPage));
  assert.deepEqual(collisions, [], 'these result classes are already styled elsewhere in the page');
  const renderer = ['renderMasterAudit', 'browserEvidenceBody', 'executionEvidenceCard', 'runFixtureBrowser', 'renderLocalFinding', 'stageRows', 'cleanupGrid', 'actionRows', 'consoleErrorRows', 'networkRows', 'artifactList', 'proofSummary', 'proofBadge', 'codeLine', 'stream', 'jsonBlock', 'evidenceRows', 'resultBadge', 'chip', 'monoChip', 'fact', 'factGrid', 'evidenceCard']
    .map(functionSource).join('\n');
  const unused = [...owned].filter(name => !renderer.includes(name));
  assert.deepEqual(unused, [], 'these result classes are never used by the renderer');
  assert.match(resultBlock[0], /\.result-summary\b/, 'the summary block keeps its own unique class name');
});

test('direct badge children of a result card never stretch to the card width', () => {
  assert.match(html, /\.evidence-card > h3, \.evidence-card > \.status, \.evidence-card > \.result-title, \.evidence-card > \.result-chips \{ justify-self: start; \}/);
});
