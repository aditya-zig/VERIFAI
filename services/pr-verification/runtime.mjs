import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPrVerificationHttpHandler } from './http.mjs';
import { FilePrChecksPublicationStore } from './publication-store.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Local composition only. Live execution and GitHub publication are never enabled implicitly. */
export function createPrVerificationRuntime({
  env = process.env,
  directory = env.VERIFIAI_PR_STATE_DIR ?? resolve(projectRoot, 'data/pr-verification'),
  transport,
  executor,
  resources,
  authenticate,
  profile: injectedProfile,
  model,
  onRunnerError = () => console.warn('PR verification runner stopped; inspect owned job recovery before starting more work'),
} = {}) {
  let initialized;
  const running = new Map();

  const initialize = async () => {
    const [{ PrJobStore }, { PrVerificationController }, { recoverInterruptedJobs }, { resolveCandidate }, { FetchGitHubTransport }] = await Promise.all([
      import('../../dist/services/pr-verification/store.js'),
      import('../../dist/services/pr-verification/controller.js'),
      import('../../dist/services/pr-verification/recovery.js'),
      import('../../dist/services/pr-verification/candidate.js'),
      import('../../dist/packages/core/github/index.js'),
    ]);
    const store = new PrJobStore({ directory });
    await store.init();
    // A second local process must not recover jobs owned by a live runner.
    const recoveryLock = await store.acquireLock('controller', { stealStale: true });
    try { await recoverInterruptedJobs({ store, resources, queuedJobs: 'close' }); }
    finally { await store.releaseLock(recoveryLock); }
    const github = transport ?? new FetchGitHubTransport({ timeoutMs: 15_000 });
    const token = env.VERIFIAI_GITHUB_TOKEN || env.GITHUB_TOKEN;
    let planner;
    let evaluator;
    if (injectedProfile || env.VERIFIAI_PR_PROFILE_PATH) {
      const [{ defineApprovedProfile, loadApprovedProfile }, { TestArtifactStore, EvidenceWriter }, { planChecks }, { evaluateCandidate }] = await Promise.all([
        import('../../dist/services/pr-verification/profile.js'),
        import('../../dist/services/pr-verification/evidence.js'),
        import('../../dist/services/pr-verification/planner.js'),
        import('../../dist/services/pr-verification/verdict.js'),
      ]);
      const profile = injectedProfile ? defineApprovedProfile(injectedProfile) : await loadApprovedProfile(env.VERIFIAI_PR_PROFILE_PATH);
      const artifactStore = new TestArtifactStore(resolve(directory, 'artifacts'));
      const evidenceStore = new EvidenceWriter(resolve(directory, 'evidence'));
      planner = { async plan({ candidate }) { return (await planChecks({ profile, candidate, artifactStore, ...(model ? { model } : {}) })).plan; } };
      evaluator = { async evaluate(input) {
        const { result } = await evaluateCandidate({
          profile, artifactStore, evidenceStore, candidate: input.candidate, plan: input.plan,
          observations: input.observations, cleanupComplete: input.cleanupComplete,
          superseded: input.superseded === true,
        });
        return { verdict: result.verdict, limitations: result.limitations };
      } };
    }
    const controller = new PrVerificationController({
      store, resources, executor, planner, evaluator,
      resolver: { resolve({ request, signal }) { return resolveCandidate(request, github, { token, signal }); } },
    });
    return { controller, store };
  };
  const getRuntime = () => initialized ??= initialize();

  function runJob(controller, id, principal) {
    if (running.has(id)) return;
    const work = controller.run(id).catch(() => onRunnerError()).finally(() => running.delete(id));
    running.set(id, { work, controller, principal });
  }

  const controller = {
    async start(input, principal, key) {
      const { controller: actual } = await getRuntime();
      const job = await actual.start(input, principal, key);
      if (job.phase !== 'Finished') runJob(actual, job.id, principal);
      return job;
    },
    async get(id, principal) { return (await getRuntime()).controller.get(id, principal); },
    async cancel(id, principal) { return (await getRuntime()).controller.cancel(id, principal); },
  };
  const appToken = env.VERIFIAI_GITHUB_APP_TOKEN?.trim();
  const strictRulesAcknowledged = env.VERIFIAI_PR_STRICT_BRANCH_PROTECTION_ACK === '1';
  const publicationConfigured = Boolean(appToken && strictRulesAcknowledged);
  const publish = publicationConfigured ? async (job, principal) => {
    const { controller: actual } = await getRuntime();
    const { publishPrResult } = await import('../../dist/services/pr-verification/github-checks.js');
    const { FetchGitHubTransport } = await import('../../dist/packages/core/github/index.js');
    const lockName = `publish-${createHash('sha256').update(job.id).digest('hex').slice(0, 24)}`;
    const lock = await actual.store.acquireLock(lockName);
    try {
      return await publishPrResult({
        job: { repository: job.request.repository, pullRequest: job.request.pullRequest, expectedHeadSha: job.request.expectedHeadSha, result: job.result },
        principal: principal.id, transport: transport ?? new FetchGitHubTransport({ timeoutMs: 15_000 }),
        store: new FilePrChecksPublicationStore(resolve(directory, 'publications')),
        token: appToken, resultSource: 'server-verifier', assumeStrictBranchProtection: strictRulesAcknowledged,
      });
    } finally { await actual.store.releaseLock(lock); }
  } : undefined;
  const handle = createPrVerificationHttpHandler({
    controller,
    authenticate: authenticate ?? (async req => {
      const { resolveRequestPrincipal } = await import('../request-principal.mjs');
      return resolveRequestPrincipal(req, env);
    }),
    executionConfigured: Boolean(executor),
    publicationConfigured,
    publish,
  });
  return {
    handle,
    async shutdown() {
      const pending = [...running.entries()];
      await Promise.allSettled(pending.map(([id, item]) => item.controller.cancel(id, item.principal)));
      await Promise.allSettled(pending.map(([, item]) => item.work));
    },
    /** For trusted embedding/tests only, never exposed as an HTTP evidence-ingest route. */
    async waitForIdle() {
      await Promise.allSettled([...running.values()].map(item => item.work));
      if (initialized) return (await initialized).store.listUnfinished();
      return [];
    },
  };
}
