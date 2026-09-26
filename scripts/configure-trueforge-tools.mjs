import { loadEnvFile } from 'node:process';

try { loadEnvFile('.env'); } catch {}

const trueforgeBase = (process.env.VERIFIAI_TRUEFORGE_BASE_URL ?? 'http://localhost:8790').replace(/\/+$/, '');
const bridgeHost = process.env.VERIFIAI_TRUEFORGE_AUDIT_TOOLS_HOST ?? 'localhost';
const bridgePort = Number(process.env.VERIFIAI_TRUEFORGE_AUDIT_TOOLS_PORT ?? 8793);
const bridgeUrl = `http://${bridgeHost}:${bridgePort}/mcp`;
const token = process.env.VERIFIAI_TRUEFORGE_TOKEN;

const headers = {
  'content-type': 'application/json',
  accept: 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const health = await fetch(`http://${bridgeHost}:${bridgePort}/healthz`, {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(10_000),
});
if (!health.ok) {
  throw new Error(`VERIFAI audit-tools bridge is not healthy: HTTP ${health.status}`);
}

const response = await fetch(`${trueforgeBase}/api/v1/settings/mcp-servers`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({
    manifest: {
      type: 'remote',
      name: 'verifiai-audit-tools',
      url: bridgeUrl,
      description: 'Scoped VERIFAI audit tools for real repository, target, browser, security, performance, chaos and repair evidence.',
    },
  }),
  signal: AbortSignal.timeout(15_000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  throw new Error(`TrueForge MCP connector upsert failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 1500)}`);
}

const toolsResponse = await fetch(`${trueforgeBase}/api/v1/mcp-servers/verifiai-audit-tools/tools`, {
  headers,
  signal: AbortSignal.timeout(15_000),
});
const toolsBody = await toolsResponse.json().catch(() => ({}));
if (!toolsResponse.ok) {
  throw new Error(`TrueForge could not list bridge tools: HTTP ${toolsResponse.status} ${JSON.stringify(toolsBody).slice(0, 1500)}`);
}
const tools = Array.isArray(toolsBody?.data) ? toolsBody.data.map((item) => item?.name).filter(Boolean).sort() : [];
console.log(JSON.stringify({
  ok: true,
  connector: 'verifiai-audit-tools',
  bridgeUrl,
  trueforgeBase,
  toolCount: tools.length,
  tools,
}, null, 2));
