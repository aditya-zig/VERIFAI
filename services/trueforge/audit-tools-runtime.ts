import type {
  AgentWorkerLaunchBrief,
  EvidenceInput,
} from '../../packages/contracts/src/index.js';
import { WorkerNetworkPolicy } from '../orchestrator/guardrails.js';

export type AuditToolName =
  | 'repo_tree'
  | 'repo_read'
  | 'target_http'
  | 'performance_probe'
  | 'mirofish_personas'
  | 'strix_scan'
  | 'zap_scan'
  | 'schemathesis_fuzz'
  | 'load_test'
  | 'toxiproxy_fault'
  | 'computer_use'
  | 'apply_candidate_patch';

export interface AuditToolRuntimeOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function capabilitySet(brief: AgentWorkerLaunchBrief): Set<string> {
  return new Set(
    brief.tools.flatMap((grant) => [grant.name, ...grant.capabilities])
      .map((value) => value.toLowerCase()),
  );
}

function hasAny(caps: Set<string>, values: string[]): boolean {
  return values.some((value) => caps.has(value) || [...caps].some((cap) => cap.includes(value)));
}

function requireCapability(brief: AgentWorkerLaunchBrief, values: string[], toolName: string): void {
  if (!hasAny(capabilitySet(brief), values)) {
    throw new Error(`${toolName} is not granted to worker ${brief.workerId}`);
  }
}

function safeRepoPath(path: string): string {
  const clean = path.trim().replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) {
    throw new Error('repository path escapes the repository root');
  }
  if (clean.length > 400) throw new Error('repository path is too long');
  return clean;
}

function safeText(text: string, limit = 20_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const keep = ['content-type', 'content-length', 'cache-control', 'location', 'server'];
  return Object.fromEntries(
    keep.map((name) => [name, headers.get(name)]).filter(([, value]) => Boolean(value)),
  ) as Record<string, string>;
}

function targetUrlFor(brief: AgentWorkerLaunchBrief): URL {
  if (!brief.target?.url) throw new Error('this tool requires a runnable target URL');
  return new URL(brief.target.url);
}

function allowedPolicy(
  brief: AgentWorkerLaunchBrief,
  env: Record<string, string | undefined>,
): WorkerNetworkPolicy {
  const allowHosts = new Set(brief.constraints.networkAllowlist.map((value) => value.trim()).filter(Boolean));
  if (brief.target?.url) allowHosts.add(new URL(brief.target.url).hostname);
  for (const serviceUrl of [
    env.VERIFIAI_EXTERNAL_ENGINE_URL,
    env.VERIFIAI_BROWSER_USE_URL,
    env.VERIFIAI_CUA_URL,
    env.VERIFIAI_COMPUTER_USE_URL,
    env.VERIFIAI_MUTATION_SERVICE_URL,
  ]) {
    if (serviceUrl) allowHosts.add(new URL(serviceUrl).hostname);
  }
  return new WorkerNetworkPolicy([...allowHosts]);
}

function argString(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value === 'string' && value.length) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${key} is required`);
}

function argNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function engineEvidence(engine: string, result: any): EvidenceInput {
  const items = Array.isArray(result?.evidence) ? result.evidence : [];
  const executed = items.filter((item: any) => item?.executed === true);
  const outcome = executed.some((item: any) => item?.payload?.outcome === 'fail')
    ? 'fail'
    : executed.some((item: any) => item?.payload?.outcome === 'pass')
      ? 'pass'
      : 'unknown';
  return {
    kind: engine === 'k6' || engine === 'locust' ? 'metric' : 'runtime',
    source: engine,
    executed: executed.length > 0,
    payload: {
      outcome,
      status: result?.status ?? 'unknown',
      observations: Array.isArray(result?.observations) ? result.observations.slice(0, 100) : [],
      health: result?.health,
      upstreamEvidence: items.slice(0, 100),
    },
  };
}

function computerUseOutcome(
  engine: 'browser-use' | 'cua' | 'generic',
  result: any,
  responseOk: boolean,
  identityOk: boolean,
): 'pass' | 'fail' | 'unknown' {
  const executed = responseOk && result?.ok !== false && identityOk;
  if (!executed) return 'unknown';
  if (engine === 'cua' && result?.completed !== true) return 'unknown';
  return result?.successful === false ? 'fail' : 'pass';
}

export function incompleteToolEvidence(toolName: string, error: unknown): EvidenceInput {
  return {
    kind: 'runtime',
    source: toolName,
    executed: false,
    payload: {
      outcome: 'unknown',
      incomplete: true,
      error: safeText(String((error as any)?.message ?? error), 2_000),
    },
  };
}

export async function executeAuditTool(
  brief: AgentWorkerLaunchBrief,
  toolName: AuditToolName,
  args: Record<string, unknown>,
  options: AuditToolRuntimeOptions = {},
): Promise<EvidenceInput> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const policy = allowedPolicy(brief, env);

  const externalEngine = async (
    engine: 'strix' | 'zap' | 'schemathesis' | 'locust' | 'k6' | 'toxiproxy' | 'mirofish',
    experiment: Record<string, unknown>,
    environment: Record<string, unknown> = {},
  ): Promise<EvidenceInput> => {
    const baseUrl = env.VERIFIAI_EXTERNAL_ENGINE_URL;
    if (!baseUrl) throw new Error('VERIFIAI_EXTERNAL_ENGINE_URL is not configured');
    policy.assertUrl(baseUrl);
    const targetUrl = brief.target?.url ? new URL(brief.target.url) : null;
    const response = await fetchImpl(new URL('/execute', baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.VERIFIAI_EXTERNAL_ENGINE_TOKEN
          ? { authorization: `Bearer ${env.VERIFIAI_EXTERNAL_ENGINE_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        engine,
        experiment,
        context: {
          target: targetUrl
            ? { baseUrl: targetUrl.toString(), repository: brief.repository.fullName }
            : { repository: brief.repository.fullName },
          environment,
        },
      }),
      signal: AbortSignal.timeout(Math.min(brief.constraints.timeoutMs, 175_000)),
    });
    const result: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `external engine service HTTP ${response.status}: ${safeText(JSON.stringify(result), 2_000)}`,
      );
    }
    return engineEvidence(engine, result);
  };

  if (toolName === 'repo_tree') {
    requireCapability(brief, ['repository', 'repo', 'source', 'security'], toolName);
    const prefix = typeof args.prefix === 'string' ? args.prefix : undefined;
    const url = `https://api.github.com/repos/${brief.repository.fullName}/git/trees/${encodeURIComponent(brief.repository.commitSha)}?recursive=1`;
    policy.assertUrl(url);
    const response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'verifiai-trueforge-mcp' },
      signal: AbortSignal.timeout(Math.min(15_000, brief.constraints.timeoutMs)),
    });
    const body: any = await response.json().catch(() => ({}));
    const paths = (Array.isArray(body?.tree) ? body.tree : [])
      .filter((entry: any) => entry?.type === 'blob' && typeof entry?.path === 'string')
      .map((entry: any) => entry.path as string)
      .filter((path: string) => !prefix || path.startsWith(prefix))
      .slice(0, 2_000);
    return {
      kind: 'code',
      source: 'github-tree',
      executed: response.ok,
      payload: {
        outcome: response.ok ? 'pass' : 'unknown',
        status: response.status,
        commitSha: brief.repository.commitSha,
        paths,
      },
    };
  }

  if (toolName === 'repo_read') {
    requireCapability(brief, ['repository', 'repo', 'source', 'security'], toolName);
    const clean = safeRepoPath(argString(args, 'path'));
    const url = `https://raw.githubusercontent.com/${brief.repository.fullName}/${encodeURIComponent(brief.repository.commitSha)}/${clean.split('/').map(encodeURIComponent).join('/')}`;
    policy.assertUrl(url);
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'verifiai-trueforge-mcp' },
      signal: AbortSignal.timeout(Math.min(15_000, brief.constraints.timeoutMs)),
    });
    const content = safeText(await response.text(), 30_000);
    return {
      kind: 'code',
      source: 'github-raw',
      executed: response.ok,
      payload: {
        outcome: response.ok ? 'pass' : 'unknown',
        status: response.status,
        path: clean,
        content,
      },
    };
  }

  if (toolName === 'target_http') {
    requireCapability(brief, ['http', 'api', 'chaos', 'performance', 'browser'], toolName);
    const targetUrl = targetUrlFor(brief);
    const method = argString(args, 'method', 'GET').toUpperCase();
    const path = argString(args, 'path', '/');
    const body = typeof args.body === 'string' ? args.body : undefined;
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new Error('unsupported HTTP method');
    }
    if (!['GET', 'HEAD'].includes(method) && !brief.constraints.destructiveAllowed) {
      throw new Error('mutation HTTP methods are forbidden for this worker');
    }
    const url = new URL(path, targetUrl);
    if (url.origin !== targetUrl.origin) throw new Error('target_http cannot leave the assigned target origin');
    policy.assertUrl(url.toString());
    const started = Date.now();
    const response = await fetchImpl(url, {
      method,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      signal: AbortSignal.timeout(Math.min(15_000, brief.constraints.timeoutMs)),
      redirect: 'manual',
    });
    const text = method === 'HEAD' ? '' : safeText(await response.text());
    return {
      kind: 'network',
      source: 'target-http',
      executed: true,
      payload: {
        outcome: response.ok ? 'pass' : 'fail',
        method,
        url: url.toString(),
        status: response.status,
        durationMs: Date.now() - started,
        headers: selectedHeaders(response.headers),
        body: text,
      },
    };
  }

  if (toolName === 'performance_probe') {
    requireCapability(brief, ['performance', 'latency', 'load'], toolName);
    const targetUrl = targetUrlFor(brief);
    const path = argString(args, 'path', '/');
    const requests = Math.max(1, Math.min(10, Math.floor(argNumber(args, 'requests', 3))));
    const url = new URL(path, targetUrl);
    if (url.origin !== targetUrl.origin) throw new Error('performance_probe cannot leave the assigned target origin');
    policy.assertUrl(url.toString());
    const samples: number[] = [];
    const statuses: number[] = [];
    for (let index = 0; index < requests; index += 1) {
      const started = Date.now();
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(Math.min(15_000, brief.constraints.timeoutMs)),
      });
      samples.push(Date.now() - started);
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    return {
      kind: 'metric',
      source: 'performance-probe',
      executed: true,
      payload: {
        outcome: statuses.every((status) => status < 500) ? 'pass' : 'fail',
        url: url.toString(),
        samplesMs: samples,
        p95Ms,
        statuses,
      },
    };
  }

  if (toolName === 'mirofish_personas') {
    requireCapability(brief, ['mirofish', 'personas', 'customer-simulation'], toolName);
    const targetUrl = targetUrlFor(brief);
    const productContext = argString(args, 'productContext');
    if (productContext.length < 20) throw new Error('productContext must be at least 20 characters');
    const requirement = typeof args.requirement === 'string' ? args.requirement : brief.objective;
    const maxRounds = Math.max(1, Math.min(8, Math.floor(argNumber(args, 'maxRounds', 3))));
    const platform = ['parallel', 'twitter', 'reddit'].includes(String(args.platform))
      ? String(args.platform)
      : 'parallel';
    return externalEngine(
      'mirofish',
      { id: `${brief.workerId}-mirofish`, description: requirement },
      {
        mirofish: {
          seedText: productContext,
          requirement,
          projectName: `VERIFIAI ${brief.repository.fullName}`,
          additionalContext: `Target: ${targetUrl.toString()}\nCommit: ${brief.repository.commitSha}`,
          maxRounds,
          platform,
          enableGraphMemoryUpdate: false,
        },
      },
    );
  }

  if (toolName === 'strix_scan') {
    requireCapability(brief, ['security', 'strix'], toolName);
    const targetUrl = targetUrlFor(brief);
    const scanMode = ['quick', 'standard', 'deep'].includes(String(args.scanMode))
      ? String(args.scanMode)
      : 'quick';
    const requestedBudget = Math.max(0.1, Math.min(2.5, argNumber(args, 'maxBudgetUsd', 0.5)));
    const budget = Math.min(requestedBudget, brief.constraints.maxEstimatedSpendUsd ?? requestedBudget);
    return externalEngine(
      'strix',
      { id: `${brief.workerId}-strix`, description: typeof args.instruction === 'string' ? args.instruction : brief.objective },
      { strix: { target: targetUrl.toString(), scanMode, maxBudgetUsd: budget } },
    );
  }

  if (toolName === 'zap_scan') {
    requireCapability(brief, ['security', 'zap', 'dast'], toolName);
    const targetUrl = targetUrlFor(brief);
    const maxChildren = Math.max(1, Math.min(100, Math.floor(argNumber(args, 'maxChildren', 20))));
    const maxAlerts = Math.max(1, Math.min(500, Math.floor(argNumber(args, 'maxAlerts', 200))));
    return externalEngine(
      'zap',
      { id: `${brief.workerId}-zap`, description: brief.objective },
      { zap: { target: targetUrl.toString(), maxChildren, maxAlerts, recurse: true } },
    );
  }

  if (toolName === 'schemathesis_fuzz') {
    requireCapability(brief, ['schemathesis', 'api-fuzz', 'api'], toolName);
    const targetUrl = targetUrlFor(brief);
    const schemaPath = argString(args, 'schemaPath', '/openapi.json');
    const schemaUrl = new URL(schemaPath, targetUrl);
    if (schemaUrl.origin !== targetUrl.origin) throw new Error('schemaPath cannot leave the assigned target origin');
    const maxExamples = Math.max(1, Math.min(100, Math.floor(argNumber(args, 'maxExamples', 25))));
    return externalEngine(
      'schemathesis',
      { id: `${brief.workerId}-schemathesis`, description: brief.objective },
      { schemathesis: { schemaUrl: schemaUrl.toString(), maxExamples } },
    );
  }

  if (toolName === 'load_test') {
    requireCapability(brief, ['performance', 'latency', 'load', 'locust', 'k6'], toolName);
    const targetUrl = targetUrlFor(brief);
    const engine = args.engine === 'k6' ? 'k6' : 'locust';
    const path = argString(args, 'path', '/');
    const probeUrl = new URL(path, targetUrl);
    if (probeUrl.origin !== targetUrl.origin) throw new Error('load-test path cannot leave the assigned target origin');
    const concurrency = Math.max(1, Math.min(25, Math.floor(argNumber(args, 'concurrency', 2))));
    const durationSec = Math.max(1, Math.min(60, Math.floor(argNumber(args, 'durationSec', 10))));
    const maxP95Ms = Math.max(1, Math.min(60_000, argNumber(args, 'maxP95Ms', 1_000)));
    const maxErrorRate = Math.max(0, Math.min(1, argNumber(args, 'maxErrorRate', 0.01)));
    return externalEngine(
      engine,
      { id: `${brief.workerId}-${engine}`, description: brief.objective },
      {
        performance: {
          path: probeUrl.pathname + probeUrl.search,
          concurrency,
          durationSec,
          maxP95Ms,
          maxErrorRate,
        },
      },
    );
  }

  if (toolName === 'toxiproxy_fault') {
    requireCapability(brief, ['chaos', 'toxiproxy', 'fault'], toolName);
    const toxicType = ['latency', 'timeout', 'reset_peer', 'bandwidth'].includes(String(args.toxicType))
      ? String(args.toxicType)
      : 'latency';
    const latencyMs = Math.max(1, Math.min(30_000, Math.floor(argNumber(args, 'latencyMs', 1_000))));
    const attributes = toxicType === 'latency'
      ? { latency: latencyMs, jitter: 0 }
      : toxicType === 'timeout'
        ? { timeout: latencyMs }
        : {};
    return externalEngine(
      'toxiproxy',
      { id: `${brief.workerId}-toxiproxy`, description: brief.objective },
      {
        toxiproxy: {
          name: argString(args, 'name'),
          listen: argString(args, 'listen'),
          upstream: argString(args, 'upstream'),
          toxic: {
            name: toxicType,
            type: toxicType,
            stream: 'downstream',
            toxicity: 1,
            attributes,
          },
          probeUrl: typeof args.probeUrl === 'string' ? args.probeUrl : undefined,
          probeTimeoutMs: Math.max(100, Math.min(30_000, Math.floor(argNumber(args, 'probeTimeoutMs', 5_000)))),
        },
      },
    );
  }

  if (toolName === 'computer_use') {
    requireCapability(brief, ['browser', 'desktop', 'computer-use', 'computer', 'browser-use', 'cua'], toolName);
    const targetUrl = targetUrlFor(brief);
    const browserUseUrl = env.VERIFIAI_BROWSER_USE_URL;
    const cuaUrl = env.VERIFIAI_CUA_URL;
    const genericUrl = env.VERIFIAI_COMPUTER_USE_URL;
    const requested = args.engine === 'cua' || args.engine === 'generic' || args.engine === 'browser-use'
      ? args.engine
      : browserUseUrl ? 'browser-use' : cuaUrl ? 'cua' : 'generic';
    const engine = requested as 'browser-use' | 'cua' | 'generic';
    const serviceUrl = engine === 'browser-use' ? browserUseUrl : engine === 'cua' ? cuaUrl : genericUrl;
    if (!serviceUrl) throw new Error(`${engine} computer-use service is not configured`);
    policy.assertUrl(serviceUrl);
    const endpoint = engine === 'generic' ? serviceUrl : new URL('/run', serviceUrl).toString();
    const objective = argString(args, 'objective');
    const persona = typeof args.persona === 'string' ? args.persona : undefined;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.VERIFIAI_COMPUTER_USE_TOKEN
          ? { authorization: `Bearer ${env.VERIFIAI_COMPUTER_USE_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        auditId: brief.auditId,
        workerId: brief.workerId,
        runId: `${brief.auditId}-${brief.workerId}`,
        targetUrl: targetUrl.toString(),
        objective,
        persona,
      }),
      signal: AbortSignal.timeout(Math.min(brief.constraints.timeoutMs, 120_000)),
    });
    const result: any = await response.json().catch(() => ({}));
    const expectedCommit = engine === 'browser-use'
      ? 'd8110c5ff87ccba887aaa726cdb780f2f84bef8d'
      : engine === 'cua'
        ? '05f29785b508a4441ec3aa06c556a8e8b26c1d71'
        : undefined;
    const expectedEngine = engine === 'browser-use' ? 'Browser Use' : engine === 'cua' ? 'Cua' : undefined;
    const identityOk = engine === 'generic'
      || (result?.engine === expectedEngine && result?.upstreamCommit === expectedCommit);
    const outcome = computerUseOutcome(engine, result, response.ok, identityOk);
    return {
      kind: 'screenshot',
      source: engine,
      executed: response.ok && result?.ok !== false && identityOk,
      payload: {
        engine: result?.engine ?? engine,
        upstreamRepo: result?.upstreamRepo,
        upstreamCommit: result?.upstreamCommit,
        outcome,
        status: response.status,
        objective,
        persona,
        targetUrl: targetUrl.toString(),
        screenshotRefs: Array.isArray(result?.screenshotRefs) ? result.screenshotRefs.slice(0, 20) : [],
        actions: Array.isArray(result?.actions) ? result.actions.slice(0, 100) : [],
        urls: Array.isArray(result?.urls) ? result.urls.slice(0, 100) : [],
        finalResult: typeof result?.finalResult === 'string' ? safeText(result.finalResult, 5_000) : undefined,
        finalResponse: typeof result?.finalResponse === 'string' ? safeText(result.finalResponse, 5_000) : undefined,
        trajectory: Array.isArray(result?.trajectory) ? result.trajectory.slice(0, 100) : [],
        trajectoryRef: typeof result?.trajectoryRef === 'string' ? result.trajectoryRef : undefined,
        completed: result?.completed === true,
        summary: typeof result?.summary === 'string' ? safeText(result.summary, 5_000) : undefined,
        identityVerified: identityOk,
      },
    };
  }

  if (toolName === 'apply_candidate_patch') {
    requireCapability(brief, ['mutation', 'repair', 'edit', 'patch'], toolName);
    if (brief.target?.environment !== 'isolated-mutation' || !brief.constraints.destructiveAllowed) {
      throw new Error('apply_candidate_patch requires an authorized isolated-mutation target');
    }
    const mutationServiceUrl = env.VERIFIAI_MUTATION_SERVICE_URL;
    if (!mutationServiceUrl) throw new Error('VERIFIAI_MUTATION_SERVICE_URL is not configured');
    policy.assertUrl(mutationServiceUrl);
    const diagnosis = argString(args, 'diagnosis');
    const desiredBehavior = argString(args, 'desiredBehavior');
    const response = await fetchImpl(mutationServiceUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.VERIFIAI_MUTATION_SERVICE_TOKEN
          ? { authorization: `Bearer ${env.VERIFIAI_MUTATION_SERVICE_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        auditId: brief.auditId,
        workerId: brief.workerId,
        repository: brief.repository,
        target: brief.target,
        diagnosis,
        desiredBehavior,
      }),
      signal: AbortSignal.timeout(Math.min(120_000, brief.constraints.timeoutMs)),
    });
    const result: any = await response.json().catch(() => ({}));
    const diff = typeof result?.diff === 'string' ? safeText(result.diff, 50_000) : '';
    const branch = typeof result?.branch === 'string' ? result.branch : '';
    const changedFiles = Array.isArray(result?.changedFiles)
      ? result.changedFiles.filter((item: unknown) => typeof item === 'string').slice(0, 100)
      : [];
    return {
      kind: 'code',
      source: 'mutation-service',
      executed: response.ok && result?.ok !== false && Boolean(diff),
      payload: {
        outcome: response.ok && result?.ok !== false && Boolean(diff) ? 'pass' : 'fail',
        status: response.status,
        branch,
        diff,
        changedFiles,
        appUrl: typeof result?.appUrl === 'string' ? result.appUrl : undefined,
        diagnosis,
        desiredBehavior,
      },
    };
  }

  throw new Error(`unsupported VERIFAI audit tool: ${toolName}`);
}
