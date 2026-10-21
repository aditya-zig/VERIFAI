import { createHash } from 'node:crypto';
import type { GitHubTransport } from '../../packages/core/github/index.js';
import type { CandidateRevision, PrVerificationRequest } from '../../packages/contracts/src/index.js';

/**
 * Bounds for one candidate resolution. They are intake limits, not runtime
 * sandbox limits, and they intentionally fail closed instead of truncating.
 */
export const PR_CANDIDATE_LIMITS = Object.freeze({
  maxChangedFiles: 300,
  maxPatchCharactersPerFile: 1_000_000,
  maxTotalPatchCharacters: 16_000_000,
});

export type CandidateResolutionErrorCode =
  | 'INVALID_REPOSITORY'
  | 'INVALID_PULL_REQUEST'
  | 'INVALID_EXPECTED_HEAD'
  | 'PULL_REQUEST_CLOSED'
  | 'PULL_REQUEST_DRAFT'
  | 'FORK_PULL_REQUEST_UNSUPPORTED'
  | 'PRIVATE_REPOSITORY_UNSUPPORTED'
  | 'EXPECTED_HEAD_MISMATCH'
  | 'BASE_NOT_ANCESTOR'
  | 'CANDIDATE_CHANGED'
  | 'MISSING_COMMIT_SHA'
  | 'INVALID_COMMIT_SHA'
  | 'FILE_LIST_TRUNCATED'
  | 'FILE_PATCH_UNAVAILABLE'
  | 'FILE_PATCH_TRUNCATED'
  | 'FILE_PATCH_UNSUPPORTED'
  | 'FILE_LIST_OVERFLOW'
  | 'MALFORMED_GITHUB_RESPONSE';

export class CandidateResolutionError extends Error {
  readonly code: CandidateResolutionErrorCode;
  readonly status: number;

  constructor(code: CandidateResolutionErrorCode, message: string, status: number) {
    super(message);
    this.name = 'CandidateResolutionError';
    this.code = code;
    this.status = status;
  }
}

export interface CandidateResolutionOptions {
  /** Optional GitHub token. Callers must read it from environment configuration. */
  token?: string;
  signal?: AbortSignal;
}

export interface ChangedFileIdentity {
  filename: string;
  status: string;
  patch: string;
}

interface GitHubRepositoryIdentity {
  fullName: string;
  key: string;
  private: false;
  id: string | number | null;
}

interface GitHubPullIdentity {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  base: { ref: string; sha: string; repository: GitHubRepositoryIdentity };
  head: { ref: string; sha: string; repository: GitHubRepositoryIdentity };
  changedFiles: number;
}

interface ParsedRepository {
  owner: string;
  name: string;
  fullName: string;
}

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9_.-]{1,100}$/;
const shaPattern = /^[0-9a-f]{40}$/i;

function fail(code: CandidateResolutionErrorCode, message: string, status: number): never {
  throw new CandidateResolutionError(code, message, status);
}

function malformed(message: string): never {
  return fail('MALFORMED_GITHUB_RESPONSE', message, 502);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) malformed(`${label} must be an object`);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) malformed(`${label} must be a non-empty string`);
  return value;
}

function readOptionalIdentifier(value: unknown, label: string): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') malformed(`${label} must be a string, number or null`);
  return value;
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseRepository(value: unknown): ParsedRepository {
  if (typeof value !== 'string') fail('INVALID_REPOSITORY', 'repository must be owner/name', 400);
  const parts = value.split('/');
  if (parts.length !== 2) fail('INVALID_REPOSITORY', 'repository must be owner/name', 400);
  const [owner, name] = parts;
  if (!ownerPattern.test(owner) || !repositoryNamePattern.test(name) || name === '.' || name === '..') {
    fail('INVALID_REPOSITORY', 'repository must be a valid public GitHub owner/name', 400);
  }
  return { owner, name, fullName: `${owner}/${name}`.toLowerCase() };
}

function parsePullRequest(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('INVALID_PULL_REQUEST', 'pullRequest must be a positive integer', 400);
  }
  return value;
}

function parseExpectedHead(value: unknown): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) {
    fail('INVALID_EXPECTED_HEAD', 'expectedHeadSha must be a 40-character hexadecimal commit SHA', 400);
  }
  return value.toLowerCase();
}

function readCommitSha(value: unknown, label: string): string {
  if (value === undefined || value === null || value === '') {
    fail('MISSING_COMMIT_SHA', `${label} is missing from GitHub metadata`, 502);
  }
  if (typeof value !== 'string' || !shaPattern.test(value)) {
    fail('INVALID_COMMIT_SHA', `${label} is not a 40-character hexadecimal commit SHA`, 502);
  }
  return value.toLowerCase();
}

function readRepositoryIdentity(value: unknown, label: string): GitHubRepositoryIdentity {
  const repo = readRecord(value, label);
  const fullName = readString(repo.full_name, `${label}.full_name`);
  const key = fullName.toLowerCase();
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(key)) malformed(`${label}.full_name is not a GitHub repository name`);
  if (repo.private === true) {
    fail('PRIVATE_REPOSITORY_UNSUPPORTED', 'private repositories are not supported by this intake', 403);
  }
  if (repo.private !== false) malformed(`${label}.private must be a boolean`);
  return {
    fullName,
    key,
    private: false,
    id: readOptionalIdentifier(repo.id, `${label}.id`),
  };
}

function inspectPullMetadata(value: unknown, expected: PrVerificationRequest): GitHubPullIdentity {
  const pull = readRecord(value, 'pull request');

  if (pull.number !== expected.pullRequest) malformed('pull request number does not match the requested PR');
  if (pull.state === 'closed') fail('PULL_REQUEST_CLOSED', 'closed pull requests cannot be admitted', 409);
  if (pull.state !== 'open') malformed('pull request state must be open or closed');
  if (pull.merged === true) fail('PULL_REQUEST_CLOSED', 'merged pull requests cannot be admitted', 409);
  if (typeof pull.merged !== 'boolean') malformed('pull request merged field must be a boolean');
  if (pull.draft === true) fail('PULL_REQUEST_DRAFT', 'draft pull requests cannot be admitted', 409);
  if (typeof pull.draft !== 'boolean') malformed('pull request draft field must be a boolean');

  const base = readRecord(pull.base, 'pull request base');
  const head = readRecord(pull.head, 'pull request head');
  const baseRepository = readRepositoryIdentity(base.repo, 'pull request base repository');
  const headRepository = readRepositoryIdentity(head.repo, 'pull request head repository');

  if (baseRepository.key !== expected.repository.toLowerCase()) {
    malformed('pull request base repository does not match the requested repository');
  }
  if (headRepository.key !== expected.repository.toLowerCase()) {
    fail('FORK_PULL_REQUEST_UNSUPPORTED', 'fork pull requests are not supported by this intake', 403);
  }

  const changedFiles = pull.changed_files;
  if (typeof changedFiles !== 'number' || !Number.isSafeInteger(changedFiles) || changedFiles < 0) {
    malformed('pull request changed_files must be a non-negative integer');
  }

  return {
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    base: {
      ref: readString(base.ref, 'pull request base ref'),
      sha: readCommitSha(base.sha, 'pull request base SHA'),
      repository: baseRepository,
    },
    head: {
      ref: readString(head.ref, 'pull request head ref'),
      sha: readCommitSha(head.sha, 'pull request head SHA'),
      repository: headRepository,
    },
    changedFiles,
  };
}

function identitySnapshot(pull: GitHubPullIdentity): string {
  return JSON.stringify({
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    base: { ref: pull.base.ref, sha: pull.base.sha, repository: pull.base.repository },
    head: { ref: pull.head.ref, sha: pull.head.sha, repository: pull.head.repository },
    changedFiles: pull.changedFiles,
  });
}

function readMergeBase(value: unknown, baseSha: string): string {
  const compare = readRecord(value, 'compare response');
  const status = readString(compare.status, 'compare status');
  if (status !== 'ahead' && status !== 'identical') {
    fail('BASE_NOT_ANCESTOR', 'the pull request base is not an ancestor of the head', 409);
  }
  if (compare.base_commit !== undefined) {
    const baseCommit = readRecord(compare.base_commit, 'compare base commit');
    if (readCommitSha(baseCommit.sha, 'compare base SHA') !== baseSha) {
      malformed('compare base commit does not match the pull request base SHA');
    }
  }
  const mergeBase = readRecord(compare.merge_base_commit, 'compare merge-base commit');
  return readCommitSha(mergeBase.sha, 'compare merge-base SHA');
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const noNewlineMarker = '\\ No newline at end of file';

function patchLines(patch: string): string[] {
  if (patch.trim() === '') return [];
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function readHunkHeader(line: string, filename: string): { oldOffset: number; newOffset: number; oldCount: number; newCount: number } {
  const match = hunkHeaderPattern.exec(line);
  if (!match) {
    fail('FILE_PATCH_UNSUPPORTED', `unsupported hunk header for ${filename}`, 422);
  }
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (![oldStart, newStart, oldCount, newCount].every((value) => Number.isSafeInteger(value) && value >= 0)
    || (oldStart === 0 && oldCount !== 0) || (newStart === 0 && newCount !== 0)
    || (oldCount === 0 && newCount === 0)) {
    fail('FILE_PATCH_TRUNCATED', `hunk coordinates are invalid for ${filename}`, 422);
  }
  const oldOffset = oldCount === 0 ? oldStart : oldStart - 1;
  const newOffset = newCount === 0 ? newStart : newStart - 1;
  if (!Number.isSafeInteger(oldOffset + oldCount) || !Number.isSafeInteger(newOffset + newCount)) {
    fail('FILE_PATCH_TRUNCATED', `hunk ranges are invalid for ${filename}`, 422);
  }
  return { oldOffset, newOffset, oldCount, newCount };
}

function validateUnifiedPatch(file: {
  filename: string;
  status: string;
  patch: string;
  additions: number;
  deletions: number;
  changes: number;
}): void {
  if (file.additions + file.deletions !== file.changes) {
    fail('FILE_PATCH_TRUNCATED', `reported changes do not equal additions plus deletions for ${file.filename}`, 422);
  }

  const lines = patchLines(file.patch);
  if (lines.length === 0) {
    fail('FILE_PATCH_TRUNCATED', `patch is empty despite reported changes for ${file.filename}`, 422);
  }

  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let index = 0;
  let oldEnd = 0;
  let newEnd = 0;
  let oldTerminated = false;
  let newTerminated = false;
  while (index < lines.length) {
    const header = readHunkHeader(lines[index], file.filename);
    if ((file.status === 'added' && (header.oldOffset !== 0 || header.oldCount !== 0))
      || (file.status === 'removed' && (header.newOffset !== 0 || header.newCount !== 0))) {
      fail('FILE_PATCH_TRUNCATED', `hunk does not preserve the empty side of ${file.status} file ${file.filename}`, 422);
    }
    if ((oldTerminated && (header.oldOffset !== oldEnd || header.oldCount !== 0))
      || (newTerminated && (header.newOffset !== newEnd || header.newCount !== 0))) {
      fail('FILE_PATCH_UNSUPPORTED', `hunk continues beyond a terminated file side for ${file.filename}`, 422);
    }
    if (header.oldOffset < oldEnd || header.newOffset < newEnd
      || header.oldOffset - oldEnd !== header.newOffset - newEnd) {
      fail('FILE_PATCH_TRUNCATED', `hunk ranges overlap, are unordered or have inconsistent gaps for ${file.filename}`, 422);
    }
    oldEnd = header.oldOffset + header.oldCount;
    newEnd = header.newOffset + header.newCount;
    hunks += 1;
    index += 1;
    let oldRemaining = header.oldCount;
    let newRemaining = header.newCount;
    let sawBody = false;
    let previousOldDelta = 0;
    let previousNewDelta = 0;

    while (index < lines.length && !lines[index].startsWith('@@')) {
      const line = lines[index];
      if (line === noNewlineMarker) {
        if (previousOldDelta === 0 && previousNewDelta === 0) {
          fail('FILE_PATCH_UNSUPPORTED', `no-newline marker does not follow a content line for ${file.filename}`, 422);
        }
        if (previousOldDelta !== 0) oldTerminated = true;
        if (previousNewDelta !== 0) newTerminated = true;
        previousOldDelta = 0;
        previousNewDelta = 0;
        index += 1;
        continue;
      }

      let oldDelta = 0;
      let newDelta = 0;
      if (line.startsWith(' ')) {
        oldDelta = 1;
        newDelta = 1;
      } else if (line.startsWith('+')) {
        newDelta = 1;
        additions += 1;
      } else if (line.startsWith('-')) {
        oldDelta = 1;
        deletions += 1;
      } else {
        fail('FILE_PATCH_UNSUPPORTED', `unsupported diff line for ${file.filename}`, 422);
      }

      if ((oldTerminated && oldDelta !== 0) || (newTerminated && newDelta !== 0)) {
        fail('FILE_PATCH_UNSUPPORTED', `content follows a terminated file side for ${file.filename}`, 422);
      }
      oldRemaining -= oldDelta;
      newRemaining -= newDelta;
      if (oldRemaining < 0 || newRemaining < 0) {
        fail('FILE_PATCH_TRUNCATED', `hunk contains more lines than its header declares for ${file.filename}`, 422);
      }
      sawBody = true;
      previousOldDelta = oldDelta;
      previousNewDelta = newDelta;
      index += 1;
    }

    if (!sawBody) {
      fail('FILE_PATCH_TRUNCATED', `hunk has no body for ${file.filename}`, 422);
    }
    if (oldRemaining !== 0 || newRemaining !== 0) {
      fail('FILE_PATCH_TRUNCATED', `hunk body is shorter than its header declares for ${file.filename}`, 422);
    }
  }

  if (hunks === 0) {
    fail('FILE_PATCH_TRUNCATED', `patch has no hunks for ${file.filename}`, 422);
  }
  if (additions !== file.additions || deletions !== file.deletions) {
    fail(
      'FILE_PATCH_TRUNCATED',
      `parsed patch totals do not match GitHub counts for ${file.filename} (${additions}/${deletions} vs ${file.additions}/${file.deletions})`,
      422,
    );
  }
}

function readChangedFile(value: unknown): ChangedFileIdentity {
  const file = readRecord(value, 'changed file');
  const filename = readString(file.filename, 'changed file filename');
  if (filename.length > 4_096 || filename.includes('\0')) malformed('changed file filename is invalid');
  const status = readString(file.status, 'changed file status');
  if (!['added', 'removed', 'modified'].includes(status)) {
    fail('FILE_PATCH_UNSUPPORTED', `changed file status ${status} is unsupported for ${filename}`, 422);
  }
  const additions = readNonNegativeInteger(file.additions, `changed file ${filename} additions`);
  const deletions = readNonNegativeInteger(file.deletions, `changed file ${filename} deletions`);
  const changes = readNonNegativeInteger(file.changes, `changed file ${filename} changes`);

  let patch: string;
  if (typeof file.patch === 'string') {
    patch = file.patch;
  } else {
    fail('FILE_PATCH_UNAVAILABLE', `patch data is unavailable for ${filename}; binary or oversized diffs are unsupported`, 422);
  }
  if (patch.length > PR_CANDIDATE_LIMITS.maxPatchCharactersPerFile) {
    fail('FILE_LIST_OVERFLOW', `patch for ${filename} exceeds the per-file intake limit`, 413);
  }
  if (changes === 0) {
    fail('FILE_PATCH_UNSUPPORTED', `zero-change patch context is unsupported for ${filename}`, 422);
  }
  validateUnifiedPatch({ filename, status, patch, additions, deletions, changes });
  return { filename, status, patch };
}

/**
 * Hash the validated, reported patch text. This is a patch digest, not a
 * full-file or tree digest; it cannot prove omitted bytes if GitHub returns a
 * patch whose counts still agree with its own metadata.
 */
export function candidateDiffDigest(files: readonly ChangedFileIdentity[]): string {
  const canonical = [...files]
    .map(({ filename, status, patch }) => ({ filename, status, patch }))
    .sort((left, right) => {
      if (left.filename !== right.filename) return left.filename < right.filename ? -1 : 1;
      if (left.status !== right.status) return left.status < right.status ? -1 : 1;
      return left.patch < right.patch ? -1 : left.patch > right.patch ? 1 : 0;
    });
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * Resolve an immutable, public, same-repository pull request candidate.
 *
 * This function only pins identity and changed-file bytes. It does not run
 * checks, publish evidence or produce a PrVerdict. Callers must re-check the
 * head and base after execution and before publication.
 */
export async function resolveCandidate(
  input: PrVerificationRequest,
  transport: GitHubTransport,
  options: CandidateResolutionOptions = {},
): Promise<CandidateRevision> {
  if (!isRecord(input)) fail('MALFORMED_GITHUB_RESPONSE', 'candidate request must be an object', 400);
  const repository = parseRepository(input.repository);
  const pullRequest = parsePullRequest(input.pullRequest);
  const expectedHeadSha = parseExpectedHead(input.expectedHeadSha);

  const request = async <T>(path: string): Promise<T> => {
    if (options.signal?.aborted) throw new Error('Candidate resolution aborted');
    return transport.request<T>('GET', path, undefined, options.token);
  };

  const pullPath = `/repos/${repository.fullName}/pulls/${pullRequest}`;
  const before = inspectPullMetadata(await request<unknown>(pullPath), {
    repository: repository.fullName,
    pullRequest,
    expectedHeadSha,
  });

  if (before.changedFiles > PR_CANDIDATE_LIMITS.maxChangedFiles) {
    fail(
      'FILE_LIST_OVERFLOW',
      `pull request reports ${before.changedFiles} changed files; the intake limit is ${PR_CANDIDATE_LIMITS.maxChangedFiles}`,
      413,
    );
  }
  if (before.head.sha !== expectedHeadSha) {
    fail(
      'EXPECTED_HEAD_MISMATCH',
      `expected head ${expectedHeadSha} does not match the live pull request head ${before.head.sha}`,
      409,
    );
  }

  const compare = readRecord(await request<unknown>(
    `/repos/${repository.fullName}/compare/${before.base.sha}...${before.head.sha}?per_page=1&page=1`,
  ), 'compare response');
  const mergeBaseSha = readMergeBase(compare, before.base.sha);
  if (mergeBaseSha !== before.base.sha) {
    fail('BASE_NOT_ANCESTOR', 'the compare merge-base does not equal the pinned base', 409);
  }
  if (!Array.isArray(compare.files)) malformed('compare files must be an array');
  if (compare.files.length > PR_CANDIDATE_LIMITS.maxChangedFiles) {
    fail('FILE_LIST_OVERFLOW', `compare file count exceeds the intake limit of ${PR_CANDIDATE_LIMITS.maxChangedFiles}`, 413);
  }
  if (compare.files.length !== before.changedFiles) {
    fail('FILE_LIST_TRUNCATED', `pull request reports ${before.changedFiles} changed files but the pinned compare returned ${compare.files.length}`, 422);
  }

  const files: ChangedFileIdentity[] = [];
  const seen = new Set<string>();
  let totalPatchCharacters = 0;
  for (const item of compare.files) {
    const file = readChangedFile(item);
    if (seen.has(file.filename)) malformed(`duplicate changed file ${file.filename}`);
    seen.add(file.filename);
    files.push(file);
    totalPatchCharacters += file.patch.length;
    if (totalPatchCharacters > PR_CANDIDATE_LIMITS.maxTotalPatchCharacters) {
      fail('FILE_LIST_OVERFLOW', 'combined patch data exceeds the intake limit', 413);
    }
  }

  const after = inspectPullMetadata(await request<unknown>(pullPath), {
    repository: repository.fullName,
    pullRequest,
    expectedHeadSha,
  });
  if (identitySnapshot(before) !== identitySnapshot(after)) {
    fail('CANDIDATE_CHANGED', 'pull request metadata changed while its changed files were being read; retry the new head', 409);
  }

  const canonical = [...files].sort((left, right) => (left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0));
  return {
    repository: before.base.repository.fullName,
    pullRequest,
    headRepository: before.head.repository.fullName,
    baseSha: before.base.sha,
    headSha: before.head.sha,
    mergeBaseSha,
    changedFiles: canonical.map((file) => file.filename),
    diffDigest: candidateDiffDigest(canonical),
  };
}
