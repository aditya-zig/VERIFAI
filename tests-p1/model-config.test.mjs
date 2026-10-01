import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRepository, resolveModelConfig } from '../services/local-analysis.mjs';
import { reviewSecurityRepository } from '../services/local-security-specialist.mjs';

test('Seek AI resolves its own credential and explicitly selected model', () => {
  const config = resolveModelConfig({
    VERIFIAI_MODEL_PROVIDER: 'seek_ai',
    VERIFIAI_MODEL_ID: 'glm-5.3-flash',
    SEEK_AI_API_KEY: 'unit-test-key',
  });
  assert.equal(config.provider, 'seek_ai');
  assert.equal(config.model, 'glm-5.3-flash');
  assert.equal(config.baseUrl, 'https://seekai.cc/v1');
  assert.equal(config.apiKey, 'unit-test-key');
});

test('Seek AI requires an explicit model and does not fall back to another provider key', () => {
  assert.throws(() => resolveModelConfig({
    VERIFIAI_MODEL_PROVIDER: 'seek_ai',
    SEEK_AI_API_KEY: 'unit-test-key',
  }), /VERIFIAI_MODEL_ID is required/);
  assert.throws(() => resolveModelConfig({
    VERIFIAI_MODEL_PROVIDER: 'seek_ai',
    VERIFIAI_MODEL_ID: 'glm-5.3-flash',
    XKIRO_API_KEY: 'unit-test-key',
  }), /set SEEK_AI_API_KEY/);
});

test('Seek AI sends a bounded request once and rejects invalid JSON (unit-only)', async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'verifai-model-config-unit-'));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  await writeFile(join(workspacePath, 'README'), 'Unit-only context, not audit acceptance evidence.');
  let calls = 0;
  let body;
  await assert.rejects(() => analyzeRepository({
    repository: { fullName: 'unit/config-check' },
    clone: { workspacePath },
    files: { items: ['README'] },
  }, {
    env: {
      VERIFIAI_MODEL_PROVIDER: 'seek_ai',
      VERIFIAI_MODEL_ID: 'glm-5.3-flash',
      SEEK_AI_API_KEY: 'unit-test-key',
    },
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://seekai.cc/v1/chat/completions');
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ model: 'glm-5.3-flash', choices: [{ message: { content: 'not JSON' } }] }) };
    },
  }), /Model did not return JSON/);
  assert.equal(calls, 1);
  assert.equal(body.model, 'glm-5.3-flash');
  assert.equal(body.max_tokens, 500);
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('Seek AI refuses substituted or missing GLM identity even with valid JSON (unit-only)', async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'verifai-model-identity-unit-'));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  await writeFile(join(workspacePath, 'README'), 'Unit-only context, not acceptance evidence.');
  const record = {
    repository: { fullName: 'unit/identity-check' },
    clone: { workspacePath },
    files: { items: ['README'] },
  };
  const content = JSON.stringify({
    title: 'Unit-only response', severity: 'info',
    description: 'Synthetic unit response, never real audit evidence.', evidence: { file: 'README' },
  });
  for (const review of [analyzeRepository, reviewSecurityRepository]) {
    for (const model of ['MiniMaxAI/MiniMax-M2.7', undefined, 'unit-test-key']) {
      let calls = 0;
      await assert.rejects(() => review(record, {
        env: { VERIFIAI_MODEL_PROVIDER: 'seek_ai', VERIFIAI_MODEL_ID: 'glm-5.3-flash', SEEK_AI_API_KEY: 'unit-test-key' },
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, json: async () => ({ model, choices: [{ message: { content } }] }) };
        },
      }), error => /Seek AI did not report the requested glm-5.3-flash model/.test(error.message)
        && !error.message.includes('unit-test-key'));
      assert.equal(calls, 1, 'no automatic retry or model fallback');
    }
    for (const model of ['glm-5.3-flash', 'GLM-5.3-FLASH']) {
      const result = await review(record, {
        env: { VERIFIAI_MODEL_PROVIDER: 'seek_ai', VERIFIAI_MODEL_ID: 'glm-5.3-flash', SEEK_AI_API_KEY: 'unit-test-key' },
        fetchImpl: async () => ({ ok: true, json: async () => ({ model, choices: [{ message: { content } }] }) }),
      });
      assert.equal(result.model.provider, 'seek_ai');
      assert.equal((result.finding ?? result.findings[0]).title, 'Unit-only response');
    }
  }
});

test('both reviewers preserve bounded requests, compatible envelopes and trace metadata', async t => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'verifai-model-policy-unit-'));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  await writeFile(join(workspacePath, 'README'), 'Unit-only context.');
  const record = { repository: { fullName: 'unit/policy' }, clone: { workspacePath }, files: { items: ['README'] } };
  const env = { XKIRO_API_KEY: 'unit-test-key' };
  const finding = { title: ' Observation ', severity: 'minor', description: ' Source observation ', evidence: { file: 'README' } };
  for (const review of [analyzeRepository, reviewSecurityRepository]) {
    const security = review === reviewSecurityRepository;
    const requestId = security ? 'unit-audit:security' : 'unit-audit';
    const content = security
      ? `\u0060\u0060\u0060json\n${JSON.stringify({ ...finding, evidence: undefined, evidence_file: 'README' })}\n\u0060\u0060\u0060`
      : JSON.stringify({ result: { finding } });
    const result = await review(record, { env, auditId: 'unit-audit', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.xkiro.com/v1/chat/completions');
      assert.equal(options.headers['x-request-id'], requestId);
      assert.equal(options.headers['cache-control'], 'no-cache');
      const body = JSON.parse(options.body);
      assert.equal(body.max_tokens, 500);
      assert.equal(body.temperature, security ? 0.1 : 0.2);
      assert.equal(body.messages.length, 2);
      return new Response(JSON.stringify({ id: 'unit-response', choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }), { headers: { 'x-cache': 'MISS' } });
    } });
    assert.deepEqual(result.finding ?? result.findings[0], { title: 'Observation', severity: 'low', description: 'Source observation', evidence: { file: 'README' } });
    assert.equal(result.model.requestId, requestId);
    assert.equal(result.model.responseId, 'unit-response');
    assert.equal(result.model.cacheHeader, 'MISS');
    assert.deepEqual(result.model.usage, { promptTokens: 20, completionTokens: 10 });
  }
});

test('both reviewers cancel rejected HTTP bodies without retrying or leaking credentials', async t => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'verifai-model-http-unit-'));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  await writeFile(join(workspacePath, 'README'), 'Unit-only context.');
  const record = { repository: { fullName: 'unit/http' }, clone: { workspacePath }, files: { items: ['README'] } };
  for (const review of [analyzeRepository, reviewSecurityRepository]) {
    let calls = 0;
    let cancellations = 0;
    await assert.rejects(review(record, { env: { XKIRO_API_KEY: 'unit-test-key' }, fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503, body: { cancel: async () => { cancellations += 1; } } };
    } }), error => error.message === 'Model call failed: HTTP 503');
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
  }
});

test('the existing default provider remains unchanged', () => {
  const config = resolveModelConfig({ XKIRO_API_KEY: 'unit-test-key' });
  assert.equal(config.provider, 'xkiro');
  assert.equal(config.model, 'mistralai/ministral-8b');
});
