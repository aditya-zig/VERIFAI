// M7: one defined fixture browser journey. Integration proof only, never
// verification of an arbitrary cloned app. The module serves its own
// loopback fixture and navigates only there: there is no URL input, so no
// caller (HTTP body or otherwise) can aim the browser elsewhere.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readdir, rm, lstat, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const FIXTURE_BUTTON_ID = 'journeyButton';
export const FIXTURE_STATUS_ID = 'journeyStatus';
export const FIXTURE_EXPECTED_TEXT = 'Action completed';
export const MAX_SCREENSHOT_BYTES = 1_048_576;
export const MAX_CONSOLE_ENTRIES = 200;
export const MAX_NETWORK_ENTRIES = 200;
export const MAX_RETAINED_SCREENSHOTS = 30;
export const CHROME_STARTUP_TIMEOUT_MS = 15_000;
export const CDP_TIMEOUT_MS = 15_000;
export const CHROME_KILL_TIMEOUT_MS = 5_000;
export const SCREENSHOT_ROUTE_PREFIX = '/api/local/browser-shots/';
export const screenshotRoot = join(tmpdir(), 'verifai-local-browser');

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
export function errorEntries(consoleEntries) {
  return consoleEntries.filter((entry) => entry.level === 'error')
    .map((entry) => ({text: entry.text, url: entry.url}));
}
// M9-compatible evidence shape: screenshotRefs/consoleErrors/networkEvidence.
export function browserEvidenceSummary(result) {
  return {status: result.status, startUrl: result.startUrl, finalUrl: result.finalUrl,
    actions: result.actions ?? [], assertions: result.assertions ?? [],
    screenshotRefs: result.screenshotRefs ?? [], consoleErrors: result.consoleErrors ?? [],
    networkEvidence: result.networkEvidence ?? [], durationMs: result.durationMs};
}

export function validateJourneyOptions({auditId, getAudit, timeoutMs = 60_000} = {}) {
  if (!auditId || typeof auditId !== 'string') throw new Error('auditId is required');
  if (getAudit !== undefined && typeof getAudit !== 'function') throw new Error('getAudit must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error('timeoutMs must be between 1 and 60000');
}

function busyError() { const error = new Error('Busy: only one local browser journey is allowed'); error.statusCode = 429; return error; }
let busy = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function describeConsoleMessage(method, params) {
  if (method === 'Runtime.consoleAPICalled') {
    const first = params?.args?.[0];
    const text = typeof first?.value === 'string' ? first.value : (first?.description ?? params?.type ?? 'console');
    return {method, level: params?.type === 'error' ? 'error' : 'info', text: String(text).slice(0, 500)};
  }
  if (method === 'Log.entryAdded') {
    return {method, level: params?.entry?.level === 'error' ? 'error' : 'info',
      text: String(params?.entry?.text ?? 'log').slice(0, 500), url: params?.entry?.url};
  }
  if (method === 'Runtime.exceptionThrown') {
    return {method, level: 'error', text: String(params?.exceptionDetails?.text ?? params?.exceptionDetails?.exception?.description ?? 'exception').slice(0, 500),
      url: params?.exceptionDetails?.url};
  }
  return undefined;
}

// Chrome gets a minimal local environment, never model credentials.
async function launchChrome({chromePath, signal}) {
  const profile = await mkdtemp(join(tmpdir(), 'verifai-browser-'));
  const child = spawn(chromePath || process.env.VERIFAI_CHROME || '/usr/bin/google-chrome-stable', [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe'], env: {HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'C.UTF-8'}});
  const kill = async () => {
    // Kill path means the browser never closed cleanly: browserClosed stays
    // false here. Only close() above may report browserClosed: true.
    const outcome = {browserClosed: false, profileRemoved: false};
    try {
      if (child.exitCode === null && child.signalCode === null) {
        outcome.killSignal = 'SIGTERM';
        child.kill('SIGTERM');
        const exited = await Promise.race([once(child, 'exit').then(() => true), delay(CHROME_KILL_TIMEOUT_MS).then(() => false)]);
        if (!exited && child.exitCode === null && child.signalCode === null) {
          outcome.killSignal = 'SIGKILL';
          child.kill('SIGKILL');
          await Promise.race([once(child, 'exit'), delay(CHROME_KILL_TIMEOUT_MS)]);
        }
      }
      outcome.browserClosed = false;
    } catch (error) { outcome.error = String(error?.message ?? error); }
    await rm(profile, {recursive: true, force: true});
    outcome.profileRemoved = true;
    return outcome;
  };
  let startupTimer;
  try {
    signal?.throwIfAborted();
    const endpoint = await new Promise((resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error('Incomplete: installed Chrome startup timed out')), CHROME_STARTUP_TIMEOUT_MS);
      const onAbort = () => { clearTimeout(startupTimer); reject(signal?.reason ?? new Error('Incomplete: aborted')); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, {once: true});
      let text = '';
      child.stderr.on('data', (chunk) => {
        text = (text + chunk).slice(-8192);
        const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(startupTimer); signal?.removeEventListener('abort', onAbort); resolve(match[1]); }
      });
      child.once('error', (cause) => { clearTimeout(startupTimer); signal?.removeEventListener('abort', onAbort); reject(new Error(`Incomplete: Chrome spawn failed: ${cause.message}`)); });
      child.once('exit', (code) => { clearTimeout(startupTimer); signal?.removeEventListener('abort', onAbort); reject(new Error(`Incomplete: Chrome exited ${code}`)); });
    });
    const ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        ws.removeEventListener('open', opened); ws.removeEventListener('error', failed);
        if (error) { ws.close(); reject(error); } else resolve();
      };
      const opened = () => finish();
      const failed = () => finish(new Error('Incomplete: Chrome connection failed'));
      const aborted = () => finish(signal?.reason ?? new Error('Incomplete: aborted'));
      const timer = setTimeout(() => finish(new Error('Incomplete: Chrome connection timed out')), CDP_TIMEOUT_MS);
      ws.addEventListener('open', opened, {once:true}); ws.addEventListener('error', failed, {once:true});
      signal?.addEventListener('abort', aborted, {once:true});
      if (signal?.aborted) aborted();
    });
    const consoleEntries = [];
    const networkEntries = [];
    ws.addEventListener('message', ({data}) => {
      const message = JSON.parse(data);
      if (message.id || message.sessionId === undefined) return;
      const described = describeConsoleMessage(message.method, message.params);
      if (described && consoleEntries.length < MAX_CONSOLE_ENTRIES) consoleEntries.push(described);
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
      if (request) { clearTimeout(request.timer); signal?.removeEventListener('abort', request.onAbort); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => { pending.delete(current); reject(new Error(`Incomplete: CDP timeout ${method}`)); }, CDP_TIMEOUT_MS);
      const onAbort = () => { clearTimeout(timer); pending.delete(current); reject(signal?.reason ?? new Error('Incomplete: aborted')); };
      if (signal?.aborted) { clearTimeout(timer); reject(signal?.reason ?? new Error('Incomplete: aborted')); return; }
      signal?.addEventListener('abort', onAbort, {once: true});
      pending.set(current, {resolve: (value) => { signal?.removeEventListener('abort', onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error); }, timer, onAbort});
      try { ws.send(JSON.stringify({id: current, method, params, sessionId})); }
      catch (error) { clearTimeout(timer); pending.delete(current); signal?.removeEventListener('abort', onAbort); reject(error); }
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
        // Register before navigation: the tiny loopback page can load before
        // the Page.navigate response arrives.
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
            ws.removeEventListener('message', onMessage);
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(() => finish(new Error('Incomplete: page load timed out')), CDP_TIMEOUT_MS);
          const onAbort = () => finish(signal?.reason ?? new Error('Incomplete: aborted'));
          function onMessage({data}) {
            const message = JSON.parse(data);
            if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) finish();
          }
          if (signal?.aborted) { onAbort(); return; }
          signal?.addEventListener('abort', onAbort, {once: true});
          ws.addEventListener('message', onMessage);
          call('Page.navigate', {url}, sessionId).catch(finish);
        });
      },
      screenshot: async () => {
        const {data} = await call('Page.captureScreenshot', {captureBeyondViewport: true}, sessionId);
        return Buffer.from(data, 'base64');
      },
      finalUrl: async () => evaluate('location.href'),
      close: async () => {
        const outcome = {browserClosed: false, profileRemoved: false};
        const exit = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
        try { await call('Browser.close'); outcome.browserClosed = true; }
        catch { child.kill('SIGTERM'); }
        await Promise.race([exit, delay(CHROME_KILL_TIMEOUT_MS).then(() => { if (child.exitCode === null && child.signalCode === null) { outcome.killSignal = 'SIGKILL'; child.kill('SIGKILL'); } })]);
        await exit.catch(() => {});
        await rm(profile, {recursive: true, force: true});
        outcome.profileRemoved = true;
        return outcome;
      },
      _kill: kill};
  } catch (error) { clearTimeout(startupTimer); const outcome = await kill(); throw Object.assign(error, {cleanup: outcome}); }
}

async function retainScreenshots(journeyId) {
  await mkdir(screenshotRoot, {recursive: true, mode: 0o700});
  const rootInfo = await lstat(screenshotRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o077)) throw new Error('Incomplete: screenshot directory ownership not verified');
  const names = (await readdir(screenshotRoot)).filter((name) => /^browser-[a-f0-9-]{36}\.png$/.test(name));
  if (names.length < MAX_RETAINED_SCREENSHOTS) return;
  const withTime = await Promise.all(names.map(async (name) => {
    const info = await lstat(join(screenshotRoot, name));
    if (!info.isFile() || info.uid !== process.getuid()) throw new Error('Incomplete: screenshot ownership not verified');
    return {name, mtime: info.mtimeMs};
  }));
  withTime.sort((a, b) => b.mtime - a.mtime);
  for (const stale of withTime.slice(MAX_RETAINED_SCREENSHOTS - 1)) await unlink(join(screenshotRoot, stale.name));
  void journeyId;
}

export async function runBrowserJourney({auditId, getAudit, timeoutMs = 60_000, chromePath, env = process.env, signal} = {}) {
  validateJourneyOptions({auditId, getAudit, timeoutMs});
  if (busy) throw busyError();
  busy = true;
  const journeyId = `browser-${randomUUID()}`;
  const started = performance.now();
  const actions = [];
  const cleanup = {browserClosed: false, profileRemoved: false, fixtureStopped: false};
  let consoleEntries = [];
  let networkEntries = [];
  let fixture;
  let browser;
  const evidence = () => ({console: consoleEntries, consoleErrors: errorEntries(consoleEntries),
    network: networkEntries, networkEvidence: networkEntries, cleanup});
  const fail = (failedStage, error, extra = {}) => ({status: 'Incomplete', failedStage, auditId, journeyId,
    error: String(error?.message ?? error), durationMs: Math.round(performance.now() - started), actions: [...actions], ...evidence(), ...extra});
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
    consoleEntries = browser.consoleEntries;
    networkEntries = browser.networkEntries;
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
      await delay(100);
    }
    const assertion = {expected: FIXTURE_EXPECTED_TEXT, observed, passed: observed === FIXTURE_EXPECTED_TEXT};
    actions.push({action: 'assert-visible-text', ...assertion});
    if (!assertion.passed) return fail('assertion', `Visible text was ${JSON.stringify(observed)}`, {assertion, assertions: [assertion]});
    const shot = await browser.screenshot();
    if (shot.byteLength > MAX_SCREENSHOT_BYTES) {
      return fail('evidence', `Screenshot ${shot.byteLength} bytes exceeds ${MAX_SCREENSHOT_BYTES} cap`,
        {assertion, assertions: [assertion]});
    }
    const finalUrl = await browser.finalUrl();
    const closeOutcome = await browser.close(); browser = null;
    Object.assign(cleanup, closeOutcome);
    await fixture.close(); fixture = null;
    cleanup.fixtureStopped = true;
    if (!cleanup.browserClosed || !cleanup.profileRemoved) return fail('cleanup', 'Browser clean shutdown was not proven');
    await retainScreenshots(journeyId);
    const screenshotPath = join(screenshotRoot, `${journeyId}.png`);
    await writeFile(screenshotPath, shot, {mode: 0o600});
    const ref = `${SCREENSHOT_ROUTE_PREFIX}${journeyId}.png`;
    return {status: 'Completed', auditId, journeyId, startUrl: actions.find((a) => a.action === 'open-fixture')?.url,
      finalUrl, actions, assertion, assertions: [assertion], screenshot: {ref, bytes: shot.byteLength},
      screenshotRefs: [ref], ...evidence(),
      durationMs: Math.round(performance.now() - started),
      cleanup: {...cleanup}};
  } catch (error) {
    if (error?.cleanup) Object.assign(cleanup, error.cleanup);
    if (error?.name === 'AbortError' || /abort/i.test(error?.message ?? '')) {
      return fail('browser', error, {aborted: true});
    }
    return fail(/Chrome|CDP|page load|aborted/i.test(error?.message ?? '') ? 'browser' : 'journey', error);
  } finally {
    try {
      if (browser) { const outcome = await browser._kill(); Object.assign(cleanup, outcome); }
    } catch (error) { cleanup.error = String(error?.message ?? error); }
    try { if (fixture) { await fixture.close(); cleanup.fixtureStopped = true; } }
    catch (error) { cleanup.error = String(error?.message ?? error); }
    busy = false;
  }
}
