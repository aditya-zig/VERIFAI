import test from 'node:test';
import assert from 'node:assert/strict';
import type { GitHubTransport } from '../packages/core/github/index.js';
import type {
  CandidateRevision,
  CheckPlan,
  CheckObservation,
  PrVerificationRequest,
  PrVerificationResult,
  TestDefinition,
} from '../packages/contracts/src/index.js';
import {
  MemoryPrChecksPublicationStore,
  PR_CHECKS_LIMITS,
  PrChecksPublicationError,
  prChecksConclusion,
  prChecksPublicationKey,
  publishPrResult,
  type PrChecksPublicationErrorCode,
  type PrChecksPublicationRecord,
  type PrChecksPublicationStore,
} from '../services/pr-verification/github-checks.js';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const NEXT_SHA = '3'.repeat(40);
const REPOSITORY = 'acme/shop';
const PULL_REQUEST = 7;
const TOKEN = 'test-token';
const PRINCIPAL = 'verifai-service';
const MANIFEST = 'a'.repeat(64);

interface RepoIdentity { full_name: string; private: boolean; id: number }
interface PullMetadata {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  base: { ref: string; sha: string; repo: RepoIdentity | null };
  head: { ref: string; sha: string; repo: RepoIdentity | null };
}
interface ExistingCheckRun { id: number; external_id: string; head_sha: string; name: string }
interface ExistingComment { id: number; body: string }

function repo(fullName: string, isPrivate = false): RepoIdentity {
  return { full_name: fullName, private: isPrivate, id: 99 };
}

function metadata(overrides: {
  state?: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  baseSha?: string;
  headSha?: string;
  baseRepository?: string;
  headRepository?: string;
  basePrivate?: boolean;
  headPrivate?: boolean;
} = {}): PullMetadata {
  return {
    number: PULL_REQUEST,
    state: overrides.state ?? 'open',
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false,
    base: {
      ref: 'main',
      sha: overrides.baseSha ?? BASE_SHA,
      repo: repo(overrides.baseRepository ?? REPOSITORY, overrides.basePrivate ?? false),
    },
    head: {
      ref: 'agent/fix',
      sha: overrides.headSha ?? HEAD_SHA,
      repo: repo(overrides.headRepository ?? REPOSITORY, overrides.headPrivate ?? false),
    },
  };
}

function requiredCheck(checkId: string, contentSha = 'c'.repeat(64)): TestDefinition {
  return { checkId, artifactRef: `artifacts/${checkId}`, contentSha256: contentSha, origin: 'approved' };
}

function plan(overrides: { requiredChecks?: TestDefinition[]; generatedTests?: TestDefinition[] } = {}): CheckPlan {
  return {
    policyVersion: 'policy-test-1',
    profileId: 'node-standard',
    profileDigest: 'd'.repeat(64),
    requiredChecks: overrides.requiredChecks ?? [requiredCheck('unit-suite')],
    generatedTests: overrides.generatedTests ?? [],
    planDigest: 'e'.repeat(64),
  };
}

function observation(overrides: {
  checkId?: string;
  revision?: 'base' | 'head';
  commitSha?: string;
  status?: PrVerificationResult['verdict'];
  executed?: boolean;
  exitCode?: number | null;
  testContentSha256?: string;
} = {}): CheckObservation {
  return {
    checkId: overrides.checkId ?? 'unit-suite',
    revision: overrides.revision ?? 'head',
    commitSha: overrides.commitSha ?? HEAD_SHA,
    status: overrides.status ?? 'Verified',
    executed: overrides.executed ?? true,
    exitCode: overrides.exitCode ?? 0,
    artifactRefs: ['artifacts/unit-suite/junit.xml'],
    commandDigest: 'f'.repeat(64),
    testContentSha256: overrides.testContentSha256 ?? requiredCheck('unit-suite').contentSha256,
  };
}

function candidate(overrides: Partial<CandidateRevision> = {}): CandidateRevision {
  return {
    repository: REPOSITORY,
    pullRequest: PULL_REQUEST,
    headRepository: REPOSITORY,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    mergeBaseSha: '4'.repeat(40),
    changedFiles: ['src/app.ts'],
    diffDigest: '9'.repeat(64),
    ...overrides,
  };
}

function result(overrides: {
  candidate?: CandidateRevision;
  plan?: CheckPlan;
  observations?: CheckObservation[];
  verdict?: PrVerificationResult['verdict'];
  limitations?: string[];
  cleanupComplete?: boolean;
  superseded?: boolean;
} = {}): PrVerificationResult {
  return {
    candidate: overrides.candidate ?? candidate(),
    plan: overrides.plan ?? plan(),
    observations: overrides.observations ?? [observation()],
    verdict: overrides.verdict ?? 'Verified',
    limitations: overrides.limitations ?? [],
    evidenceManifestSha256: MANIFEST,
    cleanupComplete: overrides.cleanupComplete ?? true,
    superseded: overrides.superseded ?? false,
  };
}

function request(overrides: Partial<PrVerificationRequest> = {}): PrVerificationRequest {
  return { repository: REPOSITORY, pullRequest: PULL_REQUEST, expectedHeadSha: HEAD_SHA, ...overrides };
}

function config(overrides: { token?: string; principal?: string } = {}) {
  return {
    token: overrides.token ?? TOKEN,
    principal: overrides.principal ?? PRINCIPAL,
    resultSource: 'server-verifier' as const,
    assumeStrictBranchProtection: true,
  };
}

interface RecordedWrite {
  method: string;
  path: string;
  body?: unknown;
}

class PublishingFake implements GitHubTransport {
  readonly calls: Array<{ method: string; path: string; token?: string }> = [];
  readonly writes: RecordedWrite[] = [];
  readonly metadataQueue: PullMetadata[];
  readonly existingCheckRuns: ExistingCheckRun[];
  readonly existingComments: ExistingComment[];
  readonly failPullReadAt: number;
  readonly failCheckRunPatch: boolean;
  readonly createdCheckRuns: ExistingCheckRun[] = [];
  readonly createdComments: ExistingComment[] = [];
  checkRunCounter = 5000;
  commentCounter = 9000;
  pullGetCount = 0;

  constructor(options: {
    metadata?: PullMetadata[];
    existingCheckRuns?: ExistingCheckRun[];
    existingComments?: ExistingComment[];
    /** 1-based occurrence of a pulls GET that throws, without consuming queue metadata. */
    failPullReadAt?: number;
    failCheckRunPatch?: boolean;
  } = {}) {
    this.metadataQueue = options.metadata ?? [metadata(), metadata(), metadata()];
    this.existingCheckRuns = options.existingCheckRuns ?? [];
    this.existingComments = options.existingComments ?? [];
    this.failPullReadAt = options.failPullReadAt ?? 0;
    this.failCheckRunPatch = options.failCheckRunPatch ?? false;
  }

  async request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    this.calls.push({ method, path, ...(token ? { token } : {}) });
    if (method !== 'GET') this.writes.push({ method, path, body });
    const pullPath = `/repos/${REPOSITORY}/pulls/${PULL_REQUEST}`;
    if (method === 'GET' && path === pullPath) {
      this.pullGetCount += 1;
      if (this.failPullReadAt === this.pullGetCount) throw new Error('metadata re-read failed');
      const next = this.metadataQueue.shift();
      if (!next) throw new Error('no PR metadata queued');
      return structuredClone(next) as T;
    }
    const checkList = path.match(
      new RegExp(`^/repos/${REPOSITORY}/commits/${HEAD_SHA}/check-runs\\?per_page=100&page=(\\d+)$`),
    );
    if (method === 'GET' && checkList) {
      const page = Number(checkList[1]);
      if (page < 1 || page > 10) throw new Error(`unexpected check-run page ${page}`);
      const start = (page - 1) * 100;
      const slice = this.existingCheckRuns.slice(start, start + 100);
      return structuredClone({ total_count: this.existingCheckRuns.length, check_runs: slice }) as T;
    }
    const commentList = path.match(
      new RegExp(`^/repos/${REPOSITORY}/issues/${PULL_REQUEST}/comments\\?per_page=100&page=(\\d+)$`),
    );
    if (method === 'GET' && commentList) {
      const page = Number(commentList[1]);
      if (page < 1 || page > 10) throw new Error(`unexpected comment page ${page}`);
      const start = (page - 1) * 100;
      return structuredClone(this.existingComments.slice(start, start + 100)) as T;
    }
    if (method === 'POST' && path === `/repos/${REPOSITORY}/check-runs`) {
      const created = { id: ++this.checkRunCounter, external_id: readExternalId(body), head_sha: HEAD_SHA, name: readName(body) };
      this.createdCheckRuns.push(created);
      return structuredClone(created) as T;
    }
    const patchCheck = path.match(new RegExp(`^/repos/${REPOSITORY}/check-runs/(\\d+)$`));
    if (method === 'PATCH' && patchCheck) {
      if (this.failCheckRunPatch) throw new Error('check patch failed');
      const found = [...this.existingCheckRuns, ...this.createdCheckRuns].find((item) => item.id === Number(patchCheck[1]));
      if (!found) throw new Error(`unknown check run ${patchCheck[1]}`);
      if (readExternalIdSafe(body)) found.external_id = readExternalIdSafe(body) as string;
      return structuredClone(found) as T;
    }
    if (method === 'POST' && path === `/repos/${REPOSITORY}/issues/${PULL_REQUEST}/comments`) {
      const created = { id: ++this.commentCounter, body: readBody(body) };
      this.createdComments.push(created);
      return structuredClone(created) as T;
    }
    const patchComment = path.match(new RegExp(`^/repos/${REPOSITORY}/issues/comments/(\\d+)$`));
    if (method === 'PATCH' && patchComment) {
      const found = [...this.existingComments, ...this.createdComments].find((item) => item.id === Number(patchComment[1]));
      if (!found) throw new Error(`unknown comment ${patchComment[1]}`);
      found.body = readBody(body);
      return structuredClone(found) as T;
    }
    throw new Error(`unexpected GitHub request: ${method} ${path}`);
  }
}

function readExternalId(body: unknown): string {
  const externalId = (body as { external_id?: string }).external_id;
  if (typeof externalId !== 'string') throw new Error('check run body lacks external_id');
  return externalId;
}

function readName(body: unknown): string {
  const name = (body as { name?: string }).name;
  if (typeof name !== 'string') throw new Error('check run body lacks name');
  return name;
}

function readBody(body: unknown): string {
  const text = (body as { body?: string }).body;
  if (typeof text !== 'string') throw new Error('comment body lacks text');
  return text;
}

function readExternalIdSafe(body: unknown): string | undefined {
  const externalId = (body as { external_id?: string }).external_id;
  return typeof externalId === 'string' ? externalId : undefined;
}

function jobFor(value: PrVerificationResult, req: PrVerificationRequest) {
  return {
    repository: req.repository,
    pullRequest: req.pullRequest,
    expectedHeadSha: req.expectedHeadSha,
    result: value,
  };
}

function publishInput(
  value: PrVerificationResult,
  req: PrVerificationRequest,
  transport: GitHubTransport,
  overrides: { token?: string; principal?: string; resultSource?: unknown; assumeStrictBranchProtection?: boolean },
  store: PrChecksPublicationStore,
) {
  return {
    job: jobFor(value, req),
    transport,
    store,
    token: overrides.token ?? TOKEN,
    principal: overrides.principal ?? PRINCIPAL,
    resultSource: overrides.resultSource ?? 'server-verifier',
    assumeStrictBranchProtection: overrides.assumeStrictBranchProtection ?? true,
  };
}

function rejectedCode(error: unknown): PrChecksPublicationErrorCode | undefined {
  return error instanceof PrChecksPublicationError ? error.code : undefined;
}

const externalId = `verifai-runtime:${REPOSITORY}#${PULL_REQUEST}@${HEAD_SHA}`;
const COMMENT_MARKER = `<!-- verifai-runtime-comment ${REPOSITORY} #${PULL_REQUEST} @${HEAD_SHA} -->`;

test('maps verdicts to check conclusions', () => {
  assert.equal(prChecksConclusion('Verified'), 'success');
  assert.equal(prChecksConclusion('Failed'), 'failure');
  assert.equal(prChecksConclusion('Incomplete'), 'action_required');
  assert.equal(prChecksConclusion('Unknown'), 'action_required');
});

test('publishes the head check and one evidence comment for a fully justified Verified result', async () => {
  const fake = new PublishingFake();
  const store = new MemoryPrChecksPublicationStore();

  const outcome = await publishPrResult(publishInput(result(), request(), fake, config(), store));

  assert.equal(outcome.outcome, 'published');
  assert.equal(outcome.verdict, 'Verified');
  assert.equal(outcome.conclusion, 'success');
  assert.equal(outcome.checkRunId, fake.createdCheckRuns[0]?.id ?? 0);
  assert.equal(outcome.commentId, fake.createdComments[0]?.id ?? 0);

  const checkPost = fake.writes.find((item) => item.path === `/repos/${REPOSITORY}/check-runs`);
  assert.ok(checkPost, 'check run must be created');
  const checkBody = checkPost!.body as {
    name: string;
    head_sha: string;
    status: string;
    conclusion: string;
    external_id: string;
    output: { title: string; summary: string };
  };
  assert.equal(checkBody.head_sha, HEAD_SHA);
  assert.equal(checkBody.status, 'completed');
  assert.equal(checkBody.conclusion, 'success');
  assert.equal(checkBody.external_id, externalId);
  assert.match(checkBody.output.summary, new RegExp(MANIFEST));

  const commentPost = fake.writes.filter((item) => item.path === `/repos/${REPOSITORY}/issues/${PULL_REQUEST}/comments`);
  assert.equal(commentPost.length, 1, 'at most one comment must be created');
  const commentBody = (commentPost[0].body as { body: string }).body;
  assert.ok(commentBody.startsWith(COMMENT_MARKER));
  assert.match(commentBody, new RegExp(MANIFEST));

  assert.ok(fake.calls.every((call) => call.token === TOKEN));
  const record = await store.get(prChecksPublicationKey(REPOSITORY, PULL_REQUEST, HEAD_SHA));
  assert.ok(record, 'store must persist the publication mapping');
  const stored: PrChecksPublicationRecord = record as PrChecksPublicationRecord;
  assert.equal(stored.repository, REPOSITORY);
  assert.equal(stored.pullRequest, PULL_REQUEST);
  assert.equal(stored.headSha, HEAD_SHA);
  assert.equal(stored.checkRunId, outcome.checkRunId);
  assert.equal(stored.commentId, outcome.commentId);
  assert.equal(stored.externalId, externalId);
});

test('binds the publication to the exact expected head SHA before and after writes', async () => {
  const staleHead = new PublishingFake({ metadata: [metadata({ headSha: NEXT_SHA }), metadata(), metadata(), metadata()] });
  const first = await publishPrResult(publishInput(result(), request(), staleHead, config(), new MemoryPrChecksPublicationStore()));
  assert.equal(first.outcome, 'superseded');
  assert.equal(staleHead.writes.length, 0, 'a moved head must not be published');

  const staleBase = new PublishingFake({ metadata: [metadata({ baseSha: NEXT_SHA }), metadata(), metadata(), metadata()] });
  const second = await publishPrResult(publishInput(result(), request(), staleBase, config(), new MemoryPrChecksPublicationStore()));
  assert.equal(second.outcome, 'superseded');
  assert.equal(staleBase.writes.length, 0, 'a moved base must not be published');
});

test('downgrades a just-written success check when the head moves after creation', async () => {
  const changedAfter = new PublishingFake();
  changedAfter.metadataQueue[1] = metadata({ headSha: NEXT_SHA, baseSha: NEXT_SHA });

  const outcome = await publishPrResult(publishInput(result(), request(), changedAfter, config(), new MemoryPrChecksPublicationStore()));

  assert.equal(outcome.outcome, 'superseded');
  const patch = changedAfter.writes.find((item) => item.method === 'PATCH' && item.path.startsWith(`/repos/${REPOSITORY}/check-runs/`));
  assert.ok(patch, 'the success check must be rewritten');
  const downgrade = patch!;
  assert.equal((downgrade.body as { conclusion: string }).conclusion, 'action_required', 'neutral reads as a passing required check, so downgrades must read as action required');
  const downgradeSummary = (downgrade.body as { output: { summary: string } }).output.summary;
  assert.equal(downgradeSummary.length > 0, true);
  assert.match(downgradeSummary, /superseded/i);
});

test('failed publications do not downgrade live failure conclusions when the head moves after the write', async () => {
  const fake = new PublishingFake();
  fake.metadataQueue[1] = metadata({ headSha: NEXT_SHA });

  const outcome = await publishPrResult(
    publishInput(
      result({ verdict: 'Failed', observations: [observation({ status: 'Failed', exitCode: 1 })], limitations: ['unit-suite failed after repair'] }),
      request(),
      fake,
      config(),
      new MemoryPrChecksPublicationStore(),
    ),
  );

  assert.equal(outcome.conclusion, 'failure');
  assert.equal(outcome.outcome, 'superseded', 'head moved after publication');
  const checkPatches = fake.writes.filter((item) => item.method === 'PATCH' && item.path.includes('/check-runs/'));
  assert.equal(checkPatches.length, 0, 'failure conclusions are not live success claims');
});

test('retries update the recorded check run and comment without duplicating them', async () => {
  const fake = new PublishingFake({ metadata: [metadata(), metadata(), metadata(), metadata()] });
  const store = new MemoryPrChecksPublicationStore();

  const first = await publishPrResult(publishInput(result(), request(), fake, config(), store));
  const second = await publishPrResult(publishInput(result(), request(), fake, config(), store));

  assert.equal(first.checkRunId, second.checkRunId);
  assert.equal(first.commentId, second.commentId);
  assert.equal(fake.writes.filter((item) => item.path === `/repos/${REPOSITORY}/check-runs`).length, 1);
  assert.equal(
    fake.writes.filter((item) => item.path === `/repos/${REPOSITORY}/issues/${PULL_REQUEST}/comments`).length,
    1,
  );
  const checkPatches = fake.writes.filter((item) => item.method === 'PATCH' && item.path.includes('/check-runs/'));
  assert.equal(checkPatches.length, 1, 'the retry updates the same check run');
  const commentPatches = fake.writes.filter((item) => item.method === 'PATCH' && item.path.includes('/issues/comments/'));
  assert.equal(commentPatches.length, 1, 'the retry updates the same comment');
});

test('a restarted process reconciles an unrecorded check run and comment by external id and marker', async () => {
  const existingCheck: ExistingCheckRun = { id: 777, external_id: externalId, head_sha: HEAD_SHA, name: 'VERIFAI runtime verification' };
  const existingComment: ExistingComment = { id: 888, body: `${COMMENT_MARKER}\nolder evidence` };
  const fake = new PublishingFake({ existingCheckRuns: [existingCheck], existingComments: [existingComment] });

  const outcome = await publishPrResult(publishInput(result(), request(), fake, config(), new MemoryPrChecksPublicationStore()));

  assert.equal(outcome.checkRunId, 777);
  assert.equal(outcome.commentId, 888);
  assert.equal(fake.writes.filter((item) => item.method === 'POST').length, 0, 'reconciliation must not create duplicates');
});

test('reconciled ids persist so later retries still update in place', async () => {
  const existingCheck: ExistingCheckRun = { id: 777, external_id: externalId, head_sha: HEAD_SHA, name: 'VERIFAI runtime verification' };
  const existingComment: ExistingComment = { id: 888, body: `${COMMENT_MARKER}\nolder evidence` };
  const fake = new PublishingFake({ existingCheckRuns: [existingCheck], existingComments: [existingComment] });
  const store = new MemoryPrChecksPublicationStore();

  await publishPrResult(publishInput(result(), request(), fake, config(), store));
  const record = await store.get(prChecksPublicationKey(REPOSITORY, PULL_REQUEST, HEAD_SHA));
  assert.ok(record);
  assert.equal((record as PrChecksPublicationRecord).checkRunId, 777);
  assert.equal((record as PrChecksPublicationRecord).commentId, 888);
});


function clutterCheckRuns(count: number, startIndex = 1000): ExistingCheckRun[] {
  return Array.from({ length: count }, (_, index) => ({
    id: startIndex + index,
    external_id: `other-job:${index}`,
    head_sha: HEAD_SHA,
    name: 'other check',
  }));
}

function clutterComments(count: number): ExistingComment[] {
  return Array.from({ length: count }, (_, index) => ({ id: 10_000 + index, body: `<!-- other-comment ${index} -->\nunrelated text` }));
}

test('reconciles a matching check run and comment found on page 2 of their lists', async () => {
  const stored: ExistingCheckRun = { id: 777, external_id: externalId, head_sha: HEAD_SHA, name: 'VERIFAI runtime verification' };
  const marked: ExistingComment = { id: 888, body: `${COMMENT_MARKER}\nolder evidence` };
  const fake = new PublishingFake({
    existingCheckRuns: [...clutterCheckRuns(100), stored, ...clutterCheckRuns(150)],
    existingComments: [...clutterComments(100), marked, ...clutterComments(30)],
  });

  const outcome = await publishPrResult(publishInput(result(), request(), fake, config(), new MemoryPrChecksPublicationStore()));

  assert.equal(outcome.checkRunId, 777);
  assert.equal(outcome.commentId, 888);
  assert.equal(fake.writes.filter((item) => item.method === 'POST').length, 0, 'page 2+ matches must update, not duplicate');
  assert.ok(fake.calls.some((call) => call.path.includes('check-runs?per_page=100&page=2')), 'the scan must reach page 2');
  const commentScanPages = fake.calls
    .filter((call) => call.path.includes(`/issues/${PULL_REQUEST}/comments?per_page=100`))
    .map((call) => Number(call.path.match(/page=(\d+)$/)?.[1]));
  assert.ok(commentScanPages.includes(2), 'the comment scan must reach page 2');
  const patchReads = fake.writes.filter((item) => item.method === 'PATCH');
  assert.equal(patchReads.length, 2, 'both reconciled entries are updated in place');
});

test('an exhausted reconciliation bound rejects instead of creating a duplicate check run', async () => {
  const fake = new PublishingFake({ existingCheckRuns: clutterCheckRuns(5 * 100) });

  await assert.rejects(
    () => publishPrResult(publishInput(result(), request(), fake, config(), new MemoryPrChecksPublicationStore())),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'RECONCILIATION_INCONCLUSIVE');
      return true;
    },
  );
  assert.equal(fake.writes.filter((item) => item.method === 'POST').length, 0, 'an inconclusive scan must not create duplicates');
});

test('an exhausted comment bound rejects instead of creating a duplicate comment', async () => {
  const fake = new PublishingFake({ existingComments: clutterComments(5 * 100) });

  await assert.rejects(
    () => publishPrResult(publishInput(result(), request(), fake, config(), new MemoryPrChecksPublicationStore())),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'RECONCILIATION_INCONCLUSIVE');
      return true;
    },
  );
  assert.equal(fake.writes.filter((item) => item.method === 'POST').length, 0, 'an inconclusive scan must not create duplicates');
});

test('a failed post-write currency re-read downgrades a just-successful check to action_required and reports the repair', async () => {
  const fake = new PublishingFake({ failPullReadAt: 2 });

  const outcome = await publishPrResult(publishInput(result(), request(), fake, config(), new MemoryPrChecksPublicationStore()));

  assert.equal(outcome.outcome, 'unconfirmed', 'current success must never be returned when currency cannot be confirmed');
  assert.equal(outcome.reason, 'POST_WRITE_VERIFY_FAILED');
  assert.deepEqual(outcome.repair, { attempted: true, succeeded: true });
  const patch = fake.writes.find((item) => item.method === 'PATCH' && item.path.includes('/check-runs/'));
  assert.ok(patch, 'the just-published success must be downgraded');
  assert.equal((patch!.body as { conclusion: string }).conclusion, 'action_required');
  assert.match((patch!.body as { output: { summary: string } }).output.summary, /unconfirmed/i);
});

test('a failed downgrade is reported as unconfirmed, never as a current success', async () => {
  const fake = new PublishingFake({ failPullReadAt: 2, failCheckRunPatch: true });

  const outcome = await publishPrResult(publishInput(result(), request(), fake, config(), new MemoryPrChecksPublicationStore()));

  assert.equal(outcome.outcome, 'unconfirmed');
  assert.deepEqual(outcome.repair, { attempted: true, succeeded: false });
});

test('failure conclusions under a failed re-read are published without downgrade claims', async () => {
  const fake = new PublishingFake({ failPullReadAt: 2 });

  const outcome = await publishPrResult(
    publishInput(
      result({ verdict: 'Failed', observations: [observation({ status: 'Failed', exitCode: 1 })], limitations: ['unit-suite failed'] }),
      request(),
      fake,
      config(),
      new MemoryPrChecksPublicationStore(),
    ),
  );

  assert.equal(outcome.outcome, 'published');
  assert.equal(outcome.reason, 'POST_WRITE_VERIFY_FAILED');
  assert.equal(outcome.repair, undefined, 'failure conclusions are not success claims and need no downgrade');
});

test('rejects results bound to a different candidate, repository or head without any GitHub write', async () => {
  const cases: Array<{ name: string; value: PrVerificationResult; request?: PrVerificationRequest; code: PrChecksPublicationErrorCode }> = [
    { name: 'different repository', value: result({ candidate: candidate({ repository: 'acme/other' }) }), code: 'RESULT_REPOSITORY_MISMATCH' },
    { name: 'different head repository', value: result({ candidate: candidate({ headRepository: 'someone/shop' }) }), code: 'FORK_PULL_REQUEST_UNSUPPORTED' },
    { name: 'different pull request', value: result({ candidate: candidate({ pullRequest: 8 }), ...({} as object) }), code: 'RESULT_PULL_REQUEST_MISMATCH' },
    { name: 'different head sha', value: result({ candidate: candidate({ headSha: '5'.repeat(40) }) }), code: 'RESULT_HEAD_MISMATCH' },
    { name: 'different expected head', value: result(), request: request({ expectedHeadSha: '5'.repeat(40) }), code: 'RESULT_HEAD_MISMATCH' },
  ];

  for (const item of cases) {
    const fake = new PublishingFake();
    await assert.rejects(
      () => publishPrResult(publishInput(item.value, item.request ?? request(), fake, config(), new MemoryPrChecksPublicationStore())),
      (error: unknown) => {
        assert.equal(rejectedCode(error), item.code, item.name);
        return true;
      },
      item.name,
    );
    assert.equal(fake.writes.length, 0, item.name);
  }
});

test('rejects absent evidence manifests, incomplete cleanup and violated result invariants without writes', async () => {
  const cases: Array<{ name: string; value: PrVerificationResult; code: PrChecksPublicationErrorCode }> = [
    { name: 'missing manifest', value: result({ ...({} as object) }), code: 'EVIDENCE_MANIFEST_MISSING' },
    { name: 'cleanup incomplete', value: result({ cleanupComplete: false }), code: 'CLEANUP_INCOMPLETE' },
    { name: 'result marked superseded', value: result({ superseded: true }), code: 'RESULT_SUPERSEDED' },
    { name: 'unknown verdict string', value: { ...result(), verdict: '�除' as PrVerificationResult['verdict'] }, code: 'INVALID_VERDICT' },
  ];

  for (const item of cases) {
    const fake = new PublishingFake();
    const value = item.name === 'missing manifest' ? { ...result(), evidenceManifestSha256: '' } : item.value;
    await assert.rejects(
      () => publishPrResult(publishInput(value, request(), fake, config(), new MemoryPrChecksPublicationStore())),
      (error: unknown) => {
        assert.equal(rejectedCode(error), item.code, item.name);
        return true;
      },
      item.name,
    );
    assert.equal(fake.calls.length, 0, item.name);
  }
});

test('accepts failure and action_required publications keyed by verdict mapping', async () => {
  const failed = new PublishingFake();
  const failedOutcome = await publishPrResult(
    publishInput(
      result({ verdict: 'Failed', observations: [observation({ status: 'Failed', exitCode: 1 })], limitations: ['unit-suite failed'] }),
      request(),
      failed,
      config(),
      new MemoryPrChecksPublicationStore(),
    ),
  );

  assert.equal(failedOutcome.conclusion, 'failure');
  const failedCheck = failed.writes.find((item) => item.path === `/repos/${REPOSITORY}/check-runs`);
  assert.ok(failedCheck);
  assert.equal((failedCheck!.body as { conclusion: string }).conclusion, 'failure');

  const unknown = new PublishingFake();
  const unknownOutcome = await publishPrResult(
    publishInput(
      result({ verdict: 'Unknown', observations: [], plan: plan({ requiredChecks: [], generatedTests: [] }), limitations: ['no check executed'] }),
      request(),
      unknown,
      config(),
      new MemoryPrChecksPublicationStore(),
    ),
  );

  assert.equal(unknownOutcome.conclusion, 'action_required');
  const unknownCheck = unknown.writes.find((item) => item.path === `/repos/${REPOSITORY}/check-runs`);
  assert.ok(unknownCheck);
  assert.equal((unknownCheck!.body as { conclusion: string }).conclusion, 'action_required');
});

test('rejected unjustified Verified successes are never published as success', async () => {
  const cases: Array<{ name: string; value: PrVerificationResult }> = [
    {
      name: 'missing observation for a required check',
      value: result({ plan: plan({ requiredChecks: [requiredCheck('unit-suite'), requiredCheck('lint-suite')] }), observations: [observation()] }),
    },
    { name: 'no observations at all', value: result({ observations: [] }) },
    {
      name: 'observation disagrees with the verdict',
      value: result({ observations: [observation({ status: 'Failed', exitCode: 1 })] }),
    },
    {
      name: 'observation ran on another commit',
      value: result({ observations: [observation({ commitSha: '6'.repeat(40) })] }),
    },
    {
      name: 'observation content digest differs from the planned test',
      value: result({ observations: [observation({ testContentSha256: 'c'.repeat(64).replace('c', 'd') })] }),
    },
    {
      name: 'observation did not execute',
      value: result({ observations: [observation({ executed: false, exitCode: null })] }),
    },
  ];

  for (const item of cases) {
    const fake = new PublishingFake();
    await assert.rejects(
      () => publishPrResult(publishInput(item.value, request(), fake, config(), new MemoryPrChecksPublicationStore())),
      (error: unknown) => {
        assert.equal(rejectedCode(error), 'UNVERIFIED_SUCCESS_REJECTED', item.name);
        return true;
      },
      item.name,
    );
    assert.equal(fake.writes.length, 0, item.name);
  }
});

test('publication requires the explicit strict branch protection assumption', async () => {
  const fake = new PublishingFake();
  const unsafe = { ...config(), assumeStrictBranchProtection: false };
  await assert.rejects(
    () => publishPrResult(publishInput(result(), request(), fake, unsafe, new MemoryPrChecksPublicationStore())),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'BRANCH_PROTECTION_ASSUMPTION_REQUIRED');
      return true;
    },
  );
  assert.equal(fake.calls.length, 0);
});

test('publication accepts a configured principal id and refuses one outside the configured bounds', async () => {
  const fake = new PublishingFake();
  const store = new MemoryPrChecksPublicationStore();
  const outcome = await publishPrResult(publishInput(result(), request(), fake, config({ principal: 'operator@team_1' }), store));

  assert.equal(outcome.outcome, 'published');
  assert.equal(store.get(prChecksPublicationKey(REPOSITORY, PULL_REQUEST, HEAD_SHA))?.principal, 'operator@team_1');

  const rejected = new PublishingFake();
  await assert.rejects(
    () => publishPrResult(publishInput(result(), request(), rejected, config({ principal: 'x'.repeat(65) }), new MemoryPrChecksPublicationStore())),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'INVALID_PUBLICATION_INPUT');
      return true;
    },
  );
  assert.equal(rejected.calls.length, 0);
});

test('closed, draft or forked live PR metadata is rejected before any write', async () => {
  const cases: Array<{ name: string; value: PullMetadata; code: PrChecksPublicationErrorCode }> = [
    { name: 'closed', value: metadata({ state: 'closed' }), code: 'PULL_REQUEST_CLOSED' },
    { name: 'draft', value: metadata({ draft: true }), code: 'PULL_REQUEST_DRAFT' },
    { name: 'forked head', value: metadata({ headRepository: 'someone/shop' }), code: 'FORK_PULL_REQUEST_UNSUPPORTED' },
    { name: 'private head', value: metadata({ headPrivate: true }), code: 'PRIVATE_REPOSITORY_UNSUPPORTED' },
  ];

  for (const item of cases) {
    const fake = new PublishingFake({ metadata: [item.value, item.value, item.value] });
    await assert.rejects(
      () => publishPrResult(publishInput(result(), request(), fake, config(), new MemoryPrChecksPublicationStore())),
      (error: unknown) => {
        assert.equal(rejectedCode(error), item.code, item.name);
        return true;
      },
      item.name,
    );
    assert.equal(fake.writes.length, 0, item.name);
  }
});

test('untrusted verifier text is bounded, code-fenced and cannot inject markup or credentials', async () => {
  const fake = new PublishingFake();
  const hostile = [
    'x'.repeat(100_000),
    `${'`'.repeat(5)} evil-code ${'`'.repeat(5)}`,
    '[click](https://evil.example) and https://phish.example and <script>alert(1)</script>',
    'line\nbreak\u0007bell\u0000null',
  ];
  const store = new MemoryPrChecksPublicationStore();

  const outcome = await publishPrResult(
    publishInput(
      result({ verdict: 'Failed', observations: [observation({ status: 'Failed', exitCode: 1 })], limitations: hostile }),
      request(),
      fake,
      config(),
      store,
    ),
  );

  const checkPost = fake.writes.find((item) => item.path === `/repos/${REPOSITORY}/check-runs`);
  assert.ok(checkPost);
  const summary = (checkPost!.body as { output: { summary: string } }).output.summary;
  assert.equal(outcome.outcome, 'published');
  assert.ok(summary.length <= PR_CHECKS_LIMITS.maxSummaryCharacters, 'check summary must stay within the bound');
  assert.ok(!summary.includes('x'.repeat(600)), 'each limitation must be truncated');
  assert.ok(!summary.includes('<script>'), 'markup must not survive sanitization');
  assert.ok(!summary.includes('```'), 'backticks must be neutralized before code fencing');
  const commentPost = fake.writes.find((item) => item.path === `/repos/${REPOSITORY}/issues/${PULL_REQUEST}/comments`);
  assert.ok(commentPost);
  const comment = (commentPost!.body as { body: string }).body;
  assert.ok(comment.length <= PR_CHECKS_LIMITS.maxCommentCharacters, 'comment must stay within the bound');
  assert.ok(!comment.includes(TOKEN), 'no credential may reach GitHub text');
  assert.ok(!comment.includes(PRINCIPAL), 'the trusted principal is not published');
  const serializedWrites = JSON.stringify(fake.writes);
  assert.ok(!serializedWrites.includes(TOKEN), 'no credential may reach GitHub payloads');
  const record = await store.get(prChecksPublicationKey(REPOSITORY, PULL_REQUEST, HEAD_SHA));
  assert.ok(record);
  const serializedStore = JSON.stringify(record);
  assert.ok(!serializedStore.includes(TOKEN), 'no credential may be persisted');
  assert.equal((record as PrChecksPublicationRecord).principal, PRINCIPAL);
});

test('publication cannot run without trusted config and injected wiring', async () => {
  const fake = new PublishingFake();
  const base = () => publishInput(result(), request(), fake, config(), new MemoryPrChecksPublicationStore());
  const cases: Array<{ name: string; value: unknown; code: PrChecksPublicationErrorCode }> = [
    { name: 'empty token', value: { ...base(), token: '' }, code: 'INVALID_PUBLICATION_INPUT' },
    { name: 'untrusted source', value: { ...base(), resultSource: 'client' }, code: 'INVALID_PUBLICATION_INPUT' },
    { name: 'hostile principal', value: { ...base(), principal: 'bad principal\n' }, code: 'INVALID_PUBLICATION_INPUT' },
    { name: 'missing job', value: { transport: fake, ...config(), store: new MemoryPrChecksPublicationStore() }, code: 'INVALID_PUBLICATION_INPUT' },
    { name: 'job without transport', value: { job: jobFor(result(), request()), ...config(), store: new MemoryPrChecksPublicationStore() }, code: 'INVALID_PUBLICATION_INPUT' },
    { name: 'job without store', value: { job: jobFor(result(), request()), transport: fake, ...config() }, code: 'INVALID_PUBLICATION_INPUT' },
    { name: 'malformed job', value: { ...base(), job: null }, code: 'INVALID_PUBLICATION_INPUT' },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => publishPrResult(item.value),
      (error: unknown) => {
        assert.equal(rejectedCode(error), item.code, item.name);
        return true;
      },
      item.name,
    );
  }
  assert.equal(fake.calls.length, 0);
});
