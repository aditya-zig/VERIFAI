import { randomUUID } from 'node:crypto';

export const jobCliUsage = `Usage:
  node scripts/verifai-job.mjs start --repository owner/repo --pr 12 --expected-head <sha> [--idempotency-key <key>]
  node scripts/verifai-job.mjs status --job <id>
  node scripts/verifai-job.mjs cancel --job <id>
  node scripts/verifai-job.mjs evidence --job <id>
  node scripts/verifai-job.mjs capabilities

Environment:
  VERIFIAI_AGENT_TOKEN  Scoped token configured by the local operator
  VERIFIAI_API_URL      Loopback HTTP service, default http://127.0.0.1:4173

This client cannot submit execution records, approve repair publication or merge code.
`;

function options(args, allowed) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith('--') || !allowed.includes(key.slice(2))) throw new Error(`unsupported option ${key}`);
    const name = key.slice(2);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate option ${key}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    values[name] = value;
  }
  return values;
}

function loopbackBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('VERIFIAI_API_URL must be a loopback HTTP origin without credentials or a path');
  }
  return url.origin;
}

export async function runPrJobCommand(argv, { env = process.env, fetchImpl = fetch } = {}) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') return { help: jobCliUsage };
  const [command, ...rest] = argv;
  const commands = ['start', 'status', 'cancel', 'evidence', 'capabilities'];
  if (!commands.includes(command)) throw new Error('expected start, status, cancel, evidence or capabilities');
  const token = env.VERIFIAI_AGENT_TOKEN;
  if (typeof token !== 'string' || !token.trim()) throw new Error('VERIFIAI_AGENT_TOKEN is required');
  const base = loopbackBase(env.VERIFIAI_API_URL ?? 'http://127.0.0.1:4173');
  let path = '/api/local/pr-verifications';
  let body;
  const headers = { authorization: `Bearer ${token.trim()}` };
  let method = 'GET';
  if (command === 'start') {
    const values = options(rest, ['repository', 'pr', 'expected-head', 'idempotency-key']);
    if (!values.repository || !/^[1-9][0-9]*$/.test(values.pr ?? '') || !Number.isSafeInteger(Number(values.pr))
      || !/^[a-f0-9]{40}$/i.test(values['expected-head'] ?? '')) throw new Error('start requires repository, positive PR number and exact expected head SHA');
    body = JSON.stringify({ repository: values.repository, pullRequest: Number(values.pr), expectedHeadSha: values['expected-head'] });
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = values['idempotency-key'] ?? randomUUID();
    method = 'POST';
  } else if (command === 'capabilities') {
    if (rest.length) throw new Error('capabilities accepts no options');
    path += '/capabilities';
  } else {
    const values = options(rest, ['job']);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values.job ?? '') || ['.', '..'].includes(values.job)) throw new Error('a valid --job identifier is required');
    path += `/${encodeURIComponent(values.job)}`;
    if (command === 'cancel') { path += '/cancel'; method = 'POST'; }
    if (command === 'evidence') path += '/evidence';
  }
  const response = await fetchImpl(`${base}${path}`, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`local service returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`local service rejected ${command} with HTTP ${response.status}`);
  return data;
}
