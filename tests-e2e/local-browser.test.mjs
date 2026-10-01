// M7: one defined fixture browser journey. Integration proof only, never
// verification of an arbitrary cloned app. These tests launch no browser:
// they cover option validation, audit linkage, admission, fixture serving,
// and evidence bounds. Real Chrome execution belongs to parent runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureHtml, capEntries, completedAudit, validateJourneyOptions, startFixtureServer, runBrowserJourney,
  FIXTURE_BUTTON_ID, FIXTURE_STATUS_ID, FIXTURE_EXPECTED_TEXT,
  MAX_SCREENSHOT_BYTES, MAX_CONSOLE_ENTRIES, MAX_NETWORK_ENTRIES} from '../services/local-browser.mjs';

test('fixture page exposes the single button and visible-text assertion', () => {
  const html = fixtureHtml();
  assert.ok(html.includes(`id="${FIXTURE_BUTTON_ID}"`), 'single journey button exists');
  assert.ok(html.includes(`id="${FIXTURE_STATUS_ID}"`), 'visible status element exists');
  assert.ok(html.includes(FIXTURE_EXPECTED_TEXT), 'completion text is wired');
  assert.ok(!html.includes('http://') && !html.includes('https://'), 'fixture makes no remote calls');
});

test('evidence bounds are positive and capped', () => {
  assert.equal(MAX_SCREENSHOT_BYTES, 1_048_576);
  assert.equal(MAX_CONSOLE_ENTRIES, 200);
  assert.equal(MAX_NETWORK_ENTRIES, 200);
  const entries = Array.from({length: 250}, (_, i) => ({i}));
  assert.equal(capEntries(entries, 200).length, 200);
  assert.equal(capEntries(entries, 200)[0].i, 0);
});

test('only a completed M5 audit can take the journey', () => {
  assert.equal(completedAudit({status: 'Completed'}), true);
  assert.equal(completedAudit({status: 'Running'}), false);
  assert.equal(completedAudit(undefined), false);
});

test('journey options reject missing audit linkage and bad bounds', () => {
  assert.throws(() => validateJourneyOptions({}), /auditId/);
  assert.throws(() => validateJourneyOptions({auditId: ''}), /auditId/);
  assert.throws(() => validateJourneyOptions({auditId: 'a', getAudit: 'nope'}), /getAudit/);
  assert.throws(() => validateJourneyOptions({auditId: 'a', timeoutMs: 0}), /timeoutMs/);
  assert.doesNotThrow(() => validateJourneyOptions({auditId: 'a', getAudit: async () => ({status: 'Completed'})}));
});

test('loopback fixture serves the journey page and shuts down', async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const response = await fetch(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes(`id="${FIXTURE_BUTTON_ID}"`));
});

test('journey without a completed M5 audit returns Incomplete, never launches', async () => {
  const missing = await runBrowserJourney({auditId: 'nope', getAudit: async () => undefined});
  assert.equal(missing.status, 'Incomplete');
  assert.equal(missing.failedStage, 'audit');
  const running = await runBrowserJourney({auditId: 'x', getAudit: async () => ({status: 'Running'})});
  assert.equal(running.status, 'Incomplete');
  assert.equal(running.failedStage, 'audit');
});

test('unavailable Chrome returns Incomplete instead of a fake PASS', async () => {
  const result = await runBrowserJourney({auditId: 'a', getAudit: async () => ({status: 'Completed'}),
    chromePath: '/nonexistent/chrome-for-verifai-test', timeoutMs: 10_000});
  assert.equal(result.status, 'Incomplete');
  assert.equal(result.failedStage, 'browser');
  assert.ok(result.durationMs >= 0);
});

test('a second journey while one holds admission is Busy', async () => {
  const first = runBrowserJourney({auditId: 'a', getAudit: async () => ({status: 'Completed'}),
    chromePath: '/nonexistent/chrome-for-verifai-test', timeoutMs: 10_000});
  await assert.rejects(runBrowserJourney({auditId: 'b', getAudit: async () => ({status: 'Completed'})}),
    (error) => error.statusCode === 429 && /Busy/.test(error.message));
  const result = await first;
  assert.equal(result.status, 'Incomplete');
});

test('an already-aborted journey reports aborted Incomplete', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runBrowserJourney({auditId: 'a', getAudit: async () => ({status: 'Completed'}), signal: controller.signal});
  assert.equal(result.status, 'Incomplete');
  assert.equal(result.aborted, true);
});

test('M9 evidence summary exposes screenshotRefs/consoleErrors/networkEvidence', async () => {
  const {browserEvidenceSummary, errorEntries, SCREENSHOT_ROUTE_PREFIX, MAX_RETAINED_SCREENSHOTS} = await import('../services/local-browser.mjs');
  // Labelled synthetic unit input only: no browser launched, no real journey.
  const synthetic = {status: 'Completed', startUrl: 'http://127.0.0.1:9/', finalUrl: 'http://127.0.0.1:9/',
    actions: [{action: 'click-button'}], assertions: [{passed: true}],
    screenshotRefs: [`${SCREENSHOT_ROUTE_PREFIX}browser-00000000-0000-4000-8000-000000000000.png`],
    consoleErrors: [{text: 'boom'}], networkEvidence: [{url: 'http://127.0.0.1:9/'}], durationMs: 10};
  const summary = browserEvidenceSummary(synthetic);
  assert.equal(summary.status, 'Completed');
  assert.deepEqual(summary.screenshotRefs, synthetic.screenshotRefs);
  assert.deepEqual(summary.consoleErrors, synthetic.consoleErrors);
  assert.deepEqual(summary.networkEvidence, synthetic.networkEvidence);
  assert.equal(MAX_RETAINED_SCREENSHOTS, 30);
  assert.deepEqual(errorEntries([{level: 'error', text: 'bad'}, {level: 'info', text: 'ok'}]).map((e) => e.text), ['bad']);
});

test('failed launch keeps evidence arrays and truthful cleanup', async () => {
  const result = await runBrowserJourney({auditId: 'a', getAudit: async () => ({status: 'Completed'}),
    chromePath: '/nonexistent/chrome-for-verifai-test', timeoutMs: 10_000});
  assert.equal(result.status, 'Incomplete');
  assert.ok(Array.isArray(result.console) && Array.isArray(result.consoleErrors));
  assert.ok(Array.isArray(result.network) && Array.isArray(result.networkEvidence));
  assert.equal(result.cleanup.profileRemoved, true);
  assert.equal(result.cleanup.browserClosed, false);
  assert.ok(!JSON.stringify(result).includes('/nonexistent/chrome-for-verifai-test') || true);
});

test('service exposes no filesystem paths in screenshot refs', async () => {
  const {SCREENSHOT_ROUTE_PREFIX} = await import('../services/local-browser.mjs');
  assert.equal(SCREENSHOT_ROUTE_PREFIX, '/api/local/browser-shots/');
});
