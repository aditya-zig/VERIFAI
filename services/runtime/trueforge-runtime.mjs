import {RuntimeIncompleteError} from './contract.mjs';
import {TrueForgeClient} from './trueforge-client.mjs';
import {createScopedToolGate, issueRuntimeScope} from './trueforge-scope.mjs';

function parseJsonObject(text) {
  const source = String(text || '').trim();
  try { return JSON.parse(source); } catch {}
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
  throw new Error('TrueForge analysis did not return JSON');
}

function ensureRepo(input) {
  const repository = input?.repository;
  if (!repository?.fullName || !repository?.commit || !/^[0-9a-f]{7,64}$/i.test(repository.commit)) {
    throw new RuntimeIncompleteError('clone', 'TrueForge runtime requires exact repository fullName and commit', 'RepositoryIdentityMissing');
  }
  return repository;
}

function safeFinding(value) {
  const finding = value?.finding;
  if (!finding || typeof finding !== 'object') throw new Error('analysis finding missing');
  return {
    title: String(finding.title || 'Repository review'),
    severity: String(finding.severity || 'info'),
    description: String(finding.description || ''),
    evidence: finding.evidence && typeof finding.evidence === 'object' ? finding.evidence : {},
  };
}

export class TrueForgeRuntimeProvider {
  name = 'trueforge';

  constructor({
    client,
    baseUrl,
    token,
    model,
    scopeSecret,
    tools = {},
    timeoutMs = 120000,
    maxToolCalls = 8,
  } = {}) {
    this.client = client || new TrueForgeClient({baseUrl, token, timeoutMs});
    this.modelName = model;
    this.scopeSecret = scopeSecret;
    this.tools = tools;
    this.timeoutMs = timeoutMs;
    this.maxToolCalls = maxToolCalls;
    this.gates = new Map();
  }

  createGate(input, run) {
    if (!this.scopeSecret || this.scopeSecret.length < 32) {
      throw new RuntimeIncompleteError('clone', 'TrueForge scoped tool secret is not configured', 'ScopeSecretMissing');
    }
    const repository = ensureRepo(input);
    const capabilities = [
      'repository:read',
      'execution:bounded',
      ...(input.requireBrowser ? ['browser:run'] : []),
      ...(input.repair ? ['repair:write'] : []),
      ...(input.requireArtifact ? ['artifact:write'] : []),
    ];
    const scopeToken = issueRuntimeScope({
      secret: this.scopeSecret,
      runId: run.id,
      repository,
      capabilities,
      maxToolCalls: this.maxToolCalls,
      repairAuthorized: Boolean(input.repair),
      ttlMs: Math.min(input.timeoutMs || this.timeoutMs, 20 * 60 * 1000),
    });
    const gate = createScopedToolGate({secret: this.scopeSecret, token: scopeToken});
    this.gates.set(run.id, gate);
    return gate;
  }

  gate(input, run) {
    return this.gates.get(run.id) || this.createGate(input, run);
  }

  async repository(input, {run, signal} = {}) {
    const repository = ensureRepo(input);
    const gate = this.gate(input, run);
    const authorization = gate.authorize('repo_tree', {runId: run.id, repository});
    if (typeof this.tools.repoTree !== 'function') {
      throw new RuntimeIncompleteError('clone', 'TrueForge repo_tree tool unavailable', 'ToolUnavailable');
    }
    const tree = await this.tools.repoTree({authorization, repository, signal});
    return {
      id: run.id,
      repository: structuredClone(repository),
      clone: tree?.clone || {success: true, remote: true},
      files: tree?.files || {count: 0, items: [], truncated: false, languages: []},
      info: tree?.info,
    };
  }

  async model(record, input, {run, signal} = {}) {
    if (!this.modelName) throw new RuntimeIncompleteError('analysis', 'VERIFIAI_TRUEFORGE_MODEL is required', 'ProviderUnavailable');
    await this.client.health(signal);
    const sessionId = await this.client.createSession({
      model: {name: this.modelName},
      instructions: [
        'You are the VERIFAI repository analysis runtime.',
        'Product stages, gates, evidence truth, repair policy, approval and terminal status are owned by VERIFAI.',
        'Do not claim tool execution or invent evidence.',
        'Return JSON only with model and finding.',
        'finding keys: title, severity, description, evidence.',
      ].join(' '),
      config: {
        iteration_limit: 4,
        ask_user_questions: {enabled: false},
        dynamic_sub_agents: {enabled: false},
        generative_ui: {enabled: false},
      },
    }, signal);

    const prompt = JSON.stringify({
      runId: run.id,
      repository: record.repository,
      files: {
        count: record.files?.count,
        items: Array.isArray(record.files?.items) ? record.files.items.slice(0, 100) : [],
        languages: record.files?.languages || [],
      },
      objective: input.objective || 'Review the repository and identify one concrete issue or observation.',
    });
    const result = await this.client.runTurn(sessionId, prompt, {signal, timeoutMs: input.timeoutMs || this.timeoutMs});
    if (result.status !== 'done') {
      throw new RuntimeIncompleteError('analysis', result.error || 'TrueForge model turn incomplete', 'ProviderUnavailable');
    }
    const parsed = parseJsonObject(result.answer);
    return {
      model: {
        provider: 'trueforge',
        model: this.modelName,
        sessionId,
        turnId: result.turnId,
        calls: 1,
      },
      finding: safeFinding(parsed),
    };
  }

  async execute(record, input, {run, signal} = {}) {
    const gate = this.gate(input, run);
    const authorization = gate.authorize('bounded_execution', {runId: run.id, repository: record.repository});
    if (typeof this.tools.boundedExecution !== 'function') {
      throw new RuntimeIncompleteError('execution', 'TrueForge bounded_execution tool unavailable', 'ToolUnavailable');
    }
    return this.tools.boundedExecution({
      authorization,
      repository: record.repository,
      command: input.command,
      timeoutMs: input.timeoutMs,
      signal,
    });
  }

  async browser(record, input, {run, signal} = {}) {
    const gate = this.gate(input, run);
    const authorization = gate.authorize('browser_journey', {runId: run.id, repository: record.repository});
    if (typeof this.tools.browserJourney !== 'function') return {status: 'Incomplete', error: 'browser_journey tool unavailable'};
    return this.tools.browserJourney({authorization, repository: record.repository, signal});
  }

  async specialist(record, input, {run, signal} = {}) {
    if (typeof this.tools.specialist !== 'function') return {status: 'Incomplete', error: 'specialist runtime unavailable'};
    return this.tools.specialist({runId: run.id, repository: record.repository, signal});
  }

  async repair(record, input, {run, signal} = {}) {
    const gate = this.gate(input, run);
    const authorization = gate.authorize('repair_candidate', {runId: run.id, repository: record.repository});
    if (typeof this.tools.repairCandidate !== 'function') return {verdict: 'RejectedRepair', reason: 'repair_candidate tool unavailable'};
    return this.tools.repairCandidate({authorization, repository: record.repository, repair: input.repair, signal});
  }

  async artifact(record, input, {run, signal} = {}) {
    const gate = this.gate(input, run);
    const authorization = gate.authorize('artifact_handoff', {runId: run.id, repository: record.repository});
    if (typeof this.tools.artifactHandoff !== 'function') return null;
    return this.tools.artifactHandoff({authorization, repository: record.repository, signal});
  }

  async pullRequest(record, input, {run, signal} = {}) {
    if (typeof this.tools.pullRequest !== 'function') throw new Error('PR approval transport unavailable');
    return this.tools.pullRequest({runId: run.id, repository: record.repository, approval: input.approval, signal});
  }

  async cleanup(record, input, {run, signal} = {}) {
    try {
      if (typeof this.tools.cleanup !== 'function') return {status: 'Completed', remote: true};
      const result = await this.tools.cleanup({runId: run.id, repository: record?.repository || input.repository, signal});
      return result || {status: 'Completed'};
    } finally {
      this.gates.delete(run.id);
    }
  }
}
