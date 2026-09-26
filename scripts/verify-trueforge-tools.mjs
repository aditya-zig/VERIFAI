import { loadEnvFile } from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

try { loadEnvFile('.env'); } catch {}

const host = process.env.VERIFIAI_TRUEFORGE_AUDIT_TOOLS_HOST ?? 'localhost';
const port = Number(process.env.VERIFIAI_TRUEFORGE_AUDIT_TOOLS_PORT ?? 8793);
const baseUrl = `http://${host}:${port}`;

const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(10_000) });
if (!health.ok) throw new Error(`VERIFAI audit-tools health failed: HTTP ${health.status}`);

const client = new Client({ name: 'verifiai-mcp-preflight', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const required = ['computer_use', 'load_test', 'repo_read', 'repo_tree', 'target_http'];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`VERIFAI audit-tools MCP is missing: ${missing.join(', ')}`);
  console.log(JSON.stringify({
    ok: true,
    bridge: 'verifiai-audit-tools',
    baseUrl,
    transport: 'streamable-http',
    toolCount: names.length,
    tools: names,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}
