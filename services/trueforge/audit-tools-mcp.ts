import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { EvidenceInput } from '../../packages/contracts/src/index.js';
import { resolveAuditScopeSecret, verifyAuditScope } from './audit-scope.js';
import {
  executeAuditTool,
  incompleteToolEvidence,
  type AuditToolName,
} from './audit-tools-runtime.js';

export interface AuditToolsMcpServerOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function mcpResult(evidence: EvidenceInput) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(evidence) }],
  };
}

function createMcpServer(options: AuditToolsMcpServerOptions): McpServer {
  const env = options.env ?? process.env;
  const secret = resolveAuditScopeSecret(env);
  const server = new McpServer({
    name: 'verifiai-audit-tools',
    version: '0.1.0',
  });

  const run = async (
    toolName: AuditToolName,
    input: Record<string, unknown>,
  ) => {
    try {
      const scopeToken = typeof input.scopeToken === 'string' ? input.scopeToken : '';
      const brief = verifyAuditScope(scopeToken, secret);
      const { scopeToken: _ignored, ...args } = input;
      return mcpResult(await executeAuditTool(brief, toolName, args, {
        env,
        fetchImpl: options.fetchImpl,
      }));
    } catch (error) {
      return mcpResult(incompleteToolEvidence(toolName, error));
    }
  };

  server.registerTool('repo_tree', {
    description: 'List files from the exact audited GitHub commit. The signed scope fixes repository and worker identity server-side.',
    inputSchema: {
      scopeToken: z.string().min(1),
      prefix: z.string().max(200).optional(),
    },
  }, async (input) => run('repo_tree', input));

  server.registerTool('repo_read', {
    description: 'Read one UTF-8 file from the exact audited GitHub commit.',
    inputSchema: {
      scopeToken: z.string().min(1),
      path: z.string().min(1).max(400),
    },
  }, async (input) => run('repo_read', input));

  server.registerTool('target_http', {
    description: 'Send a network-allowlisted request to the assigned target only. Mutation methods require destructive permission.',
    inputSchema: {
      scopeToken: z.string().min(1),
      method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
      path: z.string().min(1).max(500).default('/'),
      body: z.string().max(20_000).optional(),
    },
  }, async (input) => run('target_http', input));

  server.registerTool('performance_probe', {
    description: 'Run a small bounded latency sample against the assigned target.',
    inputSchema: {
      scopeToken: z.string().min(1),
      path: z.string().min(1).max(500).default('/'),
      requests: z.number().int().min(1).max(10).default(3),
    },
  }, async (input) => run('performance_probe', input));

  server.registerTool('mirofish_personas', {
    description: 'Run the real configured MiroFish/OASIS external-engine lane for customer/persona simulation.',
    inputSchema: {
      scopeToken: z.string().min(1),
      productContext: z.string().min(20).max(12_000),
      requirement: z.string().min(10).max(2_000).optional(),
      maxRounds: z.number().int().min(1).max(8).default(3),
      platform: z.enum(['parallel', 'twitter', 'reddit']).default('parallel'),
    },
  }, async (input) => run('mirofish_personas', input));

  server.registerTool('strix_scan', {
    description: 'Run the real configured Strix security scanner against the assigned target.',
    inputSchema: {
      scopeToken: z.string().min(1),
      scanMode: z.enum(['quick', 'standard', 'deep']).default('quick'),
      maxBudgetUsd: z.number().min(0.1).max(2.5).default(0.5),
      instruction: z.string().max(2_000).optional(),
    },
  }, async (input) => run('strix_scan', input));

  server.registerTool('zap_scan', {
    description: 'Run the real configured OWASP ZAP DAST lane against the assigned target.',
    inputSchema: {
      scopeToken: z.string().min(1),
      maxChildren: z.number().int().min(1).max(100).default(20),
      maxAlerts: z.number().int().min(1).max(500).default(200),
    },
  }, async (input) => run('zap_scan', input));

  server.registerTool('schemathesis_fuzz', {
    description: 'Run the real configured Schemathesis API fuzz/property test lane.',
    inputSchema: {
      scopeToken: z.string().min(1),
      schemaPath: z.string().min(1).max(500).default('/openapi.json'),
      maxExamples: z.number().int().min(1).max(100).default(25),
    },
  }, async (input) => run('schemathesis_fuzz', input));

  server.registerTool('load_test', {
    description: 'Run a bounded real k6 or Locust load test through the configured external-engine service.',
    inputSchema: {
      scopeToken: z.string().min(1),
      engine: z.enum(['locust', 'k6']).default('locust'),
      path: z.string().min(1).max(500).default('/'),
      concurrency: z.number().int().min(1).max(25).default(2),
      durationSec: z.number().int().min(1).max(60).default(10),
      maxP95Ms: z.number().min(1).max(60_000).default(1_000),
      maxErrorRate: z.number().min(0).max(1).default(0.01),
    },
  }, async (input) => run('load_test', input));

  server.registerTool('toxiproxy_fault', {
    description: 'Apply an authorized bounded Toxiproxy fault through the real external-engine service.',
    inputSchema: {
      scopeToken: z.string().min(1),
      name: z.string().min(1).max(80),
      listen: z.string().min(3).max(200),
      upstream: z.string().min(3).max(200),
      toxicType: z.enum(['latency', 'timeout', 'reset_peer', 'bandwidth']).default('latency'),
      latencyMs: z.number().int().min(1).max(30_000).default(1_000),
      probeUrl: z.string().url().optional(),
      probeTimeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    },
  }, async (input) => run('toxiproxy_fault', input));

  server.registerTool('computer_use', {
    description: 'Execute a real Browser Use, Cua, or generic computer-use journey against the assigned target.',
    inputSchema: {
      scopeToken: z.string().min(1),
      engine: z.enum(['browser-use', 'cua', 'generic']).optional(),
      objective: z.string().min(1).max(2_000),
      persona: z.string().min(1).max(1_000).optional(),
    },
  }, async (input) => run('computer_use', input));

  server.registerTool('apply_candidate_patch', {
    description: 'Apply a candidate repair only inside an authorized isolated-mutation target.',
    inputSchema: {
      scopeToken: z.string().min(1),
      diagnosis: z.string().min(1).max(5_000),
      desiredBehavior: z.string().min(1).max(5_000),
    },
  }, async (input) => run('apply_candidate_patch', input));

  return server;
}

export function createAuditToolsMcpHttpServer(
  options: AuditToolsMcpServerOptions = {},
): Server {
  const env = options.env ?? process.env;
  // Fail startup instead of exposing a bridge whose scopes cannot be verified.
  resolveAuditScopeSecret(env);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return json(response, 200, {
          status: 'ok',
          service: 'verifiai-audit-tools-mcp',
          transport: 'streamable-http',
        });
      }
      if (url.pathname !== '/mcp') return json(response, 404, { error: 'not found' });

      const body = request.method === 'POST' ? await readJson(request) : undefined;
      const mcp = createMcpServer(options);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error: any) {
      if (!response.headersSent) {
        return json(response, 500, { error: String(error?.message ?? error) });
      }
      response.end();
    }
  });
}

if (process.argv[1]?.endsWith('audit-tools-mcp.js')) {
  const port = Number(process.env.VERIFIAI_TRUEFORGE_AUDIT_TOOLS_PORT ?? 8793);
  const host = process.env.VERIFIAI_TRUEFORGE_AUDIT_TOOLS_HOST ?? 'localhost';
  createAuditToolsMcpHttpServer().listen(port, host, () => {
    console.log(JSON.stringify({
      service: 'verifiai-audit-tools-mcp',
      status: 'ready',
      url: `http://${host}:${port}/mcp`,
      health: `http://${host}:${port}/healthz`,
    }));
  });
}
