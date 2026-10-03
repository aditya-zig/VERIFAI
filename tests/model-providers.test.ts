import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_PROVIDER_PROFILES,
  redactProviderSecrets,
  resolveModelRunSelection,
} from '../services/agent-runtime/providers.js';

test('the only model provider is AWS Bedrock', () => {
  assert.deepEqual(Object.keys(MODEL_PROVIDER_PROFILES), ['bedrock']);
});

test('Bedrock selection uses the AWS credential chain without model API keys', async () => {
  const selection = await resolveModelRunSelection({}, { env: {
    VERIFIAI_BEDROCK_MODEL_ID: 'amazon.nova-pro-v1:0',
    AWS_REGION: 'ap-south-1',
  } });
  assert.equal(selection.provider, 'bedrock');
  assert.equal(selection.modelId, 'amazon.nova-pro-v1:0');
  assert.equal(selection.profileId, 'bedrock:amazon.nova-pro-v1:0');
  assert.equal((selection as any).region, 'ap-south-1');
  assert.equal(selection.credentialSource, 'aws-default-chain');
  assert.equal('credential' in selection, false);
});

test('explicit Bedrock model input wins and generic model environment remains supported', async () => {
  const selection = await resolveModelRunSelection({ modelId: 'explicit-model' }, { env: {
    VERIFIAI_BEDROCK_MODEL_ID: 'bedrock-model', VERIFIAI_MODEL_ID: 'generic-model', AWS_DEFAULT_REGION: 'us-west-2',
  } });
  assert.equal(selection.modelId, 'explicit-model');
  assert.equal((selection as any).region, 'us-west-2');
  const generic = await resolveModelRunSelection({}, { env: { VERIFIAI_MODEL_ID: 'generic-model', AWS_REGION: 'us-east-1' } });
  assert.equal(generic.modelId, 'generic-model');
});

test('legacy third-party providers and missing model IDs fail closed', async () => {
  await assert.rejects(resolveModelRunSelection({}, { env: { VERIFIAI_MODEL_PROVIDER: 'openrouter', VERIFIAI_MODEL_ID: 'legacy' } }), /Unsupported model provider/);
  await assert.rejects(resolveModelRunSelection({}, { env: {} }), /VERIFIAI_BEDROCK_MODEL_ID or VERIFIAI_MODEL_ID is required/);
});

test('provider secret redaction is recursive and fail-closed', () => {
  assert.deepEqual(redactProviderSecrets({
    accessKeyId: 'access-id', secretAccessKey: 'raw-secret', sessionToken: 'token',
    nested: { authorization: 'Bearer top-secret', note: 'safe top-secret' },
  }, ['top-secret']), {
    accessKeyId: '[REDACTED]', secretAccessKey: '[REDACTED]', sessionToken: '[REDACTED]',
    nested: { authorization: '[REDACTED]', note: 'safe [REDACTED]' },
  });
});


test('Bedrock selection requires an explicit AWS region', async () => {
  await assert.rejects(resolveModelRunSelection({}, { env: { VERIFIAI_MODEL_ID: 'model' } }), /AWS_REGION or AWS_DEFAULT_REGION is required/);
});

test('retired model endpoint, secret, and harness overrides are rejected', async () => {
  for (const name of ['VERIFIAI_MODEL_BASE_URL', 'VERIFIAI_MODEL_SECRET_ID', 'VERIFIAI_MODEL_SECRET_FIELD', 'VERIFIAI_AGENT_HARNESS']) {
    await assert.rejects(resolveModelRunSelection({}, { env: {
      VERIFIAI_MODEL_ID: 'amazon.nova-pro-v1:0', AWS_REGION: 'ap-south-1', [name]: 'retired-configuration',
    } }), /remove retired model configuration/);
  }
});

test('Bedrock model and region metadata reject malformed and credential-bearing values without echoing them', async () => {
  for (const modelId of ['model with whitespace', ' model', 'https://external.example/model']) {
    await assert.rejects(resolveModelRunSelection({ modelId }, { env: { AWS_REGION: 'ap-south-1' } }), /Invalid Bedrock model configuration/);
  }
  for (const region of ['ap-south-1.attacker.example', ' ap-south-1', 'localhost', 'us-east-1/token']) {
    await assert.rejects(resolveModelRunSelection({ modelId: 'model', region }, { env: {} }), /Invalid Bedrock model configuration/);
  }
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) {
    for (const values of [{ modelId: 'secret-bearing-model', region: 'ap-south-1', secret: 'secret-bearing' }, { modelId: 'model', region: 'us-east-1', secret: 'us-east' }]) {
      await assert.rejects(resolveModelRunSelection(values, { env: { [name]: values.secret } }), (error: any) => {
        assert.equal(error.message, 'Invalid Bedrock model configuration');
        assert.ok(!error.message.includes(values.secret));
        return true;
      });
    }
  }
});
