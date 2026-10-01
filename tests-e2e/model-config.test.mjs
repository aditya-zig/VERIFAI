import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRepository, resolveModelConfig } from '../services/local-analysis.mjs';

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
  for (const model of ['MiniMaxAI/MiniMax-M2.7', undefined, 'unit-test-key']) {
    let calls = 0;
    await assert.rejects(() => analyzeRepository(record, {
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
    const result = await analyzeRepository(record, {
      env: { VERIFIAI_MODEL_PROVIDER: 'seek_ai', VERIFIAI_MODEL_ID: 'glm-5.3-flash', SEEK_AI_API_KEY: 'unit-test-key' },
      fetchImpl: async () => ({ ok: true, json: async () => ({ model, choices: [{ message: { content } }] }) }),
    });
    assert.equal(result.model.provider, 'seek_ai');
    assert.equal(result.finding.title, 'Unit-only response');
  }
});

test('the existing default provider remains unchanged', () => {
  const config = resolveModelConfig({ XKIRO_API_KEY: 'unit-test-key' });
  assert.equal(config.provider, 'xkiro');
  assert.equal(config.model, 'mistralai/ministral-8b');
});
