import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRepository, resolveModelConfig } from '../services/local-analysis.mjs';
import { reviewSecurityRepository } from '../services/local-security-specialist.mjs';
import { bedrockFixture } from './bedrock-fixture.mjs';

const env = { AWS_REGION: 'ap-south-1', VERIFIAI_BEDROCK_MODEL_ID: 'amazon.nova-lite-v1:0' };
async function fixture(t) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'verifai-bedrock-unit-'));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  await writeFile(join(workspacePath, 'README'), 'Unit source context, not runtime proof.');
  return { repository: { fullName: 'unit/bedrock' }, clone: { workspacePath }, files: { items: ['README'] } };
}

test('Bedrock selects explicit region/model without third-party credentials', () => {
  const config = resolveModelConfig(env);
  assert.equal(config.provider, 'bedrock');
  assert.equal(config.model, 'amazon.nova-lite-v1:0');
  assert.equal(config.region, 'ap-south-1');
  assert.equal(config.apiKey, undefined);
  assert.throws(() => resolveModelConfig({ AWS_REGION: 'ap-south-1' }), /MODEL_ID/);
  assert.throws(() => resolveModelConfig({ VERIFIAI_MODEL_ID: 'amazon.nova-lite-v1:0' }), /AWS_REGION/);
});

test('retired providers and endpoint overrides fail before sending any request', async t => {
  const record = await fixture(t);
  for (const overrides of [
    { VERIFIAI_MODEL_PROVIDER: 'trueforge' }, { VERIFIAI_MODEL_PROVIDER: 'openrouter' },
    { VERIFIAI_MODEL_PROVIDER: 'xkiro' }, { VERIFIAI_MODEL_BASE_URL: 'https://attacker.example' },
  ]) {
    let calls = 0;
    await assert.rejects(analyzeRepository(record, { env: { ...env, ...overrides },
      modelFactory: () => { calls++; throw new Error('must not send'); } }), /Bedrock|AWS|Unsupported/);
    assert.equal(calls, 0);
  }
});

test('both reviewers use bounded Strands Bedrock turns and preserve source citation gates', async t => {
  const record = await fixture(t);
  for (const review of [analyzeRepository, reviewSecurityRepository]) {
    const security = review === reviewSecurityRepository;
    let calls = 0;
    const finding = { title: ' Observation ', severity: 'minor', description: ' Source review ',
      ...(security ? { evidence_file: 'README' } : { evidence: { file: 'README' } }) };
    const result = await review(record, { env, auditId: 'unit-audit', modelFactory: bedrockFixture(JSON.stringify(finding), (options, messages, streamOptions) => {
      calls++;
      assert.equal(options.modelId, 'amazon.nova-lite-v1:0');
      assert.equal(options.region, 'ap-south-1');
      assert.equal(options.maxTokens, 500);
      assert.equal(options.temperature, security ? 0.1 : 0.2);
      assert.equal(options.clientConfig.maxAttempts, 1);
      assert.ok(JSON.stringify(messages).includes('unit/bedrock'));
      assert.ok(JSON.stringify(streamOptions.systemPrompt).includes('untrusted data'));
    }) });
    assert.equal(calls, 1);
    assert.deepEqual(result.finding ?? result.findings[0], { title: 'Observation', severity: 'low', description: 'Source review', evidence: { file: 'README' } });
    assert.equal(result.model.provider, 'bedrock');
    assert.equal(result.model.requestId, security ? 'unit-audit:security' : 'unit-audit');
    assert.equal(result.model.calls, 1);
    assert.equal(result.model.reportedModel, null, 'configured identity is not a reported response identity');
  }
});

test('invalid JSON and untracked citations remain failures, without a fallback call', async t => {
  const record = await fixture(t);
  for (const text of ['not JSON', JSON.stringify({ title: 'Bad', severity: 'info', description: 'bad', evidence: { file: '../secret' } })]) {
    let calls = 0;
    await assert.rejects(analyzeRepository(record, { env, modelFactory: bedrockFixture(text, () => calls++) }), /JSON|outside the clone/);
    assert.equal(calls, 1);
  }
});
