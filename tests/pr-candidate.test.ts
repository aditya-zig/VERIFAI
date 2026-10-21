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
const MERGE_BASE_SHA = BASE_SHA;
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
  additions: number;
  deletions: number;
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
  compareResponse: unknown;

  constructor(options: {
    metadata: PullMetadata[];
    files?: PullFile[];
    compare?: unknown;
  }) {
    this.metadataQueue = options.metadata;
    this.compareResponse = options.compare ?? {
      status: 'ahead',
      base_commit: { sha: BASE_SHA },
      merge_base_commit: { sha: MERGE_BASE_SHA },
      files: options.files ?? [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }],
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
    if (method === 'GET' && path === `/repos/${REPOSITORY}/compare/${BASE_SHA}...${HEAD_SHA}?per_page=1&page=1`) {
      return structuredClone(this.compareResponse) as T;
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
  const initialFiles = Array.from({ length: 100 }, (_, index) => ({
    filename: `src/file-${String(index).padStart(3, '0')}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}`,
  }));
  const additionalFiles = [{ filename: 'README.md', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+hello' }];
  const fake = new FakeGitHub({
    metadata: [metadata({ changedFiles: 101 }), metadata({ changedFiles: 101 })],
    files: [...initialFiles, ...additionalFiles],
  });

  const changed = [...initialFiles, ...additionalFiles]
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
  assert.equal(fake.calls.filter((call) => call.path.includes('/files?')).length, 0);
  assert.equal(fake.calls.filter((call) => call.path.includes('/compare/')).length, 1);
  assert.ok(fake.calls.every((call) => call.method === 'GET'));
  assert.ok(fake.calls.every((call) => call.token === 'test-token'));
  assert.equal(JSON.stringify(candidate).includes('test-token'), false);
});

test('accepts complete unified hunks with context, section text and no-newline markers', async () => {
  const patch = [
    '@@ -1,2 +1,2 @@ function first()',
    ' context one',
    '-old line',
    '\\ No newline at end of file',
    '+new line',
    '\\ No newline at end of file',
    '@@ -10,2 +10,3 @@',
    ' context two',
    '+added line',
    ' context three',
    '\\ No newline at end of file',
  ].join('\n');
  const file = { filename: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, changes: 3, patch };
  const fake = new FakeGitHub({
    metadata: [metadata(), metadata()],
    files: [file],
  });

  const candidate = await resolveCandidate(request(), fake);

  assert.deepEqual(candidate.changedFiles, ['src/app.ts']);
  assert.equal(candidate.diffDigest, candidateDiffDigest([file]));
});

test('rejects a present patch whose parsed added and deleted lines disagree with GitHub counts', async () => {
  const cases: Array<{ name: string; file: PullFile }> = [
    {
      name: 'fewer added lines than reported',
      file: {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 2,
        deletions: 0,
        changes: 2,
        patch: '@@ -0,0 +1 @@\n+only one',
      },
    },
    {
      name: 'fewer deleted lines than reported',
      file: {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 2,
        changes: 3,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    },
    {
      name: 'reported changes do not equal additions plus deletions',
      file: {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    },
    {
      name: 'empty patch despite reported changes',
      file: {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '',
      },
    },
  ];

  for (const item of cases) {
    const fake = new FakeGitHub({
      metadata: [metadata(), metadata()],
      files: [item.file],
    });
    await assert.rejects(
      () => resolveCandidate(request(), fake),
      (error: unknown) => {
        assert.equal(rejectedCode(error), 'FILE_PATCH_TRUNCATED', item.name);
        assert.equal((error as CandidateResolutionError).status, 422, item.name);
        return true;
      },
      item.name,
    );
  }
});

test('rejects an incomplete hunk even when parsed totals match the reported file counts', async () => {
  const file: PullFile = {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@ -1,2 +1,2 @@\n-old\n+new',
  };
  const fake = new FakeGitHub({
    metadata: [metadata(), metadata()],
    files: [file],
  });

  await assert.rejects(
    () => resolveCandidate(request(), fake),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'FILE_PATCH_TRUNCATED');
      assert.equal((error as CandidateResolutionError).status, 422);
      return true;
    },
  );
});

test('rejects zero-change binary and rename context without assuming content preservation', async () => {
  for (const status of ['modified', 'added', 'removed', 'renamed']) {
    for (const patch of [undefined, '', '   ', '@@ -1 +1 @@\n unchanged']) {
      const file: PullFile = {
        filename: 'asset.bin', status, additions: 0, deletions: 0, changes: 0,
        ...(patch === undefined ? {} : { patch }),
      };
      const fake = new FakeGitHub({ metadata: [metadata(), metadata()], files: [file] });
      await assert.rejects(() => resolveCandidate(request(), fake), (error: unknown) => {
        assert.ok(error instanceof CandidateResolutionError);
        assert.equal((error as CandidateResolutionError).status, 422);
        return true;
      }, `${status}: ${String(patch)}`);
    }
  }
});

test('rejects unsupported patch data instead of digesting it', async () => {
  const file: PullFile = {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -1 +1 @@\n?unsupported diff line',
  };
  const fake = new FakeGitHub({
    metadata: [metadata(), metadata()],
    files: [file],
  });

  await assert.rejects(
    () => resolveCandidate(request(), fake),
    (error: unknown) => {
      assert.equal(rejectedCode(error), 'FILE_PATCH_UNSUPPORTED');
      assert.equal((error as CandidateResolutionError).status, 422);
      return true;
    },
  );
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
    files: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-a\n+b' }],
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
    files: [{ filename: 'logo.png', status: 'modified', additions: 2, deletions: 2, changes: 4 }],
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
  const fake = new FakeGitHub({ metadata: [metadata({ changedFiles: 301 })] });
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
    files: [{ filename: 'src/huge.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: 'x'.repeat(1_000_001) }],
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

test('rejects malformed hunk coordinates even when changed-line totals agree', async () => {
  const cases = [
    { name: 'overlapping replacements', patch: '@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-c\n+d', additions: 2, deletions: 2 },
    { name: 'unordered ranges', patch: '@@ -3 +3 @@\n-a\n+b\n@@ -1 +1 @@\n-c\n+d', additions: 2, deletions: 2 },
    { name: 'old range overlap', patch: '@@ -1 +1 @@\n-a\n+b\n@@ -1 +2 @@\n-c\n+d', additions: 2, deletions: 2 },
    { name: 'new range overlap', patch: '@@ -1 +1 @@\n-a\n+b\n@@ -2 +1 @@\n-c\n+d', additions: 2, deletions: 2 },
    { name: 'zero old start with content', patch: '@@ -0 +1 @@\n-a\n+b', additions: 1, deletions: 1 },
    { name: 'zero new start with content', patch: '@@ -1 +0 @@\n-a\n+b', additions: 1, deletions: 1 },
    { name: 'unsafe old start', patch: '@@ -9007199254740992 +1 @@\n-a\n+b', additions: 1, deletions: 1 },
    { name: 'unsafe new start', patch: '@@ -1 +9007199254740992 @@\n-a\n+b', additions: 1, deletions: 1 },
    { name: 'unsafe count', patch: '@@ -1,9007199254740992 +1 @@\n-a\n+b', additions: 1, deletions: 1 },
    { name: 'overflowing end', patch: '@@ -9007199254740991,2 +9007199254740991,2 @@\n-a\n+b\n context', additions: 1, deletions: 1 },
    { name: 'empty ranges', patch: '@@ -0,0 +0,0 @@\n+a', additions: 1, deletions: 0 },
    { name: 'inconsistent first positions', patch: '@@ -2 +3 @@\n-a\n+b', additions: 1, deletions: 1 },
    { name: 'inconsistent unchanged gaps', patch: '@@ -1 +1 @@\n-a\n+b\n@@ -4 +5 @@\n-c\n+d', additions: 2, deletions: 2 },
    { name: 'too many body lines', patch: '@@ -1 +1 @@\n-a\n+b\n+c', additions: 2, deletions: 1 },
    { name: 'too few body lines', patch: '@@ -1,2 +1,2 @@\n-a\n+b', additions: 1, deletions: 1 },
  ];
  for (const item of cases) {
    const file = { filename: 'src/app.ts', status: 'modified', ...item, changes: item.additions + item.deletions };
    const fake = new FakeGitHub({ metadata: [metadata(), metadata()], files: [file] });
    await assert.rejects(() => resolveCandidate(request(), fake), (error: unknown) => {
      assert.equal(rejectedCode(error), 'FILE_PATCH_TRUNCATED', item.name);
      return true;
    }, item.name);
  }
});

test('accepts ordered adjacent ranges and zero-count insertion and deletion coordinates', async () => {
  const cases = [
    { patch: '@@ -1 +1 @@\n-a\n+b\n@@ -2 +2 @@\n-c\n+d', additions: 2, deletions: 2 },
    { patch: '@@ -0,0 +1 @@\n+first\n@@ -4,0 +6 @@\n+next', additions: 2, deletions: 0 },
    { patch: '@@ -1 +0,0 @@\n-first\n@@ -6 +4,0 @@\n-next', additions: 0, deletions: 2 },
    { patch: '@@ -5,0 +6 @@\n+append', additions: 1, deletions: 0 },
    { patch: '@@ -6 +5,0 @@\n-remove', additions: 0, deletions: 1 },
  ];
  for (const item of cases) {
    const file = { filename: 'src/app.ts', status: 'modified', ...item, changes: item.additions + item.deletions };
    const fake = new FakeGitHub({ metadata: [metadata(), metadata()], files: [file] });
    const candidate = await resolveCandidate(request(), fake);
    assert.deepEqual(candidate.changedFiles, ['src/app.ts']);
  }
});

test('accepts all 300 compare files and rejects oversized or mismatched compare lists', async () => {
  const files = Array.from({ length: 300 }, (_, index) => ({
    filename: `src/file-${index}.ts`, status: 'added', additions: 1, deletions: 0, changes: 1,
    patch: '@@ -0,0 +1 @@\n+hello',
  }));
  const accepted = await resolveCandidate(request(), new FakeGitHub({
    metadata: [metadata({ changedFiles: 300 }), metadata({ changedFiles: 300 })], files,
  }));
  assert.equal(accepted.changedFiles.length, 300);
  for (const [batch, code] of [
    [files.slice(1), 'FILE_LIST_TRUNCATED'],
    [[...files, { ...files[0], filename: 'overflow.ts' }], 'FILE_LIST_OVERFLOW'],
  ] as const) {
    const fake = new FakeGitHub({ metadata: [metadata({ changedFiles: 300 })], files: [...batch] });
    await assert.rejects(() => resolveCandidate(request(), fake), (error: unknown) => {
      assert.equal(rejectedCode(error), code);
      return true;
    });
  }
});

test('rejects unavailable compare files, duplicate paths and unsupported file statuses', async () => {
  for (const files of [undefined, null, {}, 'truncated']) {
    const fake = new FakeGitHub({ metadata: [metadata()], compare: {
      status: 'ahead', base_commit: { sha: BASE_SHA }, merge_base_commit: { sha: BASE_SHA }, files,
    } });
    await assert.rejects(() => resolveCandidate(request(), fake), (error: unknown) => {
      assert.equal(rejectedCode(error), 'MALFORMED_GITHUB_RESPONSE');
      return true;
    });
  }
  const file = { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' };
  const duplicate = new FakeGitHub({ metadata: [metadata({ changedFiles: 2 })], files: [file, file] });
  await assert.rejects(() => resolveCandidate(request(), duplicate), (error: unknown) => {
    assert.equal(rejectedCode(error), 'MALFORMED_GITHUB_RESPONSE');
    return true;
  });
  for (const status of ['renamed', 'copied', 'unknown']) {
    const fake = new FakeGitHub({ metadata: [metadata()], files: [{ ...file, status }] });
    await assert.rejects(() => resolveCandidate(request(), fake), (error: unknown) => {
      assert.equal(rejectedCode(error), 'FILE_PATCH_UNSUPPORTED');
      return true;
    });
  }
});

test('rejects a compare merge-base that differs from the pinned base', async () => {
  const fake = new FakeGitHub({ metadata: [metadata()], compare: {
    status: 'ahead', base_commit: { sha: BASE_SHA }, merge_base_commit: { sha: NEXT_SHA }, files: [],
  } });
  await assert.rejects(() => resolveCandidate(request(), fake), (error: unknown) => {
    assert.equal(rejectedCode(error), 'BASE_NOT_ANCESTOR');
    return true;
  });
});

test('pins H1 patch context through an H1 to H2 to H1 force-push race', async () => {
  const h1File = { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' };
  const h2File = { ...h1File, patch: '@@ -1 +1 @@\n-old\n+force-pushed' };
  let liveHead = HEAD_SHA;
  let pullReads = 0;
  let mutableFileReads = 0;
  const transport: GitHubTransport = {
    async request<T>(method: string, path: string): Promise<T> {
      assert.equal(method, 'GET');
      if (path === `/repos/${REPOSITORY}/pulls/${PULL_REQUEST}`) {
        if (pullReads > 0) liveHead = HEAD_SHA;
        const pull = metadata({ headSha: liveHead });
        pullReads += 1;
        if (pullReads === 1) liveHead = NEXT_SHA;
        return pull as T;
      }
      if (path.startsWith(`/repos/${REPOSITORY}/compare/${BASE_SHA}...${HEAD_SHA}?`)) {
        assert.equal(liveHead, NEXT_SHA);
        return { status: 'ahead', base_commit: { sha: BASE_SHA }, merge_base_commit: { sha: BASE_SHA }, files: [h1File] } as T;
      }
      if (path.startsWith(`/repos/${REPOSITORY}/pulls/${PULL_REQUEST}/files?`)) {
        assert.equal(liveHead, NEXT_SHA);
        mutableFileReads += 1;
        liveHead = HEAD_SHA;
        return [h2File] as T;
      }
      throw new Error(`unexpected request: ${path}`);
    },
  };
  const candidate = await resolveCandidate(request(), transport);
  assert.equal(candidate.headSha, HEAD_SHA);
  assert.equal(candidate.diffDigest, '4c5d0cd33e4987e98a0cfc3985278bf1d49c12af67a431c0fb622d056d4bea70');
  assert.notEqual(candidate.diffDigest, '90d30c0357dc558be5fe83820f4a833b2c3619b52428a05bed040091d6f7b1c5');
  assert.equal(pullReads, 2);
  assert.equal(mutableFileReads, 0);
  assert.equal(liveHead, HEAD_SHA);
});
