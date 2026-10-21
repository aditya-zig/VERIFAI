const prefix = '/api/local/pr-verifications';
const inputKeys = new Set(['repository', 'pullRequest', 'expectedHeadSha']);

function reject(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readInput(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) reject(413, 'PR verification request exceeds 32 KiB');
    chunks.push(chunk);
  }
  if (!size) return {};
  if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    reject(415, 'PR verification requests require application/json');
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'request must be a JSON object');
    return body;
  } catch (error) {
    if (error.statusCode) throw error;
    reject(400, 'request must contain valid JSON');
  }
}

function candidateInput(body) {
  if (Object.keys(body).some(key => !inputKeys.has(key))) reject(400, 'only repository, pullRequest and expectedHeadSha may be submitted');
  if (typeof body.repository !== 'string'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(body.repository)
    || ['.', '..'].includes(body.repository.split('/')[1])) reject(400, 'repository must be a GitHub owner/name');
  if (!Number.isSafeInteger(body.pullRequest) || body.pullRequest <= 0) reject(400, 'pullRequest must be a positive integer');
  if (typeof body.expectedHeadSha !== 'string' || !/^[a-f0-9]{40}$/i.test(body.expectedHeadSha)) reject(400, 'expectedHeadSha must be an exact 40-character commit SHA');
  return { repository: body.repository, pullRequest: body.pullRequest, expectedHeadSha: body.expectedHeadSha.toLowerCase() };
}

function jobIdentifier(value) {
  let id;
  try { id = decodeURIComponent(value); } catch { reject(400, 'malformed PR job identifier'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '.' || id === '..') reject(400, 'invalid PR job identifier');
  return id;
}

/** Mount after the server's loopback Host/Origin boundary. Authentication is server-owned. */
export function createPrVerificationHttpHandler({
  controller,
  authenticate = () => reject(401, 'authentication required'),
  executionConfigured = false,
  publicationConfigured = false,
} = {}) {
  return async function handlePrVerification(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
    try {
      const principal = await authenticate(req);
      if (!principal?.id || !['human', 'agent'].includes(principal.kind) || !Array.isArray(principal.repositories)) {
        reject(401, 'authenticated principal required');
      }
      if (url.pathname === `${prefix}/capabilities`) {
        if (req.method !== 'GET') {
          reply(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
          return true;
        }
        reply(res, 200, { executionConfigured, publicationConfigured, liveAwsAccepted: false, authenticated: true });
        return true;
      }
      const match = url.pathname.slice(prefix.length).match(/^\/([^/]+)(?:\/(cancel|evidence))?$/);
      const id = match ? jobIdentifier(match[1]) : undefined;
      const action = match?.[2];
      const allowed = url.pathname === prefix ? 'POST' : action === 'cancel' ? 'POST' : 'GET';
      if (url.pathname !== prefix && !match) {
        reply(res, 404, { error: 'PR verification route not found' });
        return true;
      }
      if (req.method !== allowed) {
        reply(res, 405, { error: 'method not allowed' }, { allow: allowed });
        return true;
      }
      if (!controller) reject(503, 'PR verification controller is not configured');
      if (!id) {
        const body = candidateInput(await readInput(req));
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(key)) reject(400, 'a bounded Idempotency-Key header is required');
        reply(res, 202, { job: await controller.start(body, principal, key) });
      } else if (action === 'cancel') {
        if (Object.keys(await readInput(req)).length) reject(400, 'cancel does not accept execution records or other input');
        await controller.cancel(id, principal);
        reply(res, 202, { job: await controller.get(id, principal) });
      } else {
        const job = await controller.get(id, principal);
        if (!job) reject(404, 'PR verification job not found');
        if (action === 'evidence') {
          reply(res, 200, { status: job.result ? 'Available' : 'Pending', candidate: job.candidate, plan: job.plan, result: job.result });
        } else reply(res, 200, { job });
      }
    } catch (error) {
      const code = error?.statusCode ?? error?.status;
      const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : 500;
      reply(res, status, { status: 'Incomplete', error: status >= 500 ? 'PR verification unavailable; inspect the server configuration' : String(error.message) });
    }
    return true;
  };
}
