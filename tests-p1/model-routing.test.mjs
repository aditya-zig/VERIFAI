import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Model } from '@strands-agents/sdk';
import { resolveModelConfig, runModelRoutes } from '../services/local-model-routing.mjs';
import { requestModel } from '../services/local-analysis.mjs';
import { bedrockFixture } from './bedrock-fixture.mjs';
const env = { AWS_REGION: 'ap-south-1', VERIFIAI_BEDROCK_MODEL_ID: 'amazon.nova-lite-v1:0' };

test('AWS IAM denial returns a safe incomplete error and never retries another provider', async () => {
  let calls = 0;
  await assert.rejects(runModelRoutes(env, config => requestModel(config, [{ role: 'user', content: 'unit' }], {
    modelFactory: () => new class extends Model {
      getConfig() { return { modelId: config.model }; }
      updateConfig() {}
      async *stream() { calls++; throw new Error('AccessDeniedException private credential'); }
    }(),
  })), error => error.message === 'Bedrock model invocation unavailable' && error.model.calls === 1);
  assert.equal(calls, 1);
});

test('caller cancellation interrupts a Bedrock turn without a fallback', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(requestModel(resolveModelConfig(env), [{ role: 'user', content: 'unit' }], {
    signal: controller.signal, modelFactory: () => { calls++; throw new Error('must not call'); },
  }), /cancel|interrupted/i);
  assert.equal(calls, 0);
});

test('Bedrock output containing AWS credentials is rejected without publishing them', async () => {
  const privateEnv = { ...env, AWS_SECRET_ACCESS_KEY: 'unit-sensitive-value' };
  await assert.rejects(runModelRoutes(privateEnv, config => requestModel(config, [{ role: 'user', content: 'unit' }], {
    modelFactory: bedrockFixture('unit-sensitive-value'),
  })), error => /sensitive/.test(error.message) && !error.message.includes('unit-sensitive-value'));
});

test('in-flight cancellation and deadline bound a stalled Bedrock stream to one call', { timeout: 2000 }, async t => {
  for (const mode of ['cancel', 'deadline']) await t.test(mode, async () => {
    let started, release, calls = 0;
    const streaming = new Promise(resolve => { started = resolve; });
    const stalled = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    // Keep a handle alive: AbortSignal.timeout itself is deliberately unref'ed.
    const watchdog = setTimeout(() => controller.abort(), 1000);
    const config = resolveModelConfig(env);
    const result = requestModel({ ...config, timeoutMs: mode === 'deadline' ? 25 : 1000 },
      [{ role: 'user', content: 'unit' }], {
        signal: controller.signal,
        modelFactory: () => new class extends Model {
          getConfig() { return { modelId: config.model }; }
          updateConfig() {}
          async *stream() { calls++; started(); await stalled; }
        }(),
      });
    const rejected = assert.rejects(result, /interrupted|cancelled/);
    try {
      await streaming;
      if (mode === 'cancel') controller.abort();
      await rejected;
      assert.equal(calls, 1);
      assert.equal(controller.signal.aborted, mode === 'cancel');
    } finally { clearTimeout(watchdog); release(); }
  });
});

test('editable settings permit Bedrock model selection but reject external catalogs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'verifai-bedrock-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'models.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 2, modelId: 'amazon.nova-lite-v1:0', region: 'ap-south-1', timeoutMs: 1000, maxTokens: 300 }));
  const config = resolveModelConfig({ VERIFIAI_MODEL_CONFIG: path });
  assert.equal(config.model, 'amazon.nova-lite-v1:0');
  assert.equal(config.maxTokens, 300);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, providers: [{ id: 'external' }], routes: [] }));
  assert.throws(() => resolveModelConfig({ VERIFIAI_MODEL_CONFIG: path }), /Invalid Bedrock/);
});

test('backend GitHub credentials cannot be published in a Bedrock finding or model identity', async () => {
  const token = 'ghp_unit_private_token_123';
  const privateEnv = { ...env, GITHUB_TOKEN: token };
  await assert.rejects(runModelRoutes(privateEnv, async () => ({ finding: { description: token }, model: { calls: 1 } })),
    error => /sensitive/.test(error.message) && !error.message.includes(token));
  assert.throws(() => resolveModelConfig({ ...privateEnv, VERIFIAI_BEDROCK_MODEL_ID: token }), /Invalid Bedrock/);
});
