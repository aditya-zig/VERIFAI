// M7: one defined fixture browser journey. Integration proof only, never
// verification of an arbitrary cloned app. The module serves its own
// loopback fixture and navigates only there: there is no URL input, so no
// caller (HTTP body or otherwise) can aim the browser at a general page.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const FIXTURE_BUTTON_ID = 'journeyButton';
export const FIXTURE_STATUS_ID = 'journeyStatus';
export const FIXTURE_EXPECTED_TEXT = 'Action completed';
export const MAX_SCREENSHOT_BYTES = 1_048_576;
export const MAX_CONSOLE_ENTRIES = 200;
export const MAX_NETWORK_ENTRIES = 200;
export const CHROME_STARTUP_TIMEOUT_MS = 15_000;
export const CDP_TIMEOUT_MS = 15_000;

export function fixtureHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
    `<title>VERIFAI fixture journey</title></head><body>` +
    `<p>Integration proof fixture. Not verification of any cloned application.</p>` +
    `<button id="${FIXTURE_BUTTON_ID}" type="button">Run action</button>` +
    `<p id="${FIXTURE_STATUS_ID}" role="status">Waiting for action</p>` +
    `<script>document.getElementById('${FIXTURE_BUTTON_ID}').addEventListener('click',` +
    `()=>{document.getElementById('${FIXTURE_STATUS_ID}').textContent='${FIXTURE_EXPECTED_TEXT}';});</script>` +
    `</body></html>`;
}

export function capEntries(entries, max) { return entries.slice(0, max); }
export function completedAudit(audit) { return audit?.status === 'Completed'; }

export function validateJourneyOptions({auditId, getAudit, timeoutMs = 60_000} = {}) {
  if (!auditId || typeof auditId !== 'string') throw new Error('auditId is required');
  if (getAudit !== undefined && typeof getAudit !== 'function') throw new Error('getAudit must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
}

function busyError() { const error = new Error('Busy: only one local browser journey is allowed'); error.statusCode = 429; return error; }
let busy = false;

export async function startFixtureServer() {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404); response.end(); return; }
    const body = fixtureHtml();
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body)});
    response.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const {port} = server.address();
  return {url: `http://127.0.0.1:${port}/`, async close() { await new Promise((resolve) => server.close(resolve)); }};
}

// Chrome gets a minimal local environment, never model credentials.
async function launchChrome({chromePath, signal}) {
  const profile = await mkdtemp(join(tmpdir(), 'verifai-browser-'));
  const child = spawn(chromePath || process.env.VERIFAI_CHROME || '/usr/bin/google-chrome-stable', [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe'], env: {HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'C.UTF-8'}});
  const kill = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    await rm(profile, {recursive: true, force: true});
  };
  let startupTimer;
  try {
    signal?.throwIfAborted();
    const endpoint = await new Promise((resolve, reject) => {
      let text = '';
      startupTimer = setTimeout(() => reject(new Error('Incomplete: installed Chrome startup timed out')), CHROME_STARTUP_TIMEOUT_MS);
      child.stderr.on('data', (chunk) => {
        text = (text + chunk).slice(-8192);
        const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(startupTimer); resolve(match[1]); }
      });
      child.once('error', (cause) => reject(new Error(`Incomplete: Chrome spawn failed: ${cause.message}`)));
      child.once('exit', (code) => reject(new Error(`Incomplete: Chrome exited ${code}`)));
    });
    const ws = new WebSocket(endpoint);
    await once(ws, 'open');
    const consoleEntries = [];
    const networkEntries = [];
    ws.addEventListener('message', ({data}) => {
      const message = JSON.parse(data);
      if (message.id || message.sessionId === undefined) return;
      if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Log.entryAdded') {
        if (consoleEntries.length < MAX_CONSOLE_ENTRIES) consoleEntries.push({method: message.method, params: message.params});
      }
      if (message.method === 'Network.requestWillBeSent' && networkEntries.length < MAX_NETWORK_ENTRIES) {
        networkEntries.push({url: message.params?.request?.url, method: message.params?.request?.method});
      }
      if (message.method === 'Network.responseReceived' && networkEntries.length < MAX_NETWORK_ENTRIES) {
        networkEntries.push({url: message.params?.response?.url, status: message.params?.response?.status});
      }
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ({data}) => {
      const message = JSON.parse(data);
      if (!message.id) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (request) { clearTimeout(request.timer); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => { pending.delete(current); reject(new Error(`Incomplete: CDP timeout ${method}`)); }, CDP_TIMEOUT_MS);
      pending.set(current, {resolve, reject, timer});
      ws.send(JSON.stringify({id: current, method, params, sessionId}));
    });
    const {targetId} = await call('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await call('Target.attachToTarget', {targetId, flatten: true});
    await call('Page.enable', {}, sessionId);
    await call('Runtime.enable', {}, sessionId);
    await call('Log.enable', {}, sessionId);
    await call('Network.enable', {}, sessionId);
    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    return {consoleEntries, networkEntries, evaluate,
      navigate: async (url) => {
        await call('Page.navigate', {url}, sessionId);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Incomplete: page load timed out')), CDP_TIMEOUT_MS);
          const onMessage = ({data}) => {
            const message = JSON.parse(data);
            if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) { clearTimeout(timer); ws.removeEventListener('message', onMessage); resolve(); }
          };
          ws.addEventListener('message', onMessage);
        });
      },
      screenshot: async () => {
        const {data} = await call('Page.captureScreenshot', {captureBeyondViewport: true}, sessionId);
        return Buffer.from(data, 'base64');
      },
      finalUrl: async () => evaluate('location.href'),
      close: async () => {
        const exit = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
        try { await call('Browser.close'); } catch { child.kill('SIGTERM'); }
        ws.close();
        await exit;
        await rm(profile, {recursive: true, force: true});
      },
      _kill: kill};
  } catch (error) { clearTimeout(startupTimer); await kill(); throw error; }
}

export async function runBrowserJourney({auditId, getAudit, timeoutMs = 60_000, chromePath, env = process.env, signal} = {}) {
  validateJourneyOptions({auditId, getAudit, timeoutMs});
  if (busy) throw busyError();
  busy = true;
  const journeyId = `browser-${randomUUID()}`;
  const started = performance.now();
  const actions = [];
  let fixture;
  let browser;
  const fail = (failedStage, error, extra = {}) => ({status: 'Incomplete', failedStage, auditId, journeyId,
    error: String(error?.message ?? error), durationMs: Math.round(performance.now() - started), ...extra});
  try {
    signal?.throwIfAborted();
    const audit = await getAudit?.(auditId, {env});
    if (!completedAudit(audit)) return fail('audit', `No completed M5 audit for ${auditId}`);
    actions.push({action: 'audit-linked', auditId});
    fixture = await startFixtureServer();
    actions.push({action: 'serve-fixture', url: fixture.url});
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    browser = await launchChrome({chromePath: chromePath || env.VERIFAI_CHROME, signal: combined});
    await browser.navigate(fixture.url);
    actions.push({action: 'open-fixture', url: fixture.url});
    await browser.evaluate(`document.getElementById('${FIXTURE_BUTTON_ID}').click()`);
    actions.push({action: 'click-button', buttonId: FIXTURE_BUTTON_ID});
    const waitStart = Date.now();
    let observed = '';
    while (Date.now() - waitStart < timeoutMs) {
      combined.throwIfAborted();
      observed = await browser.evaluate(`document.getElementById('${FIXTURE_STATUS_ID}').textContent`);
      if (observed === FIXTURE_EXPECTED_TEXT) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const assertion = {expected: FIXTURE_EXPECTED_TEXT, observed, passed: observed === FIXTURE_EXPECTED_TEXT};
    actions.push({action: 'assert-visible-text', ...assertion});
    if (!assertion.passed) return fail('assertion', `Visible text was ${JSON.stringify(observed)}`, {actions});
    const shot = await browser.screenshot();
    const bounded = shot.byteLength <= MAX_SCREENSHOT_BYTES;
    const finalUrl = await browser.finalUrl();
    const consoleEntries = capEntries(browser.consoleEntries, MAX_CONSOLE_ENTRIES);
    const networkEntries = capEntries(browser.networkEntries, MAX_NETWORK_ENTRIES);
    await browser.close(); browser = null;
    await fixture.close(); fixture = null;
    if (!bounded) return fail('evidence', `Screenshot ${shot.byteLength} bytes exceeds ${MAX_SCREENSHOT_BYTES} cap`, {actions, assertion});
    const screenshotRoot = join(tmpdir(), 'verifai-local-browser');
    const screenshotPath = join(screenshotRoot, `${journeyId}.png`);
    await mkdir(screenshotRoot, {recursive: true, mode: 0o700});
    await writeFile(screenshotPath, shot, {mode: 0o600});
    return {status: 'Completed', auditId, journeyId, startUrl: actions.find((a) => a.action === 'open-fixture')?.url,
      finalUrl, actions, assertion, screenshot: {path: screenshotPath, bytes: shot.byteLength},
      console: consoleEntries,
      network: networkEntries,
      durationMs: Math.round(performance.now() - started),
      cleanup: {browserClosed: true, fixtureStopped: true}};
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted|aborted/i.test(error?.message ?? '')) {
      return fail('browser', error, {aborted: true, actions});
    }
    return fail(/Chrome|CDP|page load/.test(error?.message ?? '') ? 'browser' : 'journey', error, {actions});
  } finally {
    try { if (browser) await browser._kill(); } catch { /* cleanup best effort */ }
    try { if (fixture) await fixture.close(); } catch { /* cleanup best effort */ }
    busy = false;
  }
}
