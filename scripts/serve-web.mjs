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
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) { const error = new Error('request body exceeds 256 KiB safety limit'); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('request body exceeds 256 KiB safety limit');
  return raw ? JSON.parse(raw) : {};
}

export function createDemoServer({ deepAudit, repositories = new LocalRepositoryService(), apiOnly = false, apiUrl, env = process.env } = {}) {
  const audits = new MasterAuditService(repositories, { env });
  const browserResults = new Map();
  const browserImages = new Map();
  const browserTasks = new Set();
  let browserController;
  const repairs = new LocalRepairService(repositories, audits, { env });
  const artifacts = new LocalArtifactService({ env, screenshotResolver: async (ref) => {
    const match = typeof ref === 'string' ? ref.match(/^\/api\/local\/audits\/([^/]+)\/browser\/screenshot$/) : null;
    if (!match) return undefined;
    const id = decodeURIComponent(match[1]);
    const imagePath = browserImages.get(id);
    if (!imagePath) return undefined;
    let handle;
    try {
      handle = await open(imagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > MAX_SCREENSHOT_BYTES) return undefined;
      return await handle.readFile();
    } finally { await handle?.close(); }
  }});
  const pullRequests = new LocalPrService(audits, repairs, artifacts, { env });
  const getDeepAudit = async () => {
    if (deepAudit) return deepAudit;
    const { DeepAuditService } = await import('../services/deep-audit/index.mjs');
    deepAudit = new DeepAuditService();
    return deepAudit;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: apiOnly ? 'verifai-local-api' : 'verifai-local' });
    }

    if (apiUrl && url.pathname.startsWith('/api/local/')) {
      try {
        const body = req.method === 'POST' ? JSON.stringify(await readJson(req)) : undefined;
        const upstream = await fetch(`${apiUrl}${url.pathname}`, { method: req.method, headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(120_000) });
        if (/^\/api\/local\/audits\/[^/]+\/browser\/screenshot$/.test(url.pathname) && upstream.ok) {
          const image = Buffer.from(await upstream.arrayBuffer());
          if (image.length > MAX_SCREENSHOT_BYTES || upstream.headers.get('content-type') !== 'image/png') throw new Error('Invalid browser screenshot');
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length, 'cache-control': 'no-store' });
          return res.end(image);
        }
        if (/^\/api\/local\/audits\/[^/]+\/artifacts\/.+/.test(url.pathname) && upstream.ok) {
          const bytes = Buffer.from(await upstream.arrayBuffer());
          if (bytes.length > 50 * 1024 * 1024) throw new Error('Artifact exceeds 50 MiB safety limit');
          res.writeHead(200, {
            'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
            'content-length': bytes.length,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff'
          });
          return res.end(bytes);
        }
        return sendJson(res, upstream.status, await upstream.json());
      } catch (error) { return sendJson(res, error.statusCode ?? 502, { status: 'Incomplete', error: 'Local API unavailable or request invalid' }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/local/audits') {
      try { const body = await readJson(req); return sendJson(res, 202, audits.start(body.url)); }
      catch (error) { return sendJson(res, error.statusCode ?? 400, { status: 'Incomplete', error: String(error.message) }); }
    }
    const browserRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/browser(?:\/(screenshot))?$/);
    if (browserRoute) {
      const id = decodeURIComponent(browserRoute[1]);
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
      const id = decodeURIComponent(masterRoute[1]);
      const run = audits.get(id);
      if (!run) return sendJson(res, 404, { status: 'Incomplete', error: 'audit not found' });
      const browser = browserResults.get(id);
      if (browser) run.browser = browser;
      if (run.status !== 'Running') {
        try {
          const repair = repairs.get(id);
          const proof = await artifacts.refresh(run, { repair, browser });
          return sendJson(res, 200, { ...run, repair, proof, pullRequest: pullRequests.get(id) });
        } catch (error) {
          return sendJson(res, 200, { ...run, repair: repairs.get(id), proof: { status:'Incomplete', error:String(error?.message ?? error) }, pullRequest: pullRequests.get(id) });
        }
      }
      return sendJson(res, 200, run);
    }

    const repairRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/repair$/);
    if (req.method === 'POST' && repairRoute) {
      try {
        const body = await readJson(req);
        const id = decodeURIComponent(repairRoute[1]);
        const repair = await repairs.repair(id, body.patch);
        const run = audits.get(id);
        const proof = run && run.status !== 'Running' ? await artifacts.refresh(run, { repair, browser: browserResults.get(id) }) : undefined;
        return sendJson(res, 200, { ...repair, proof });
      } catch (error) {
        return sendJson(res, error.statusCode ?? 409, { status:'Incomplete', error:String(error?.message ?? error) });
      }
    }
    if (req.method === 'GET' && repairRoute) {
      const repair = repairs.get(decodeURIComponent(repairRoute[1]));
      return repair ? sendJson(res, 200, repair) : sendJson(res, 404, { status:'Incomplete', error:'repair not found' });
    }

    const artifactRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/artifacts$/);
    if (req.method === 'GET' && artifactRoute) {
      const id = decodeURIComponent(artifactRoute[1]);
      const run = audits.get(id);
      if (!run) return sendJson(res, 404, { status:'Incomplete', error:'audit not found' });
      if (run.status === 'Running') return sendJson(res, 409, { status:'Incomplete', error:'audit still running' });
      try {
        return sendJson(res, 200, await artifacts.refresh(run, { repair: repairs.get(id), browser: browserResults.get(id) }));
      } catch (error) {
        return sendJson(res, 500, { status:'Incomplete', error:String(error?.message ?? error) });
      }
    }

    const artifactFileRoute = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/artifacts\/(.+)$/);
    if (req.method === 'GET' && artifactFileRoute) {
      const id = decodeURIComponent(artifactFileRoute[1]);
      const artifactPath = decodeURIComponent(artifactFileRoute[2]);
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
          'content-disposition': `attachment; filename="${encodeURIComponent(item.path.split('/').at(-1) || 'artifact')}"`
        });
        return res.end(buffer);
      } catch (error) {
        return sendJson(res, error.statusCode ?? 404, { status:'Incomplete', error:String(error?.message ?? error) });
      }
    }

    const prRouteLocal = url.pathname.match(/^\/api\/local\/audits\/([^/]+)\/pr$/);
    if (req.method === 'POST' && prRouteLocal) {
      try {
        const id = decodeURIComponent(prRouteLocal[1]);
        const result = await pullRequests.create(id);
        return sendJson(res, 201, result);
      } catch (error) {
        return sendJson(res, error.statusCode ?? 409, { status:'Incomplete', error:String(error?.message ?? error) });
      }
    }
    if (req.method === 'GET' && prRouteLocal) {
      const result = pullRequests.get(decodeURIComponent(prRouteLocal[1]));
      return result ? sendJson(res, 200, result) : sendJson(res, 404, { status:'Incomplete', error:'PR not created' });
    }

    if (req.method === 'POST' && url.pathname === '/api/local/repositories') {
      try {
        const body = await readJson(req);
        const result = await repositories.clone(body.url);
        return sendJson(res, 201, result);
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    const cleanupRoute = url.pathname.match(/^\/api\/local\/repositories\/([^/]+)\/cleanup$/);
    if (req.method === 'POST' && cleanupRoute) {
      try {
        const cleaned = await repositories.cleanup(decodeURIComponent(cleanupRoute[1]));
        return cleaned ? sendJson(res, 200, { cleaned: true }) : sendJson(res, 404, { error: 'temporary repository not found' });
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    }

    const auditRoute = url.pathname.match(/^\/api\/local\/repositories\/([^/]+)\/audit$/);
    if (req.method === 'POST' && auditRoute) {
      try {
        const record = repositories.get(decodeURIComponent(auditRoute[1]));
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
        const record = repositories.get(decodeURIComponent(analyzeRoute[1]));
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
      const run = (await getDeepAudit()).get(decodeURIComponent(runRoute[1]));
      return run ? sendJson(res, 200, { run }) : sendJson(res, 404, { error: 'run not found' });
    }

    const steerRoute = url.pathname.match(/^\/api\/demo\/deep-audit\/([^/]+)\/steer$/);
    if (req.method === 'POST' && steerRoute) {
      try {
        const body = await readJson(req);
        const event = await (await getDeepAudit()).steer(decodeURIComponent(steerRoute[1]), body.instruction);
        return sendJson(res, 200, { event });
      } catch (error) {
        return sendJson(res, /not found/i.test(String(error)) ? 404 : 400, { error: String(error?.message ?? error) });
      }
    }

    const prRoute = url.pathname.match(/^\/api\/demo\/deep-audit\/([^/]+)\/pr$/);
    if (req.method === 'POST' && prRoute) {
      try {
        const pr = (await getDeepAudit()).createPrPackage(decodeURIComponent(prRoute[1]));
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
  });

  server.shutdown = async () => {
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
