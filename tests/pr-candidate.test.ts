import test from 'node:test';
import assert from 'node:assert/strict';
import type { GitHubTransport } from '../packages/core/github/index.js';
import type { PrVerificationRequest } from '../packages/contracts/src/index.js';
import {
  CandidateResolutionError,
  candidateDiffDigest,
  resolveCandidate,
  type CandidateResolutionErrorCode,
} from '../services/pr-verification/candidate.js';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const NEXT_SHA = '3'.repeat(40);
const MERGE_BASE_SHA = '4'.repeat(40);
const REPOSITORY = 'acme/shop';
const PULL_REQUEST = 7;

interface RepoIdentity {
  full_name: string;
  private: boolean;
  id?: number;
}

interface PullMetadata {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  base: { ref: string; sha: string; repo: RepoIdentity | null };
  head: { ref: string; sha: string; repo: RepoIdentity | null };
  changed_files: number;
}

interface PullFile {
  filename: string;
  status: string;
  changes: number;
  patch?: string;
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
  changedFiles?: number;
  dropBaseSha?: boolean;
  dropHeadRepo?: boolean;
} = {}): PullMetadata {
  const repository = (fullName: string, isPrivate: boolean): RepoIdentity => ({ full_name: fullName, private: isPrivate, id: 99 });
  return {
    number: PULL_REQUEST,
    state: overrides.state ?? 'open',
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false,
    base: {
      ref: 'main',
      sha: overrides.dropBaseSha ? (undefined as unknown as string) : (overrides.baseSha ?? BASE_SHA),
      repo: repository(overrides.baseRepository ?? REPOSITORY, overrides.basePrivate ?? false),
    },
    head: {
      ref: 'agent/fix',
      sha: overrides.headSha ?? HEAD_SHA,
      repo: overrides.dropHeadRepo
        ? null
        : repository(overrides.headRepository ?? REPOSITORY, overrides.headPrivate ?? false),
    },
    changed_files: overrides.changedFiles ?? 1,
  };
}

class FakeGitHub implements GitHubTransport {
  readonly calls: Array<{ method: string; path: string; token?: string }> = [];
  readonly metadataQueue: PullMetadata[];
  readonly pages: Map<number, PullFile[]>;
  compareResponse: unknown;

  constructor(options: {
    metadata: PullMetadata[];
    pages?: Map<number, PullFile[]>;
    compare?: unknown;
  }) {
    this.metadataQueue = options.metadata;
    this.pages = options.pages ?? new Map([[1, [{ filename: 'src/app.ts', status: 'modified', changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }]]]);
    this.compareResponse = options.compare ?? {
      status: 'ahead',
      base_commit: { sha: BASE_SHA },
      merge_base_commit: { sha: MERGE_BASE_SHA },
    };
  }

  async request<T>(method: string, path: string, _body?: unknown, token?: string): Promise<T> {
    this.calls.push({ method, path, ...(token ? { token } : {}) });
    const pullPath = `/repos/${REPOSITORY}/pulls/${PULL_REQUEST}`;
    if (method === 'GET' && path === pullPath) {
      const next = this.metadataQueue.shift();
      if (!next) throw new Error('no metadata queued');
      return structuredClone(next) as T;
    }
    if (method === 'GET' && path === `/repos/${REPOSITORY}/compare/${BASE_SHA}...${HEAD_SHA}?per_page=1`) {
      return structuredClone(this.compareResponse) as T;
    }
    const pageMatch = path.match(new RegExp(`^/repos/${REPOSITORY}/pulls/${PULL_REQUEST}/files\\?per_page=100&page=(\\d+)$`));
    if (method === 'GET' && pageMatch) {
      return structuredClone(this.pages.get(Number(pageMatch[1])) ?? []) as T;
    }
    throw new Error(`unexpected GitHub request: ${method} ${path}`);
  }
}

function request(overrides: Partial<PrVerificationRequest> = {}): PrVerificationRequest {
  return {
    repository: REPOSITORY,
    pullRequest: PULL_REQUEST,
    expectedHeadSha: HEAD_SHA,
    ...overrides,
  };
}

function rejectedCode(error: unknown): CandidateResolutionErrorCode | undefined {
  return error instanceof CandidateResolutionError ? error.code : undefined;
}

test('resolves a public same-repo PR head and base from live metadata', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    filename: `src/file-${String(index).padStart(3, '0')}.ts`,
    status: 'modified',
    changes: 1,
    patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}`,
  }));
  const secondPage = [{ filename: 'README.md', status: 'added', changes: 1, patch: '@@ -0,0 +1 @@\n+hello' }];
  const fake = new FakeGitHub({
    metadata: [metadata({ changedFiles: 101 }), metadata({ changedFiles: 101 })],
    pages: new Map([[1, firstPage], [2, secondPage]]),
  });

  const changed = [...firstPage, ...secondPage]
    .map(({ filename, status, patch }) => ({ filename, status, patch }))
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));

  const candidate = await resolveCandidate(request(), fake, { token: 'test-token' });

  assert.deepEqual(candidate, {
    repository: REPOSITORY,
    pullRequest: PULL_REQUEST,
    headRepository: REPOSITORY,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    changedFiles: changed.map((file) => file.filename),
    diffDigest: candidateDiffDigest(changed),
  });
  assert.equal(candidate.changedFiles.length, 101);
  assert.match(candidate.diffDigest, /^[0-9a-f]{64}$/);
  assert.equal('verdict' in candidate, false);

  const pullReads = fake.calls.filter((call) => call.path === `/repos/${REPOSITORY}/pulls/${PULL_REQUEST}`);
  assert.equal(pullReads.length, 2);
  assert.equal(fake.calls.filter((call) => call.path.includes('/files?')).length, 2);
  assert.ok(fake.calls.some((call) => call.path.includes('/compare/')));
  assert.ok(fake.calls.every((call) => call.method === 'GET'));
  assert.ok(fake.calls.every((call) => call.token === 'test-token'));
  assert.equal(JSON.stringify(candidate).includes('test-token'), false);
});

test('computes one canonical digest over sorted filenames, statuses and patches', () => {
  const files = [
    { filename: 'src/b.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
    { filename: 'src/a.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+first' },
  ];
  const reordered = [files[1], files[0]];
  const digest = candidateDiffDigest(files);

  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(candidateDiffDigest(reordered), digest);
  assert.notEqual(candidateDiffDigest([{ ...files[0], patch: '@@ -1 +1 @@\n-old\n+different' }, files[1]]), digest);
  assert.notEqual(candidateDiffDigest([{ ...files[0], status: 'removed' }, files[1]]), digest);
  assert.notEqual(candidateDiffDigest([{ ...files[0], filename: 'src/c.ts' }, files[1]]), digest);
});

test('rejects an expected head that does not match the live PR head', async () => {
  const fake = new FakeGitHub({ metadata: [metadata()] });
  await assert.rejects(
    () => resolveCandidate(request({ expectedHeadSha: NEXT_SHA }), fake),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'EXPECTED_HEAD_MISMATCH');
      assert.equal((error as CandidateResolutionError).status, 409);
      return true;
    },
  );
  assert.equal(fake.calls.length, 1);
});

test('rejects closed, merged, draft, fork and private PRs before reading files', async () => {
  const cases: Array<{ name: string; value: PullMetadata; code: CandidateResolutionErrorCode }> = [
    { name: 'closed', value: metadata({ state: 'closed' }), code: 'PULL_REQUEST_CLOSED' },
    { name: 'merged', value: metadata({ merged: true }), code: 'PULL_REQUEST_CLOSED' },
    { name: 'draft', value: metadata({ draft: true }), code: 'PULL_REQUEST_DRAFT' },
    { name: 'fork', value: metadata({ headRepository: 'someone/shop' }), code: 'FORK_PULL_REQUEST_UNSUPPORTED' },
    { name: 'private base', value: metadata({ basePrivate: true }), code: 'PRIVATE_REPOSITORY_UNSUPPORTED' },
    { name: 'private head', value: metadata({ headPrivate: true }), code: 'PRIVATE_REPOSITORY_UNSUPPORTED' },
  ];

  for (const item of cases) {
    const fake = new FakeGitHub({ metadata: [item.value] });
    await assert.rejects(
      () => resolveCandidate(request(), fake),
      (error: unknown) => {
        assert.equal(rejectedCode(error), item.code, item.name);
        return true;
      },
      item.name,
    );
    assert.equal(fake.calls.filter((call) => call.path.includes('/files?')).length, 0, item.name);
  }
});

test('rejects missing or malformed live commit SHAs instead of inventing identity', async () => {
  const cases: Array<{ name: string; value: PullMetadata; code: CandidateResolutionErrorCode }> = [
    { name: 'missing base sha', value: metadata({ dropBaseSha: true }), code: 'MISSING_COMMIT_SHA' },
    { name: 'short head sha', value: metadata({ headSha: 'abc123' }), code: 'INVALID_COMMIT_SHA' },
    { name: 'missing head repo', value: metadata({ dropHeadRepo: true }), code: 'MALFORMED_GITHUB_RESPONSE' },
  ];

  for (const item of cases) {
    const fake = new FakeGitHub({ metadata: [item.value] });
    await assert.rejects(
      () => resolveCandidate(request({ expectedHeadSha: HEAD_SHA }), fake),
      (error: unknown) => {
        assert.equal(rejectedCode(error), item.code, item.name);
        return true;
      },
      item.name,
    );
  }
});

test('rejects a base that is not an ancestor of the PR head', async () => {
  for (const status of ['behind', 'diverged']) {
    const fake = new FakeGitHub({
      metadata: [metadata()],
      compare: { status, merge_base_commit: { sha: MERGE_BASE_SHA } },
    });
    await assert.rejects(
      () => resolveCandidate(request(), fake),
      (error: unknown) => {
        assert.equal(rejectedCode(error), 'BASE_NOT_ANCESTOR', status);
        assert.equal((error as CandidateResolutionError).status, 409);
        return true;
      },
      status,
    );
  }
});

test('rejects a truncated file list and unavailable patches', async () => {
  const truncated = new FakeGitHub({
    metadata: [metadata({ changedFiles: 3 }), metadata({ changedFiles: 3 })],
    pages: new Map([[1, [{ filename: 'src/app.ts', status: 'modified', changes: 1, patch: '@@ -1 +1 @@\n-a\n+b' }]]]),
  });
  await assert.rejects(
    () => resolveCandidate(request(), truncated),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'FILE_LIST_TRUNCATED');
      assert.equal((error as CandidateResolutionError).status, 422);
      return true;
    },
  );

  const noPatch = new FakeGitHub({
    metadata: [metadata()],
    pages: new Map([[1, [{ filename: 'logo.png', status: 'modified', changes: 4 }]]]),
  });
  await assert.rejects(
    () => resolveCandidate(request(), noPatch),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'FILE_PATCH_UNAVAILABLE');
      assert.equal((error as CandidateResolutionError).status, 422);
      return true;
    },
  );
});

test('rejects a file listing that overflows the bounded intake', async () => {
  const fake = new FakeGitHub({ metadata: [metadata({ changedFiles: 3001 })] });
  await assert.rejects(
    () => resolveCandidate(request(), fake),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'FILE_LIST_OVERFLOW');
      assert.equal((error as CandidateResolutionError).status, 413);
      return true;
    },
  );
  assert.equal(fake.calls.filter((call) => call.path.includes('/files?')).length, 0);

  const oversizedPatch = new FakeGitHub({
    metadata: [metadata()],
    pages: new Map([[1, [{ filename: 'src/huge.ts', status: 'modified', changes: 1, patch: 'x'.repeat(1_000_001) }]]]),
  });
  await assert.rejects(
    () => resolveCandidate(request(), oversizedPatch),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'FILE_LIST_OVERFLOW');
      return true;
    },
  );
});

test('rejects metadata that changes between the before and after reads', async () => {
  const changedHead = new FakeGitHub({
    metadata: [metadata(), metadata({ headSha: NEXT_SHA })],
  });
  await assert.rejects(
    () => resolveCandidate(request(), changedHead),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'CANDIDATE_CHANGED');
      assert.equal((error as CandidateResolutionError).status, 409);
      return true;
    },
  );

  const changedBase = new FakeGitHub({
    metadata: [metadata(), metadata({ baseSha: NEXT_SHA })],
  });
  await assert.rejects(
    () => resolveCandidate(request(), changedBase),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'CANDIDATE_CHANGED');
      return true;
    },
  );
});

test('rejects invalid repository, pull request and expected head input without calling GitHub', async () => {
  const fake = new FakeGitHub({ metadata: [] });
  const invalid: Array<{ name: string; value: unknown; code: CandidateResolutionErrorCode }> = [
    { name: 'missing repository', value: request({ repository: '' }), code: 'INVALID_REPOSITORY' },
    { name: 'repository without owner', value: request({ repository: 'shop' }), code: 'INVALID_REPOSITORY' },
    { name: 'repository with extra path', value: request({ repository: 'acme/shop/extra' }), code: 'INVALID_REPOSITORY' },
    { name: 'repository traversal', value: request({ repository: '../shop' }), code: 'INVALID_REPOSITORY' },
    { name: 'zero PR', value: request({ pullRequest: 0 }), code: 'INVALID_PULL_REQUEST' },
    { name: 'negative PR', value: request({ pullRequest: -1 }), code: 'INVALID_PULL_REQUEST' },
    { name: 'fractional PR', value: request({ pullRequest: 1.5 }), code: 'INVALID_PULL_REQUEST' },
    { name: 'string PR', value: request({ pullRequest: '7' as unknown as number }), code: 'INVALID_PULL_REQUEST' },
    { name: 'missing expected head', value: request({ expectedHeadSha: '' }), code: 'INVALID_EXPECTED_HEAD' },
    { name: 'short expected head', value: request({ expectedHeadSha: 'abc123' }), code: 'INVALID_EXPECTED_HEAD' },
    { name: 'non-hex expected head', value: request({ expectedHeadSha: 'z'.repeat(40) }), code: 'INVALID_EXPECTED_HEAD' },
  ];

  for (const item of invalid) {
    await assert.rejects(
      () => resolveCandidate(item.value as PrVerificationRequest, fake),
      (error: unknown) => {
        assert.equal(rejectedCode(error), item.code, item.name);
        return true;
      },
      item.name,
    );
  }
  assert.equal(fake.calls.length, 0);
});

test('returns the live GitHub repository name after accepting case-insensitive input', async () => {
  const liveName = 'Acme/Shop';
  const fake = new FakeGitHub({
    metadata: [
      metadata({ baseRepository: liveName, headRepository: liveName }),
      metadata({ baseRepository: liveName, headRepository: liveName }),
    ],
  });
  const candidate = await resolveCandidate(request({ repository: 'Acme/Shop' }), fake);
  assert.equal(candidate.repository, liveName);
  assert.equal(candidate.headRepository, liveName);
});
