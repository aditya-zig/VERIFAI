import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentWorkerLaunchBrief,
} from '../packages/contracts/src/index.js';
import { buildSpecialistPolicy } from '../services/agents/specialist-policy.js';
import { createAuditToolsMcpHttpServer } from '../services/trueforge/audit-tools-mcp.js';
import { signAuditScope, verifyAuditScope } from '../services/trueforge/audit-scope.js';

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';

async function listen(server: http.Server): Promise<{ port: number; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function brief(targetUrl: string): AgentWorkerLaunchBrief {
  return {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: 'AUD-TF-MCP',
    workerId: 'WORKER-TF-MCP',
    role: 'performance-discovery',
    objective: 'Check the target through the TrueForge MCP bridge.',
    repository: {
      provider: 'github',
      fullName: 'owner/repo',
      url: 'https://github.com/owner/repo',
      branch: 'main',
      commitSha: 'abc123',
    },
    target: {
      id: 'target-1',
      url: targetUrl,
      environment: 'shared-observation',
    },
    tools: [{
      name: 'performance',
      capabilities: ['http-request', 'performance-probe', 'k6', 'load'],
      executionClass: 'agent-native',
    }],
    evidenceRefs: [],
    modelProfileId: 'trueforge:test/model',
    constraints: {
      timeoutMs: 10_000,
      maxToolCalls: 8,
      maxEvidenceItems: 20,
      destructiveAllowed: false,
      networkAllowlist: ['127.0.0.1', 'api.github.com', 'raw.githubusercontent.com'],
      maxEstimatedSpendUsd: 0.1,
    },
  };
}

test('signed TrueForge audit scope binds the exact worker brief and rejects tampering', () => {
  const input = brief('http://127.0.0.1:3000');
  const token = signAuditScope(input, SECRET, 60_000, 1_000);
  const parsed = verifyAuditScope(token, SECRET, 2_000);
  assert.equal(parsed.auditId, input.auditId);
  assert.equal(parsed.workerId, input.workerId);
  assert.equal(parsed.repository.commitSha, input.repository.commitSha);
  assert.throws(() => verifyAuditScope(token + 'x', SECRET, 2_000), /invalid audit scope signature/);
  assert.throws(() => verifyAuditScope(token, SECRET, 70_000), /expired/);
});

test('specialist policy accepts TrueForge model profiles without a direct model-provider network dependency', () => {
  const policy = buildSpecialistPolicy({
    modelProfileId: 'trueforge:gemini-test',
    target: {
      id: 'target',
      url: 'http://127.0.0.1:3000',
      environment: 'shared-observation',
    },
    externalEngineUrl: 'http://127.0.0.1:8789',
  });
  assert.ok(policy.networkAllowlist.includes('api.github.com'));
  assert.ok(policy.networkAllowlist.includes('127.0.0.1'));
  assert.ok(policy.approvedTools['performance-discovery']);
});

test('streamable HTTP MCP bridge exposes scoped VERIFAI tools and returns real target evidence', async () => {
  const target = http.createServer((_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end('target-ok');
  });
  const targetListener = await listen(target);
  const targetUrl = `http://127.0.0.1:${targetListener.port}`;
  const workerBrief = brief(targetUrl);
  const token = signAuditScope(workerBrief, SECRET);

  const bridge = createAuditToolsMcpHttpServer({
    env: {
      VERIFIAI_TRUEFORGE_MCP_SCOPE_SECRET: SECRET,
    },
  });
  const bridgeListener = await listen(bridge);

  const client = new Client({ name: 'verifiai-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${bridgeListener.port}/mcp`),
  );

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'target_http'));

    const result = await client.callTool({
      name: 'target_http',
      arguments: {
        scopeToken: token,
        method: 'GET',
        path: '/',
      },
    });
    const text = (result.content as any[])
      .filter((item) => item?.type === 'text')
      .map((item) => item.text)
      .join('');
    const evidence = JSON.parse(text);
    assert.equal(evidence.source, 'target-http');
    assert.equal(evidence.executed, true);
    assert.equal(evidence.payload.outcome, 'pass');
    assert.equal(evidence.payload.status, 200);
    assert.match(evidence.payload.body, /target-ok/);
  } finally {
    await client.close().catch(() => undefined);
    await bridgeListener.close();
    await targetListener.close();
  }
});
