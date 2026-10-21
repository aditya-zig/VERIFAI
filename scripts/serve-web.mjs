import { createServer } from 'node:http';
import { readFile, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalRepositoryService } from '../services/local-repository.mjs';
import { abortActiveAudit, acquireLocalAudit } from '../services/local-audit.mjs';
import { MasterAuditService } from '../services/master-audit.mjs';
import { runBrowserJourney, MAX_SCREENSHOT_BYTES, screenshotRoot } from '../services/local-browser.mjs';
import { LocalRepairService } from '../services/local-repair-service.mjs';
import { LocalArtifactService } from '../services/local-artifact-service.mjs';
import { LocalPrService } from '../services/local-pr-service.mjs';
import { createPrVerificationRuntime } from '../services/pr-verification/runtime.mjs';
import { LocalHumanApprovalsService } from '../services/human-pr-approvals.mjs';
import { authorizeBearer, describePrincipalConfig, assertPrincipalScope } from '../services/request-principal.mjs';

const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Bodyless POSTs (cleanup, PR publication) contain no payload to intake; a
  // guard must not reformat them. JSON-only applies to bodies that exist:
  // any non-empty body must be application/json.
  const contentType = String(req.headers['content-type'] ?? '').trim().toLowerCase();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) { const error = new Error('request body exceeds 256 KiB safety limit'); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  if (bytes > 0 && contentType.split(';')[0].trim() !== 'application/json') {
    throw Object.assign(new Error('request bodies must use application/json content type'), { statusCode: 415 });
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('request body exceeds 256 KiB safety limit');
  return raw ? JSON.parse(raw) : {};
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function decodeSegment(value, label = 'path identifier') {
  try { return decodeURIComponent(value); }
  catch { throw Object.assign(new Error(`malformed URL encoding in ${label}`), { statusCode: 400 }); }
}

// Requests without a Host header (HTTP/1.0 style clients) carry no rebinding
// claim and keep the legacy acceptance. Once a Host is present it must name a
// loopback address or the request comes from a rebound external name.
function localHostViolation(req) {
  const raw = req.headers.host;
  if (raw === undefined) return null;
  let hostname;
  try { ({ hostname } = new URL(`http://${raw}`)); }
  catch { return 'malformed Host header'; }
  if (!LOCAL_HOSTNAMES.has(hostname)) return `Host hostname ${hostname} is not the local loopback address`;
  return null;
}

// Browsers attach Origin on fetch/browser submissions; non-browser service and
// CLI callers omit it. Origin must therefore be absent or exactly the looping
// http address this server is listening on.
function localOriginViolation(req, serverPort) {
  if (req.headers.origin === undefined) return null;
  let parsed;
  try { parsed = new URL(String(req.headers.origin)); }
  catch { return 'malformed Origin header'; }
  if (parsed.protocol !== 'http:') return `Origin protocol ${parsed.protocol} is not the local http address`;
  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) return `Origin host ${parsed.hostname} is not the local loopback address`;
  const originPort = parsed.port === '' ? '80' : parsed.port;
  if (originPort !== String(serverPort)) return `Origin port ${originPort} is not the local server port ${serverPort}`;
  return null;
}

// Recorded identity describes the intake mechanism behind the request; it is
// not a verified human approval and must never be presented as one.
function callerPrincipal(req) {
  if (req.headers.origin === undefined) return { id: 'no-origin-local-caller', kind: 'local-caller' };
  return { id: 'same-origin-browser-session', kind: 'browser-session' };
}

export function createDemoServer({ deepAudit, repositories = new LocalRepositoryService(), apiOnly = false, apiUrl, env = process.env, prVerification, adapters = {} } = {}) {
  const prVerificationRuntime = prVerification ?? createPrVerificationRuntime({ env });
  if (apiUrl !== undefined) {
    // The web-to-API proxy is the only place Authorization is forwarded; keep
    // that target operator-configured and loopback-only.
    let target;
    try { target = new URL(String(apiUrl)); }
    catch { throw new Error('local API target must be a valid URL'); }
    if (target.protocol !== 'http:' || !LOCAL_HOSTNAMES.has(target.hostname)
      || target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname)) {
      throw new Error('local API target must use a loopback HTTP origin so Authorization is only forwarded to the configured local API');
    }
    apiUrl = target.origin;
  }
  const approvalsService = new LocalHumanApprovalsService({ env, evidenceProvider: auditId => {
    const audit = (adapters.audits ?? auditsService).get(auditId);
    if (!audit || audit.status === 'Running') return null;
    const repair = repairsService.get(auditId);
    const proof = artifactsService.get(auditId);
    if (!proof) return null;
    return {
      auditId,
      repository: audit.repository?.fullName ?? null,
      baseBranch: env.VERIFIAI_GITHUB_BASE_BRANCH || 'main',
      repair,
      proof,
      browser: browserResults.get(auditId) ?? null,
    };
  } });
  const ownerAudit = adapters.audits ?? new MasterAuditService(repositories, { env });
  const auditsService = ownerAudit;
  const audits = auditsService;
  const browserResults = new Map();
  const browserImages = new Map();
  const browserTasks = new Set();
  let browserController;
  const repairs = adapters.repairs ?? new LocalRepairService(repositories, auditsService, { env });
  const repairsService = repairs;
  const artifacts = adapters.artifacts ?? new LocalArtifactService({ env, screenshotResolver: async ref => {
    const match = ref.match(/^\/api\/local\/audits\/([^/]+)\/browser\/screenshot$/);
    const imagePath = match && browserImages.get(decodeSegment(match[1], 'screenshot reference'));
    if (!imagePath) throw new Error('screenshot not retained');
    const handle = await open(imagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid() || info.size > MAX_SCREENSHOT_BYTES) throw new Error('Invalid screenshot');
      return await handle.readFile();
    } finally { await handle.close(); }
  } });
  const artifactsService = artifacts;
  const pullRequests = adapters.pullRequests ?? new LocalPrService(audits, repairs, artifacts, { env, transportFactory: adapters.transportFactory });
  const getDeepAudit = async () => {
    if (deepAudit) return deepAudit;
    const { DeepAuditService } = await import('../services/deep-audit/index.mjs');
    deepAudit = new DeepAuditService();
    return deepAudit;
  };

  let server;
  const serverPort = () => {
    const address = server?.address?.();
    return typeof address === 'object' && address ? address.port : Number(process.env.WEB_PORT ?? 4173);
  };
  const handleRequest = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    const hostViolation = localHostViolation(req);
    if (hostViolation) return sendJson(res, 403, { status: 'Incomplete', error: `${hostViolation}; request refused` });
    const originViolation = localOriginViolation(req, serverPort());
    if (originViolation) return sendJson(res, 403, { status: 'Incomplete', error: `${originViolation}; request refused` });

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: apiOnly ? 'verifai-local-api' : 'verifai-local' });
    }

    if (apiUrl && url.pathname.startsWith('/api/local/')) {
      try {
        const body = req.method === 'POST' ? JSON.stringify(await readJson(req)) : undefined;
        // Authorization is forwarded to the configured loopback API only and
        // never recorded, echoed into a response body or logged here.
        const forwardHeaders = { 'content-type': 'application/json' };
        if (req.headers.authorization) forwardHeaders.authorization = String(req.headers.authorization);
        if (req.headers['idempotency-key']) forwardHeaders['idempotency-key'] = String(req.headers['idempotency-key']);
        const upstream = await fetch(`${apiUrl}${url.pathname}`, { method: req.method, headers: forwardHeaders, body, redirect: 'error', signal: AbortSignal.timeout(120_000) });
        if (/^\/api\/local\/audits\/[^/]+\/browser\/screenshot$/.test(url.pathname) && upstream.ok) {
          const image = Buffer.from(await upstream.arrayBuffer());
          if (image.length > MAX_SCREENSHOT_BYTES || upstream.headers.get('content-type') !== 'image/png') throw new Error('Invalid browser screenshot');
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length, 'cache-control': 'no-store' });
          return res.end(image);
        }
        if (/^\/api\/local\/audits\/[^/]+\/artifacts\/.+/.test(url.pathname) && upstream.ok) {
          const bytes = Buffer.from(await upstream.arrayBuffer());
          if (bytes.length > 50 * 1024 * 1024) throw new Error('Artifact exceeds 50 MiB safety limit');
          res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': upstream.headers.get('content-disposition') || 'attachment' });
          return res.end(bytes);
        }
        return sendJson(res, upstream.status, await upstream.json());
      } catch (error) { return sendJson(res, error.statusCode ?? 502, { status: 'Incomplete', error: 'Local API unavailable or request invalid' }); }
    }

    if (await prVerificationRuntime.handle(req, res)) return;
    if (req.method === 'GET' && url.pathname === '/api/local/capabilities') {
      const configured = describePrincipalConfig(env);
      const publicationSecrets = (env.VERIFIAI_PR_APPROVAL_SECRET || env.VERIFIAI_STATE_SECRET || '').length >= 32 && Boolean(env.VERIFIAI_GITHUB_TOKEN || env.GITHUB_TOKEN);
      // Unauthenticated view: configuration state and required role names
      // only. Principal identities, scopes and tokens never surface here.
      return sendJson(res, 200, {
        service: apiOnly ? 'verifai-local-api' : 'verifai-local',
        auth: {
          configured: configured.configured,
          humanPrincipalConfigured: configured.humanPrincipalConfigured === true,
          agentPrincipalConfigured: configured.agentPrincipalConfigured === true,
        },
        approval: { ttlMinutes: approvalsService.ttlMinutes, endpoints: ['POST /api/local/audits/:id/approval (human bearer authorization)'] },
        publication: {
          available: configured.configured && configured.humanPrincipalConfigured === true && publicationSecrets,
          endpoints: ['POST /api/local/audits/:id/pr {approvalId} (human bearer authorization)'],
        },
      });
    }

    const approvalRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/approval$/);
    if (req.method === 'POST' && approvalRoute) {
      try {
        const id = decodeSegment(approvalRoute[1]);
        // Authenticate before any audit existence or evidence lookups so the
        // endpoint fails closed without leaking state to unauthorized callers.
        const principal = authorizeBearer({ env, authorization: req.headers.authorization, kind: 'human' });
        const audit = audits.get(id);
        if (!audit) return sendJson(res, 404, { status: 'Incomplete', error: 'audit not found' });
        if (audit.status === 'Running') return sendJson(res, 409, { status: 'Incomplete', error: 'audit still running' });
        assertPrincipalScope(principal, audit.repository?.fullName);
        const issued = approvalsService.issue({ principal, auditId: id });
        return sendJson(res, 201, { approved: true, ...issued, endpoints: { publish: `POST /api/local/audits/${encodeURIComponent(id)}/pr {approvalId}` } });
      } catch (error) {
        const statusCode = error.statusCode ?? 409;
        const status = statusCode === 401 || statusCode === 403 ? 'Unauthenticated' : 'Incomplete';
        return sendJson(res, statusCode, { status, error: String(error?.message ?? error) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/local/audits') {
      try { const body = await readJson(req); return sendJson(res, 202, audits.start(body.url)); }
      catch (error) { return sendJson(res, error.statusCode ?? 400, { status: 'Incomplete', error: String(error.message) }); }
    }
    const browserRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/browser(?:\/(screenshot))?$/);
    if (browserRoute) {
      const id = decodeSegment(browserRoute[1]);
      const audit = audits.get(id);
      if (!audit) return sendJson(res, 404, { status: 'Incomplete', error: 'audit not found' });
      if (req.method === 'GET' && browserRoute[2]) {
        const imagePath = browserImages.get(id);
        if (!imagePath) return sendJson(res, 404, { status: 'Incomplete', error: 'screenshot not executed or no longer retained' });
        let handle;
        try {
          handle = await open(imagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await handle.stat();
          if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > MAX_SCREENSHOT_BYTES) throw new Error('Invalid screenshot');
          const image = await handle.readFile();
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length, 'cache-control': 'no-store' });
          return res.end(image);
        } catch { return sendJson(res, 404, { status: 'Incomplete', error: 'screenshot unavailable' }); }
        finally { await handle?.close(); }
      }
      if (req.method === 'GET' && !browserRoute[2]) {
        const result = browserResults.get(id);
        return result ? sendJson(res, 200, result) : sendJson(res, 404, { status: 'Incomplete', error: 'browser journey not executed' });
      }
      if (req.method === 'POST' && !browserRoute[2]) {
        if (audit.status !== 'Completed') return sendJson(res, 409, { status: 'Incomplete', error: 'completed M5 audit required' });
        let lease;
        try {
          lease = acquireLocalAudit(AbortSignal.timeout(60_000));
          browserController = new AbortController();
          const task = runBrowserJourney({ auditId: id, getAudit: auditId => audits.get(auditId), env,
            signal: AbortSignal.any([lease.signal, browserController.signal]) });
          browserTasks.add(task);
          let result;
          try { result = await task; } finally { browserTasks.delete(task); }
          const screenshotUrl = `/api/local/audits/${encodeURIComponent(id)}/browser/screenshot`;
          result = { ...result, target: 'Local integration fixture; not verification of the cloned application',
            screenshotRefs: result.screenshot ? [screenshotUrl] : [],
            consoleErrors: result.consoleErrors ?? (result.console || []).filter(entry => entry.params?.type === 'error' || entry.params?.entry?.level === 'error'),
            networkEvidence: result.networkEvidence ?? result.network ?? [] };
          const previousImage = browserImages.get(id);
          if (previousImage) await rm(previousImage, { force: true });
          browserImages.delete(id);
          if (result.screenshot && /^browser-[a-f0-9-]{36}$/.test(result.journeyId)) browserImages.set(id, join(screenshotRoot, `${result.journeyId}.png`));
          browserResults.set(id, result);
          while (browserResults.size > 30) {
            const oldId = browserResults.keys().next().value;
            const oldImage = browserImages.get(oldId);
            if (oldImage) await rm(oldImage, { force: true });
            browserImages.delete(oldId);
            browserResults.delete(oldId);
          }
          return sendJson(res, 200, result);
        } catch (error) { return sendJson(res, error.statusCode ?? 500, { status: 'Incomplete', error: String(error.message) }); }
        finally { if (lease) { browserController = undefined; lease.release(); } }
      }
      return sendJson(res, 405, { status: 'Incomplete', error: 'method not allowed' });
    }
    const masterRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)$/);
    if (req.method === 'GET' && masterRoute) {
      const id = decodeSegment(masterRoute[1]);
      const run = audits.get(id);
      if (!run) return sendJson(res, 404, { status: 'Incomplete', error: 'audit not found' });
      if (browserResults.has(id)) run.browser = browserResults.get(id);
      if (run.status !== 'Running') {
        try {
          const repair=repairs.get(id);
          return sendJson(res, 200, { ...run, repair, proof: await artifacts.getOrPublish(run, { repair, browser: run.browser }), pullRequest: pullRequests.get(id) });
        }
        catch (error) { return sendJson(res, 200, { ...run, proof: { status: 'Incomplete', error: String(error?.message ?? error) } }); }
      }
      return sendJson(res, 200, run);
    }

    const repairRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/repair$/);
    if (req.method === 'POST' && repairRoute) {
      try {
        const body = await readJson(req);
        const id = decodeSegment(repairRoute[1]);
        const repair = await repairs.repair(id, body.patch);
        const run = audits.get(id);
        const proof = run && run.status !== 'Running' ? await artifacts.getOrPublish(run, { repair, browser: browserResults.get(id) }) : undefined;
        return sendJson(res, 200, { ...repair, proof });
      } catch (error) {
        return sendJson(res, error.statusCode ?? 409, { status: 'Incomplete', error: String(error?.message ?? error) });
      }
    }
    if (req.method === 'GET' && repairRoute) {
      const repair = repairs.get(decodeSegment(repairRoute[1]));
      return repair ? sendJson(res, 200, repair) : sendJson(res, 404, { status: 'Incomplete', error: 'repair not found' });
    }

    const artifactRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/artifacts$/);
    if (req.method === 'GET' && artifactRoute) {
      const id = decodeSegment(artifactRoute[1]);
      const run = audits.get(id);
      if (!run) return sendJson(res, 404, { status: 'Incomplete', error: 'audit not found' });
      if (run.status === 'Running') return sendJson(res, 409, { status: 'Incomplete', error: 'audit still running' });
      try { return sendJson(res, 200, await artifacts.getOrPublish(run, { repair: repairs.get(id), browser: browserResults.get(id) })); }
      catch (error) { return sendJson(res, 500, { status: 'Incomplete', error: String(error?.message ?? error) }); }
    }

    const artifactFileRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/artifacts\/(.+)$/);
    if (req.method === 'GET' && artifactFileRoute) {
      const id = decodeSegment(artifactFileRoute[1]);
      const artifactPath = decodeSegment(artifactFileRoute[2], 'artifact path');
      try {
        const { item, buffer } = await artifacts.read(id, artifactPath);
        const contentType = artifactPath.endsWith('.json') ? 'application/json; charset=utf-8'
          : artifactPath.endsWith('.png') ? 'image/png'
            : 'text/plain; charset=utf-8';
        res.writeHead(200, {
          'content-type': contentType,
          'content-length': buffer.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-disposition': `attachment; filename="${encodeURIComponent(item.path.split('/').at(-1) || 'artifact')}"`,
        });
        return res.end(buffer);
      } catch (error) {
        return sendJson(res, error.statusCode ?? 404, { status: 'Incomplete', error: String(error?.message ?? error) });
      }
    }

    const prRouteLocal = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/pr$/);
    if (req.method === 'POST' && prRouteLocal) {
      try {
        const id = decodeSegment(prRouteLocal[1]);
        // Authenticate before reading the body or the audit: fail closed.
        const principal = authorizeBearer({ env, authorization: req.headers.authorization, kind: 'human' });
        const body = await readJson(req);
        const result = await pullRequests.create(id, { principal, approvalId: body?.approvalId, approvals: approvalsService });
        return sendJson(res, 201, result);
      } catch (error) {
        return sendJson(res, error.statusCode ?? 409, { status: 'Incomplete', error: String(error?.message ?? error) });
      }
    }
    if (req.method === 'GET' && prRouteLocal) {
      const result = pullRequests.get(decodeSegment(prRouteLocal[1]));
      return result ? sendJson(res, 200, result) : sendJson(res, 404, { status: 'Incomplete', error: 'PR not created' });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/repositories') {
      try {
        const body = await readJson(req);
        const result = await repositories.clone(body.url);
        return sendJson(res, 201, result);
      } catch (error) {
        return sendJson(res, error.statusCode ?? 400, { error: String(error?.message ?? error) });
      }
    }

    const cleanupRoute = url.pathname.match(/^\/api\/local\/repositories\/([^/]+)\/cleanup$/);
    if (req.method === 'POST' && cleanupRoute) {
      try {
        const cleaned = await repositories.cleanup(decodeSegment(cleanupRoute[1]));
        return cleaned ? sendJson(res, 200, { cleaned: true }) : sendJson(res, 404, { error: 'temporary repository not found' });
      } catch (error) {
        return sendJson(res, error.statusCode ?? 500, { error: String(error?.message ?? error) });
      }
    }

    const auditRoute = url.pathname.match(/^\/api\/local\/repositories\/([^/]+)\/audit$/);
    if (req.method === 'POST' && auditRoute) {
      try {
        const record = repositories.get(decodeSegment(auditRoute[1]));
        if (!record) return sendJson(res, 404, { error: 'temporary repository not found' });
        const { auditRepository } = await import('../services/local-audit.mjs');
        const result = await auditRepository(record);
        return sendJson(res, 200, { id: record.id, repository: record.repository, ...result });
      } catch (error) {
        return sendJson(res, error.statusCode ?? 500, { status: 'Incomplete', error: String(error.message) });
      }
    }

    const analyzeRoute = url.pathname.match(/^\/api\/local\/repositories\/([^/]+)\/analyze$/);
    if (req.method === 'POST' && analyzeRoute) {
      try {
        const record = repositories.get(decodeSegment(analyzeRoute[1]));
        if (!record) return sendJson(res, 404, { error: 'temporary repository not found' });
        const { analyzeRepository } = await import('../services/local-analysis.mjs');
        const analysis = await analyzeRepository(record, { env: process.env });
        return sendJson(res, 200, {
          id: record.id,
          repository: record.repository,
          finding: analysis.finding,
          model: analysis.model,
          files: { count: record.files.count },
        });
      } catch (error) {
        const message = String(error?.message ?? error);
        const status = /not configured/i.test(message) ? 503 : 502;
        return sendJson(res, status, { error: message });
      }
    }

    if (apiOnly) return sendJson(res, 404, { error: 'local API route not found' });

    if (req.method === 'POST' && url.pathname === '/api/demo/deep-audit') {
      try {
        const body = await readJson(req);
        const run = await (await getDeepAudit()).run(body);
        return sendJson(res, 200, { run });
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    }

    const runRoute = url.pathname.match(/^\/api\/demo\/deep-audit\/([^/]+)$/);
    if (req.method === 'GET' && runRoute) {
      const run = (await getDeepAudit()).get(decodeSegment(runRoute[1]));
      return run ? sendJson(res, 200, { run }) : sendJson(res, 404, { error: 'run not found' });
    }

    const steerRoute = url.pathname.match(/^\/api\/demo\/deep-audit\/([^/]+)\/steer$/);
    if (req.method === 'POST' && steerRoute) {
      try {
        const body = await readJson(req);
        const event = await (await getDeepAudit()).steer(decodeSegment(steerRoute[1]), body.instruction);
        return sendJson(res, 200, { event });
      } catch (error) {
        return sendJson(res, /not found/i.test(String(error)) ? 404 : 400, { error: String(error?.message ?? error) });
      }
    }

    const prRoute = url.pathname.match(/^\/api\/demo\/deep-audit\/([^/]+)\/pr$/);
    if (req.method === 'POST' && prRoute) {
      try {
        const pr = (await getDeepAudit()).createPrPackage(decodeSegment(prRoute[1]));
        return sendJson(res, 200, { pr });
      } catch (error) {
        return sendJson(res, /not found/i.test(String(error)) ? 404 : 409, { error: String(error?.message ?? error) });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('method not allowed');
    }

    const path = normalize(url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''));
    if (path.startsWith('..')) {
      res.writeHead(403);
      return res.end('forbidden');
    }

    try {
      const body = await readFile(join(root, path));
      res.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store'
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    } catch {
      res.writeHead(404);
      return res.end('not found');
    }
  };
  server = createServer((req, res) => {
    // Top-level safety boundary: every router rejection becomes an HTTP
    // response (400/500-class), never an unhandled rejection that would stop
    // the whole local API process.
    handleRequest(req, res).catch(error => {
      if (!res.headersSent) {
        try { return sendJson(res, error?.statusCode ?? 500, { status: 'Incomplete', error: String(error?.message ?? error) }); }
        catch { /* fall through: socket is gone */ }
      }
      try { res.destroy(); } catch { /* already destroyed */ }
    });
  });

  server.shutdown = async () => {
    await prVerificationRuntime.shutdown();
    browserController?.abort(new Error('Server stopping'));
    abortActiveAudit();
    await Promise.allSettled([...browserTasks]);
    await audits.waitForIdle();
    await repositories.cleanupAll();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  server.on('close', () => { void repositories.cleanupAll(); });
  return server;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  if (!process.env.VERIFIAI_LOCAL_API_URL) {
    const { recoverRepositoryWorkspaces } = await import('../services/repository-workspaces.mjs');
    const { recoverSandboxes } = await import('../services/local-sandbox.mjs');
    await recoverRepositoryWorkspaces();
    await recoverSandboxes().catch(error => console.warn(`Incomplete sandbox recovery: ${error.message}`));
  }
  const server = createDemoServer({ apiUrl: process.env.VERIFIAI_LOCAL_API_URL });
  server.listen(Number(process.env.WEB_PORT ?? 4173), process.env.WEB_HOST ?? '127.0.0.1', () => {
    console.log('VERIFAI local web/API: http://127.0.0.1:4173');
  });
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.shutdown().then(() => process.exit(0), error => { console.error(`Incomplete shutdown: ${error.message}`); process.exit(1); });
  });
}
