import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Agent, BedrockModel } from '@strands-agents/sdk';
import { createStrandsPlanningAgent } from '../services/orchestrator/strands-orchestrator.js';
import { executeAgentCoreWorker } from '../services/agent-runtime/worker-server.js';
import { LiveAuditService } from '../apps/api/swarms/service.js';
import { AGENT_WORKER_CONTRACT_VERSION, type AgentWorkerLaunchBrief } from '../packages/contracts/src/index.js';

const repository = { provider: 'github' as const, fullName: 'owner/repo', url: 'https://github.com/owner/repo', branch: 'main', commitSha: 'test' };
const brief: AgentWorkerLaunchBrief = {
  contractVersion: AGENT_WORKER_CONTRACT_VERSION, auditId: 'AUD-AWS', workerId: 'worker-aws', role: 'security-secrets',
  objective: 'Inspect evidence', repository, target: null, tools: [], evidenceRefs: [],
  modelProfileId: 'bedrock:amazon.nova-pro-v1:0',
  constraints: { timeoutMs: 1000, maxToolCalls: 1, maxEvidenceItems: 1, destructiveAllowed: false, networkAllowlist: [] },
};

test('Strands worker and planner construct Bedrock models and preserve evidence guardrails', async (t: any) => {
  const models: any[] = [];
  t.mock.method(Agent.prototype, 'invoke', async function (this: Agent) {
    models.push(this.model);
    return { lastMessage: { content: [{ text: JSON.stringify({ outcome: 'completed', findingState: 'Confirmed', findings: ['unverified claim'], summary: 'test response' }) }] } };
  });
  const previousRegion = process.env.AWS_REGION;
  process.env.AWS_REGION = 'ap-south-1';
  try {
    const report = await executeAgentCoreWorker(brief);
    assert.equal(report.findingState, 'Unconfirmed');
    assert.equal(report.evidence.length, 0);
    const { planner, modelProfileId } = await createStrandsPlanningAgent({ modelId: 'amazon.nova-pro-v1:0' }, { env: { AWS_REGION: 'ap-south-1' } });
    await assert.rejects(planner.propose({ auditId: 'AUD', repository, target: null, objective: 'test', availableRoles: [] }), /returned no workers/);
    assert.equal(modelProfileId, brief.modelProfileId);
    assert.equal(models.length, 2);
    for (const model of models) {
      assert.ok(model instanceof BedrockModel);
      assert.equal(model.getConfig().modelId, 'amazon.nova-pro-v1:0');
    }
  } finally {
    if (previousRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previousRegion;
  }
});

test('live audits default to AgentCore and reject missing runtime configuration before planning', async () => {
  const service = new LiveAuditService({ env: { VERIFIAI_BEDROCK_MODEL_ID: 'amazon.nova-pro-v1:0', AWS_REGION: 'ap-south-1' } });
  await assert.rejects(service.start({ repository, target: null }), /VERIFIAI_AGENTCORE_RUNTIME_ARN is required in agentcore mode/);
});

test('AgentCore runtime grants only configured Bedrock model resources, without external model secrets', async () => {
  const template = await readFile('infra/aws/agentcore-runtime.yml', 'utf8');
  assert.match(template, /BedrockModelArns:\n    Type: CommaDelimitedList/);
  assert.match(template, /bedrock:InvokeModel\n/);
  assert.match(template, /bedrock:InvokeModelWithResponseStream\n/);
  assert.match(template, /Resource: !Ref BedrockModelArns/);
  assert.doesNotMatch(template, /ModelSecret|secretsmanager:GetSecretValue/);
  assert.match(template, /VERIFIAI_MODEL_PROVIDER: bedrock/);
});
