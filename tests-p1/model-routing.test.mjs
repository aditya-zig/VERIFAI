import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createDemoServer } from '../scripts/serve-web.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRepository } from '../services/local-analysis.mjs';
import { reviewSecurityRepository } from '../services/local-security-specialist.mjs';

const finding = { title: 'Source observation', severity: 'info', description: 'Unit-only source review, not verification.', evidence: { file: 'README.md' } };
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'verifai-routing-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspacePath = join(root, 'clone');
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, 'README.md'), 'Unit fixture, never real audit acceptance evidence.');
  const config = {
    schemaVersion: 1, timeoutMs: 1000, attemptTimeoutMs: 200, maxAttempts: 3,
    providers: [
      { id: 'first', baseUrl: 'https://first.example/v1', apiKeyEnv: 'FIRST_API_KEY' },
      { id: 'second', baseUrl: 'https://second.example/v1', apiKeyEnv: 'SECOND_API_KEY' },
    ],
    routes: [
      { id: 'primary', provider: 'first', model: 'model-a', enabled: true },
      { id: 'same-provider', provider: 'first', model: 'model-b', enabled: true },
      { id: 'backup', provider: 'second', model: 'model-c', enabled: true },
    ], ...overrides,
  };
  const path = join(root, 'models.json');
  await writeFile(path, JSON.stringify(config));
  return { config, path, env: { VERIFIAI_MODEL_CONFIG: path, FIRST_API_KEY: 'unit-first-credential', SECOND_API_KEY: 'unit-second-credential' }, record: { repository: { fullName: 'unit/routing' }, clone: { workspacePath }, files: { items: ['README.md'] } } };
}
function reply(model, content = JSON.stringify(finding)) {
  return new Response(JSON.stringify({ model, id: 'unit-response', choices: [{ message: { content } }] }));
}

test('analysis and security use the next provider after an outage, with separate keys and honest provenance', async t => {
  const f = await fixture(t);
  for (const review of [analyzeRepository, reviewSecurityRepository]) {
    const requests = [];
    const result = await review(f.record, { env: f.env, auditId: 'unit-audit', fetchImpl: async (url, options) => {
      requests.push({ url, key: options.headers.authorization, body: JSON.parse(options.body) });
      if (url.includes('first.example')) return new Response('Sensitive upstream error must not be published', { status: 503 });
      return reply('model-c');
    } });
    assert.equal((result.finding ?? result.findings[0]).title, 'Source observation');
    assert.equal(result.model.provider, 'second');
    assert.equal(result.model.model, 'model-c');
    assert.equal(result.model.reportedModel, 'model-c');
    assert.equal(result.model.route, 'backup');
    assert.equal(result.model.calls, 2);
    assert.deepEqual(result.model.attempts.map(a => a.outcome), ['http_error', 'skipped_provider_unavailable', 'succeeded']);
    assert.equal(result.model.attempts[0].httpStatus, 503);
    assert.equal(result.model.attempts.at(-1).httpStatus, 200);
    assert.deepEqual(requests.map(r => r.key), ['Bearer unit-first-credential', 'Bearer unit-second-credential']);
    assert.equal(requests[1].body.model, 'model-c');
    assert.ok(!JSON.stringify(result.model).includes('credential'));
  }
});

test('editing the config swaps arbitrary hosted providers, models, aliases and parameters on the next analysis', async t => {
  const f = await fixture(t);
  for (const model of ['model-a', 'replacement-model']) {
    f.config.routes = [{ id: 'edited', provider: 'first', model, enabled: true,
      reportedModels: ['canonical-model'], jsonMode: false, parameters: { temperature: 0.7, reasoning_effort: 'low' } }];
    await writeFile(f.path, JSON.stringify(f.config));
    const result = await analyzeRepository(f.record, { env: f.env, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://first.example/v1/chat/completions');
      const body = JSON.parse(options.body);
      assert.equal(body.model, model);
      assert.equal(body.temperature, 0.7);
      assert.equal(body.reasoning_effort, 'low');
      assert.equal(body.response_format, undefined);
      assert.equal(body.max_tokens, 500);
      return reply('canonical-model');
    } });
    assert.equal(result.model.model, model);
    assert.equal(result.model.reportedModel, 'canonical-model');
  }
});

test('a configured token-header provider gets only its own credential with the selected auth scheme', async t => {
  const f = await fixture(t);
  f.config.providers[0].authHeader = 'api-key';
  f.config.providers[0].authScheme = '';
  await writeFile(f.path, JSON.stringify(f.config));
  const result = await analyzeRepository(f.record, { env: f.env, fetchImpl: async (url, options) => {
    assert.equal(options.headers['api-key'], 'unit-first-credential');
    assert.equal(options.headers.authorization, undefined);
    return reply('model-a');
  } });
  assert.equal(result.model.provider, 'first');
  assert.equal(result.model.calls, 1);
});

test('invalid routing configuration fails closed before credentials reach any endpoint', async t => {
  const f = await fixture(t);
  const invalid = [
    c => { c.schemaVersion = 99; },
    c => { delete c.providers[0].id; },
    c => { delete c.routes[0].id; },
    c => { delete c.routes[0].model; },
    c => { c.routes[0].model = 123; },
    c => { c.providers[0].baseUrl = 'http://first.example/v1'; },
    c => { c.providers[0].authHeader = 'host'; },
    c => { c.providers[0].authScheme = 'Bearer\nInjected'; },
    c => { c.providers[0].baseUrl = 'https://first.example/v1?api_key=hidden'; },
    c => { c.providers[0].baseUrl = 'https://user:password@first.example/v1'; },
    c => { c.providers[0].apiKey = 'unit-first-credential'; },
    c => { c.providers.push(c.providers[0]); },
    c => { c.routes[0].provider = 'unknown-provider'; },
    c => { c.routes[0].enabled = 'false'; },
    c => { c.routes[1].id = c.routes[0].id; },
    c => { c.routes[0].parameters = { model: 'hijack', messages: [] }; },
    c => { c.routes[0].parameters = { temperature: 10 }; },
    c => { c.routes[0].parameters = { chat_template_kwargs: { unsafe: true } }; },
    c => { c.routes[0].reportedModels = ['']; },
    c => { c.routes[0].model = 'unit-first-credential'; },
    c => { c.timeoutMs = 0; },
    c => { c.attemptTimeoutMs = c.timeoutMs + 1; },
    c => { c.maxAttempts = 6; },
  ];
  for (const mutate of invalid) {
    const config = structuredClone(f.config); mutate(config);
    await writeFile(f.path, JSON.stringify(config));
    let calls = 0;
    await assert.rejects(analyzeRepository(f.record, { env: f.env, fetchImpl: async () => {
      calls += 1; return reply('model-a');
    } }), error => error.message === 'Invalid model routing configuration');
    assert.equal(calls, 0);
  }
  await writeFile(f.path, '{broken JSON containing unit-first-credential');
  await assert.rejects(analyzeRepository(f.record, { env: f.env }), error => !error.message.includes('credential'));
});

test('misnaming a credential reference cannot hide a known key in configuration or provenance', async t => {
  const f = await fixture(t);
  f.env.FIRST_API_KEY = 'UPPERCASEUNITKEY';
  f.config.providers[0].apiKeyEnv = 'UPPERCASEUNITKEY';
  f.config.routes[0].model = 'UPPERCASEUNITKEY';
  await writeFile(f.path, JSON.stringify(f.config));
  let calls = 0;
  await assert.rejects(analyzeRepository(f.record, { env: f.env, fetchImpl: async () => { calls += 1; return reply('model-c'); } }), /Invalid model routing configuration/);
  assert.equal(calls, 0);
});

test('legacy single-provider findings and parse errors also reject credential disclosures without fallback', async t => {
  const f = await fixture(t);
  for (const bad of [
    JSON.stringify({ ...finding, title: 'unit-second-credential' }),
    '{invalid unit-first-credential}',
    JSON.stringify({ ...finding, evidence: { file: 'unit-first-credential' } }),
  ]) {
    let calls = 0;
    await assert.rejects(analyzeRepository(f.record, { env: { XKIRO_API_KEY: 'unit-first-credential', NVIDIA_API_KEY: 'unit-second-credential', VERIFIAI_MODEL_ID: 'legacy-model' },
      fetchImpl: async () => { calls += 1; return reply('legacy-model', bad); } }), error => !error.message.includes('credential') && error.model.calls === 1);
    assert.equal(calls, 1);
  }
});

test('attempt deadlines move to another provider and an attempt cap never submits an extra request', async t => {
  const f = await fixture(t, { timeoutMs: 400, attemptTimeoutMs: 20 });
  const result = await analyzeRepository(f.record, { env: f.env, fetchImpl: async (url, options) => {
    if (url.includes('second.example')) return reply('model-c');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(reply('model-a')), 150);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('private transport detail')); }, { once: true });
    });
  } });
  assert.equal(result.model.provider, 'second');
  assert.equal(result.model.calls, 2);
  assert.equal(result.model.attempts[0].outcome, 'timeout');
  f.config.maxAttempts = 1;
  await writeFile(f.path, JSON.stringify(f.config));
  let calls = 0;
  await assert.rejects(analyzeRepository(f.record, { env: f.env, fetchImpl: async () => {
    calls += 1; return reply('unapproved-model');
  } }), error => error.message === 'Model routing attempt limit reached' && error.model.calls === 1);
  assert.equal(calls, 1);
});

test('missing credentials and disabled routes never borrow a key or submit an unintended request', async t => {
  const f = await fixture(t);
  delete f.env.FIRST_API_KEY;
  const result = await reviewSecurityRepository(f.record, { env: f.env, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://second.example/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer unit-second-credential');
    return reply('model-c');
  } });
  assert.equal(result.model.calls, 1);
  assert.deepEqual(result.model.attempts.map(a => a.outcome), ['skipped_missing_key', 'skipped_missing_key', 'succeeded']);
  f.config.routes.forEach(r => { r.enabled = false; });
  await writeFile(f.path, JSON.stringify(f.config));
  await assert.rejects(analyzeRepository(f.record, { env: f.env, fetchImpl: async () => { throw new Error('must not call'); } }),
    error => error.message === 'No configured model route succeeded' && error.model.calls === 0);
});

test('caller cancellation never falls back and one overall deadline bounds multiple attempts', async t => {
  const f = await fixture(t, { timeoutMs: 50, attemptTimeoutMs: 30 });
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(analyzeRepository(f.record, { env: f.env, signal: controller.signal, fetchImpl: async () => {
    calls += 1; controller.abort(new Error('unit-first-credential')); throw new Error('private upstream detail');
  } }), error => error.message === 'Model routing cancelled' && error.model.calls === 1);
  assert.equal(calls, 1);
  await assert.rejects(analyzeRepository(f.record, { env: f.env, fetchImpl: async (url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(reply(url.includes('first.example') ? 'model-a' : 'model-c')), 150);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('private detail')); }, { once: true });
  }) }), error => error.message === 'Model routing deadline exceeded'
    && error.model.calls === 2 && error.model.attempts.at(-1).outcome === 'deadline_exceeded');
});

test('a reply arriving after the attempt deadline is rejected even before the timer callback gets CPU time', async t => {
  const f = await fixture(t, { timeoutMs: 200, attemptTimeoutMs: 5 });
  const result = await analyzeRepository(f.record, { env: f.env, fetchImpl: async url => {
    if (url.includes('first.example')) {
      const until = performance.now() + 12;
      while (performance.now() < until) { /* Deliberately delayed unit transport, not a live model. */ }
      return reply('model-a');
    }
    return reply('model-c');
  } });
  assert.equal(result.model.provider, 'second');
  assert.equal(result.model.calls, 2);
  assert.equal(result.model.attempts[0].outcome, 'timeout');
});

test('untrusted trace metadata cannot publish provider keys or arbitrary headers', async t => {
  const f = await fixture(t);
  const result = await analyzeRepository(f.record, { env: f.env, fetchImpl: async () => new Response(JSON.stringify({
    model: 'model-a', id: 'unit-second-credential', usage: { prompt_tokens: 'unit-first-credential', completion_tokens: 5 },
    choices: [{ message: { content: JSON.stringify(finding) } }],
  }), { headers: { 'x-cache': 'unit-first-credential' } }) });
  assert.equal(result.model.responseId, null);
  assert.equal(result.model.usage.promptTokens, null);
  assert.equal(result.model.cacheHeader, null);
  assert.ok(!JSON.stringify(result).includes('credential'));
});

test('audit HTTP exhaustion reports actual failed model attempts, Incomplete and real fixture cleanup without a finding', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('private provider detail', { status: 503 });
  const server = createDemoServer({ apiOnly: true, env: { ...f.env, VERIFIAI_DATA_DIR: join(f.path, '..', 'state') }, repositories: {
    async clone() { return { ...f.record, id: 'unit-repository' }; },
    async cleanup() { await rm(f.record.clone.workspacePath, { recursive: true, force: true }); },
    async cleanupAll() { await rm(f.record.clone.workspacePath, { recursive: true, force: true }); },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const started = await originalFetch(`${base}/api/local/audits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://github.com/unit/routing' }) });
  assert.equal(started.status, 202);
  const { id } = await started.json();
  let run;
  for (let i = 0; i < 100; i += 1) {
    run = await (await originalFetch(`${base}/api/local/audits/${id}`)).json();
    if (run.status !== 'Running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(run.status, 'Incomplete');
  assert.equal(run.failedStage, 'analysis');
  assert.equal(run.model.calls, 2);
  assert.equal(run.finding, undefined);
  assert.equal(run.stages.sandbox.status, 'Skipped');
  assert.equal(run.cleanup.repositoryRemoved, true);
  assert.ok(!JSON.stringify(run).includes('private provider detail'));
});

test('invalid provider replies are rejected before a validated alternate model is selected', async t => {
  const f = await fixture(t);
  const invalid = [
    () => reply('substituted-model'),
    () => reply('model-a', ''),
    () => new Response('{bad JSON unit-first-credential'),
    () => reply('model-a', JSON.stringify({ ...finding, evidence: { file: '../untracked' } })),
    () => reply('model-a', JSON.stringify({ ...finding, severity: 'constructor' })),
    () => reply('model-a', JSON.stringify({ ...finding, description: 'unit-second-credential' })),
    () => new Response(JSON.stringify({ model: 'model-a', padding: 'x'.repeat(1024 * 1024), choices: [{ message: { content: JSON.stringify(finding) } }] })),
  ];
  for (const badReply of invalid) {
    const result = await analyzeRepository(f.record, { env: f.env, fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      return JSON.parse(options.body).model === 'model-a' ? badReply() : reply('model-b');
    } });
    assert.equal(result.model.model, 'model-b');
    assert.equal(result.model.calls, 2);
    assert.ok(!JSON.stringify(result).includes('credential'));
  }
});

test('explicit legacy overrides cannot send credentials over HTTP or put keys in model identifiers or URLs', async t => {
  const f = await fixture(t);
  for (const override of [
    { VERIFIAI_MODEL_BASE_URL: 'http://first.example/v1' },
    { VERIFIAI_MODEL_ID: 'unit-first-credential' },
    { VERIFIAI_MODEL_BASE_URL: 'https://first.example/unit-first-credential' },
  ]) {
    let calls = 0;
    await assert.rejects(analyzeRepository(f.record, { env: { VERIFIAI_MODEL_PROVIDER: 'xkiro', VERIFIAI_MODEL_ID: 'legacy-model', XKIRO_API_KEY: 'unit-first-credential', ...override },
      fetchImpl: async () => { calls += 1; throw new Error('must not call'); } }), /Invalid single-provider configuration/);
    assert.equal(calls, 0);
  }
});

test('the default analysis uses the editable Qwen chain while explicit legacy model overrides remain single-provider', async t => {
  const f = await fixture(t);
  const result = await analyzeRepository(f.record, { env: { XKIRO_API_KEY: 'unit-xkiro-credential' }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.xkiro.com/v1/chat/completions');
    assert.equal(JSON.parse(options.body).model, 'qwen/qwen3.8-max:free');
    return reply('qwen/qwen3.8-max:free');
  } });
  assert.equal(result.model.route, 'qwen-max');
  assert.equal(result.model.calls, 1);
  let calls = 0;
  await assert.rejects(analyzeRepository(f.record, {
    env: { VERIFIAI_MODEL_PROVIDER: 'xkiro', VERIFIAI_MODEL_ID: 'chosen-legacy-model', XKIRO_API_KEY: 'unit-xkiro-credential' },
    fetchImpl: async (url, options) => { calls += 1; assert.equal(JSON.parse(options.body).model, 'chosen-legacy-model'); return new Response('', { status: 503 }); },
  }), /Model call failed: HTTP 503/);
  assert.equal(calls, 1);
});
