import type { GitHubTransport } from '../../packages/core/github/index.js';
import type {
  CandidateRevision,
  CheckObservation,
  CheckPlan,
  PrVerdict,
  PrVerificationRequest,
  PrVerificationResult,
  TestDefinition,
} from '../../packages/contracts/src/index.js';

/**
 * Head-bound GitHub Check publication.
 *
 * This module turns one trusted, server-produced PrVerificationResult into
 * two bounded GitHub writes: the VERIFAI runtime check run bound to the exact
 * candidate head SHA, and a single evidence comment on the pull request. It
 * never creates repair pull requests, never approves anything and never
 * merges. Every write goes through the injected GitHubTransport and the
 * injected publication store, so retries and restarted processes reconcile
 * against the recorded external ids instead of duplicating content.
 *
 * Binding rules enforced here, before and after every write:
 * - The candidate must match the request repository, pull request and
 *   expected head SHA exactly.
 * - Live PR metadata must still match the candidate before any write.
 *   A moved head or base makes the proof superseded; it is never published
 *   as a current success.
 * - A `Verified` verdict publishes only when every required planned check has
 *   a matching, executed, passing observation on the candidate head. Anything
 *   less is rejected or published as failure/action_required, never success.
 * - The evidence manifest must be present and cleanup must be complete.
 */

export const PR_CHECKS_LIMITS = Object.freeze({
  /** GitHub check-run output budget this module enforces before sending. */
  maxSummaryCharacters: 4096,
  /** Comment body budget this module enforces before sending. */
  maxCommentCharacters: 4096,
  /** Maximum limitations quoted from the verification result. */
  maxLimitations: 20,
  /** Maximum characters quoted per limitation entry. */
  maxLimitationCharacters: 500,
  /** Maximum observations accepted from one result. */
  maxObservations: 64,
  /** Maximum planned tests accepted per plan list. */
  maxPlannedTests: 64,
  /** Maximum reconciliation scan depth for check runs and comments. */
  maxReconciliationScan: 100,
});

export type PrChecksPublicationErrorCode =
  | 'INVALID_PUBLICATION_INPUT'
  | 'BRANCH_PROTECTION_ASSUMPTION_REQUIRED'
  | 'RESULT_MALFORMED'
  | 'RESULT_REPOSITORY_MISMATCH'
  | 'RESULT_PULL_REQUEST_MISMATCH'
  | 'RESULT_HEAD_MISMATCH'
  | 'EVIDENCE_MANIFEST_MISSING'
  | 'CLEANUP_INCOMPLETE'
  | 'RESULT_SUPERSEDED'
  | 'INVALID_VERDICT'
  | 'UNVERIFIED_SUCCESS_REJECTED'
  | 'PULL_REQUEST_CLOSED'
  | 'PULL_REQUEST_DRAFT'
  | 'FORK_PULL_REQUEST_UNSUPPORTED'
  | 'PRIVATE_REPOSITORY_UNSUPPORTED'
  | 'OUTPUT_OVERFLOW'
  | 'MALFORMED_GITHUB_RESPONSE'
  | 'MISSING_COMMIT_SHA'
  | 'INVALID_COMMIT_SHA';

export class PrChecksPublicationError extends Error {
  readonly code: PrChecksPublicationErrorCode;
  readonly status: number;

  constructor(code: PrChecksPublicationErrorCode, message: string, status: number) {
    super(message);
    this.name = 'PrChecksPublicationError';
    this.code = code;
    this.status = status;
  }
}

export interface PrChecksPublicationRecord {
  key: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  checkRunId: number | null;
  commentId: number | null;
  externalId: string;
  principal: string;
  updatedAt: string;
}

export interface PrChecksPublicationStore {
  save(record: PrChecksPublicationRecord): Promise<void> | void;
  get(key: string): Promise<PrChecksPublicationRecord | undefined> | PrChecksPublicationRecord | undefined;
}

/**
 * In-process store for retries inside one server lifetime. Durable stores
 * (files, databases) implement the same interface for restart reconciliation.
 */
export class MemoryPrChecksPublicationStore implements PrChecksPublicationStore {
  readonly #records = new Map<string, PrChecksPublicationRecord>();

  save(record: PrChecksPublicationRecord): void {
    this.#records.set(record.key, structuredClone(record));
  }

  get(key: string): PrChecksPublicationRecord | undefined {
    const record = this.#records.get(key);
    return record ? structuredClone(record) : undefined;
  }
}

export type PrChecksConclusion = 'success' | 'failure' | 'action_required' | 'neutral';

/**
 * Fixed verdict-to-conclusion mapping. Incomplete and Unknown work require a
 * human or a re-run, so they publish action_required and never success.
 */
export function prChecksConclusion(verdict: PrVerdict): Exclude<PrChecksConclusion, 'neutral'> {
  switch (verdict) {
    case 'Verified':
      return 'success';
    case 'Failed':
      return 'failure';
    default:
      return 'action_required';
  }
}

export interface PrChecksPublishConfig {
  /** Trusted server token. The caller reads it from environment configuration. */
  token: string;
  /** Trusted principal identity recorded in the publication store only. */
  principal: string;
  /**
   * Publication must be invoked with results produced by the server-side
   * runtime verifier. This literal rejects calling the module directly with
   * an authoritative result that arrived from a client.
   */
  resultSource: 'server-verifier';
  /**
   * This module does not read repository branch protection settings. The
   * caller must explicitly confirm that protection enforces the VERIFAI
   * check (or consciously accept the assumption) before any write happens.
   */
  assumeStrictBranchProtection: boolean;
}

export interface PrChecksPublishOptions {
  signal?: AbortSignal;
}

export type PrChecksSupersedeReason = 'HEAD_MOVED' | 'BASE_MOVED' | 'POST_WRITE_VERIFY_FAILED';

export interface PrChecksPublicationResult {
  outcome: 'published' | 'superseded';
  verdict: PrVerdict;
  conclusion: Exclude<PrChecksConclusion, 'neutral'>;
  headSha: string;
  checkRunId: number | null;
  commentId: number | null;
  externalId: string;
  repository: string;
  pullRequest: number;
  reason?: PrChecksSupersedeReason;
  details?: string;
}

interface LivePullSnapshot {
  state: string;
  draft: boolean;
  merged: boolean;
  baseSha: string;
  headSha: string;
  baseRepositoryKey: string;
  headRepositoryKey: string;
}

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9_.-]{1,100}$/;
const shaPattern = /^[0-9a-f]{40}$/i;
const digestPattern = /^[0-9a-f]{64}$/i;
const principalPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const checkName = 'VERIFAI runtime verification';

function fail(code: PrChecksPublicationErrorCode, message: string, status: number): never {
  throw new PrChecksPublicationError(code, message, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('MALFORMED_GITHUB_RESPONSE', `${label} must be an object`, 502);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('MALFORMED_GITHUB_RESPONSE', `${label} must be a non-empty string`, 502);
  return value;
}

function readSha(value: unknown, label: string): string {
  if (value === undefined || value === null || value === '') fail('MISSING_COMMIT_SHA', `${label} is missing`, 502);
  if (typeof value !== 'string' || !shaPattern.test(value)) fail('INVALID_COMMIT_SHA', `${label} is not a 40-character hexadecimal commit SHA`, 502);
  return value.toLowerCase();
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail('RESULT_MALFORMED', `${label} must be a boolean`, 400);
  return value;
}

/** Strip control characters, backticks and markup triggers; keeps plain text only. */
function sanitizeUntrustedText(value: unknown, maxLength: number): { text: string; truncated: boolean } {
  if (typeof value !== 'string') return { text: '', truncated: false };
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>[\]]/g, "'");
  if (cleaned.length <= maxLength) return { text: cleaned, truncated: false };
  return { text: `${cleaned.slice(0, maxLength)}[trimmed]`, truncated: true };
}

function validateRequestShape(value: unknown): void {
  const request = isRecord(value) ? value : fail('INVALID_PUBLICATION_INPUT', 'publication request must be an object', 400);
  const parts = typeof request.repository === 'string' ? request.repository.split('/') : [];
  const validRepository =
    parts.length === 2 &&
    ownerPattern.test(parts[0]) &&
    repositoryNamePattern.test(parts[1]) &&
    parts[1] !== '.' &&
    parts[1] !== '..';
  if (!validRepository) fail('INVALID_PUBLICATION_INPUT', 'repository must be owner/name', 400);
  if (typeof request.pullRequest !== 'number' || !Number.isSafeInteger(request.pullRequest) || request.pullRequest <= 0) {
    fail('INVALID_PUBLICATION_INPUT', 'pullRequest must be a positive integer', 400);
  }
  if (typeof request.expectedHeadSha !== 'string' || !shaPattern.test(request.expectedHeadSha)) {
    fail('INVALID_PUBLICATION_INPUT', 'expectedHeadSha must be a 40-character hexadecimal commit SHA', 400);
  }
}

function validateConfig(config: unknown): void {
  const value = isRecord(config) ? config : fail('INVALID_PUBLICATION_INPUT', 'publication config must be an object', 400);
  if (typeof value.token !== 'string' || value.token.length === 0 || value.token.length > 255) {
    fail('INVALID_PUBLICATION_INPUT', 'a non-empty trusted token is required', 400);
  }
  if (typeof value.principal !== 'string' || !principalPattern.test(value.principal)) {
    fail('INVALID_PUBLICATION_INPUT', 'a bounded trusted principal is required', 400);
  }
  if (value.resultSource !== 'server-verifier') {
    fail('INVALID_PUBLICATION_INPUT', 'results may only come from the server-side runtime verifier', 400);
  }
  if (typeof value.assumeStrictBranchProtection !== 'boolean') {
    fail('INVALID_PUBLICATION_INPUT', 'assumeStrictBranchProtection must be a boolean', 400);
  }
  if (!value.assumeStrictBranchProtection) {
    fail(
      'BRANCH_PROTECTION_ASSUMPTION_REQUIRED',
      'publication does not verify branch protection; confirm the strict protection assumption explicitly',
      409,
    );
  }
}

function validateTestDefinition(value: unknown, label: string): void {
  const item = isRecord(value) ? value : fail('RESULT_MALFORMED', `${label} must be an object`, 400);
  if (typeof item.checkId !== 'string' || item.checkId.length === 0 || item.checkId.length > 200) {
    fail('RESULT_MALFORMED', `${label}.checkId is out of bounds`, 400);
  }
  if (typeof item.artifactRef !== 'string' || item.artifactRef.length === 0 || item.artifactRef.length > 512) {
    fail('RESULT_MALFORMED', `${label}.artifactRef is out of bounds`, 400);
  }
  if (typeof item.contentSha256 !== 'string' || !digestPattern.test(item.contentSha256)) {
    fail('RESULT_MALFORMED', `${label}.contentSha256 must be a 64-character digest`, 400);
  }
  if (item.origin !== 'approved' && item.origin !== 'generated') {
    fail('RESULT_MALFORMED', `${label}.origin must be approved or generated`, 400);
  }
}

function validatePlan(plan: unknown): CheckPlan {
  const value = isRecord(plan) ? plan : fail('RESULT_MALFORMED', 'plan must be an object', 400);
  if (typeof value.policyVersion !== 'string' || value.policyVersion.length === 0 || value.policyVersion.length > 200) {
    fail('RESULT_MALFORMED', 'plan.policyVersion is out of bounds', 400);
  }
  if (typeof value.profileId !== 'string' || value.profileId.length === 0 || value.profileId.length > 200) {
    fail('RESULT_MALFORMED', 'plan.profileId is out of bounds', 400);
  }
  for (const key of ['profileDigest', 'planDigest'] as const) {
    if (typeof value[key] !== 'string' || !digestPattern.test(value[key] as string)) {
      fail('RESULT_MALFORMED', `plan.${key} must be a 64-character digest`, 400);
    }
  }
  for (const key of ['requiredChecks', 'generatedTests'] as const) {
    const list = value[key];
    if (!Array.isArray(list)) fail('RESULT_MALFORMED', `plan.${key} must be an array`, 400);
    if (list.length > PR_CHECKS_LIMITS.maxPlannedTests) {
      fail('RESULT_MALFORMED', `plan.${key} exceeds the bounded plan size`, 400);
    }
    list.forEach((item, index) => validateTestDefinition(item, `plan.${key}[${index}]`));
  }
  return value as unknown as CheckPlan;
}

/** Structural validation of one observation. Semantic checks happen per verdict. */
function validateObservation(value: unknown, index: number): void {
  const item = isRecord(value) ? value : fail('RESULT_MALFORMED', `observations[${index}] must be an object`, 400);
  if (typeof item.checkId !== 'string' || item.checkId.length === 0 || item.checkId.length > 200) {
    fail('RESULT_MALFORMED', `observations[${index}].checkId is out of bounds`, 400);
  }
  if (item.revision !== 'base' && item.revision !== 'head') {
    fail('RESULT_MALFORMED', `observations[${index}].revision must be base or head`, 400);
  }
  if (typeof item.commitSha !== 'string' || !shaPattern.test(item.commitSha)) {
    fail('RESULT_MALFORMED', `observations[${index}].commitSha must be a 40-character commit SHA`, 400);
  }
  if (item.status !== 'Verified' && item.status !== 'Failed' && item.status !== 'Incomplete' && item.status !== 'Unknown') {
    fail('RESULT_MALFORMED', `observations[${index}].status must be a PrVerdict`, 400);
  }
  if (typeof item.executed !== 'boolean') fail('RESULT_MALFORMED', `observations[${index}].executed must be a boolean`, 400);
  const exitCode = item.exitCode;
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) {
    fail('RESULT_MALFORMED', `observations[${index}].exitCode must be null or an integer`, 400);
  }
  if (!Array.isArray(item.artifactRefs) || item.artifactRefs.length > 20) {
    fail('RESULT_MALFORMED', `observations[${index}].artifactRefs must be a bounded array`, 400);
  }
  item.artifactRefs.forEach((ref, position) => {
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512) {
      fail('RESULT_MALFORMED', `observations[${index}].artifactRefs[${position}] is out of bounds`, 400);
    }
  });
  if (typeof item.commandDigest !== 'string' || !digestPattern.test(item.commandDigest)) {
    fail('RESULT_MALFORMED', `observations[${index}].commandDigest must be a 64-character digest`, 400);
  }
  if (typeof item.testContentSha256 !== 'string' || !digestPattern.test(item.testContentSha256)) {
    fail('RESULT_MALFORMED', `observations[${index}].testContentSha256 must be a 64-character digest`, 400);
  }
}

/**
 * A Verified verdict is publishable only when it is fully justified: every
 * required planned check has a matching observation that executed on the
 * candidate head, produced the planned test content and passed. Anything
 * else fails the publication; callers may republish as Failed or
 * action_required instead.
 */
function assertVerifiedSuccessIsJustified(
  result: PrVerificationResult,
  candidate: CandidateRevision,
): void {
  const headSha = candidate.headSha.toLowerCase();
  const plan = result.plan;
  const required = plan.requiredChecks;
  if (required.length === 0) fail('UNVERIFIED_SUCCESS_REJECTED', 'a Verified verdict needs at least one required check', 422);
  for (const definition of required) {
    const matching = result.observations.filter(
      (item) =>
        item.checkId === definition.checkId &&
        item.testContentSha256.toLowerCase() === definition.contentSha256.toLowerCase() &&
        item.revision === 'head' &&
        item.commitSha.toLowerCase() === headSha,
    );
    const justified = matching.some(
      (item) => item.status === 'Verified' && item.executed === true && item.exitCode === 0,
    );
    if (!justified) {
      fail('UNVERIFIED_SUCCESS_REJECTED', `required check ${definition.checkId} has no executed passing observation on the candidate head`, 422);
    }
  }
  const contradictions = result.observations.filter(
    (item) => item.revision === 'head' && item.commitSha.toLowerCase() === headSha && (item.status === 'Failed' || item.status === 'Incomplete' || item.status === 'Unknown'),
  );
  if (contradictions.length > 0) {
    fail('UNVERIFIED_SUCCESS_REJECTED', 'a Verified verdict contradicts a failed or incomplete observation on the candidate head', 422);
  }
}

function assertResultMatchesRequest(
  candidate: CandidateRevision,
  request: PrVerificationRequest,
): void {
  if (candidate.repository.toLowerCase() !== request.repository.toLowerCase()) {
    fail('RESULT_REPOSITORY_MISMATCH', 'the result candidate is bound to a different repository', 409);
  }
  if (candidate.pullRequest !== request.pullRequest) {
    fail('RESULT_PULL_REQUEST_MISMATCH', 'the result candidate is bound to a different pull request', 409);
  }
  if (candidate.headSha.toLowerCase() !== request.expectedHeadSha.toLowerCase()) {
    fail('RESULT_HEAD_MISMATCH', 'the result candidate head does not match the expected head SHA', 409);
  }
  if (typeof candidate.headRepository !== 'string') {
    fail('RESULT_MALFORMED', 'candidate.headRepository must be a string', 400);
  }
  if (candidate.headRepository.toLowerCase() !== request.repository.toLowerCase()) {
    fail('FORK_PULL_REQUEST_UNSUPPORTED', 'fork candidates cannot publish checks', 403);
  }
}

function readLiveSnapshot(value: unknown, repository: string): LivePullSnapshot {
  const pull = readRecord(value, 'pull request');
  const repositoryKey = repository.toLowerCase();
  const fullNumber = pull.number;
  if (typeof fullNumber !== 'number') fail('MALFORMED_GITHUB_RESPONSE', 'pull request number must be a number', 502);
  const base = readRecord(pull.base, 'pull request base');
  const head = readRecord(pull.head, 'pull request head');
  const baseRepo = readRecord(base.repo, 'pull request base repository');
  const headRepo = readRecord(head.repo, 'pull request head repository');
  if (baseRepo.private === true || headRepo.private === true) {
    fail('PRIVATE_REPOSITORY_UNSUPPORTED', 'private repositories cannot publish checks', 403);
  }
  const baseKey = readString(baseRepo.full_name, 'pull request base repository').toLowerCase();
  const headKey = readString(headRepo.full_name, 'pull request head repository').toLowerCase();
  if (headKey !== repositoryKey) {
    fail('FORK_PULL_REQUEST_UNSUPPORTED', 'the pull request head moved to a fork', 403);
  }
  return {
    state: readString(pull.state, 'pull request state'),
    draft: readBoolean(pull.draft, 'pull request draft'),
    merged: readBoolean(pull.merged, 'pull request merged'),
    baseSha: readSha(base.sha, 'pull request base SHA'),
    headSha: readSha(head.sha, 'pull request head SHA'),
    baseRepositoryKey: baseKey,
    headRepositoryKey: headKey,
  };
}

function assertLivePullIsPublishable(live: LivePullSnapshot): void {
  if (live.state === 'closed' || live.merged) fail('PULL_REQUEST_CLOSED', 'closed or merged pull requests cannot publish checks', 409);
  if (live.state !== 'open') fail('MALFORMED_GITHUB_RESPONSE', 'pull request state must be open or closed', 502);
  if (live.draft) fail('PULL_REQUEST_DRAFT', 'draft pull requests cannot publish checks', 409);
}

export function prChecksPublicationKey(repository: string, pullRequest: number, headSha: string): string {
  return `${repository.toLowerCase()}#${pullRequest}@${headSha.toLowerCase()}`;
}

function externalIdFor(repository: string, pullRequest: number, headSha: string): string {
  return `verifai-runtime:${repository.toLowerCase()}#${pullRequest}@${headSha.toLowerCase()}`;
}

function commentMarker(repository: string, pullRequest: number, headSha: string): string {
  return `<!-- verifai-runtime-comment ${repository.toLowerCase()} #${pullRequest} @${headSha.toLowerCase()} -->`;
}

interface CheckRunSummary {
  verdictLine: string;
  manifestLine: string;
  cleanupLine: string;
  limitationText: string;
  truncated: boolean;
}

function buildSummary(result: PrVerificationResult): CheckRunSummary {
  const verdictFilters: Record<PrVerdict, string> = {
    Verified: 'all required checks executed and passed on this head',
    Failed: 'a required check failed on this head',
    Incomplete: 'verification did not complete; missing capability or interrupted run',
    Unknown: 'verification could not be determined',
  };
  const limitations: string[] = [];
  let truncated = false;
  for (const raw of result.limitations.slice(0, PR_CHECKS_LIMITS.maxLimitations)) {
    const { text, truncated: entryTruncated } = sanitizeUntrustedText(raw, PR_CHECKS_LIMITS.maxLimitationCharacters);
    if (entryTruncated) truncated = true;
    if (text.trim().length > 0) limitations.push(text);
  }
  if (result.limitations.length > PR_CHECKS_LIMITS.maxLimitations) truncated = true;
  const limitationText = limitations.length > 0 ? limitations.join('\n') : 'none reported';
  return {
    verdictLine: verdictFilters[result.verdict],
    manifestLine: result.evidenceManifestSha256,
    cleanupLine: result.cleanupComplete ? 'complete' : 'INCOMPLETE',
    limitationText,
    truncated,
  };
}

function truncateNote(truncated: boolean): string {
  return truncated ? 'Some untrusted text was truncated to the publication bounds.' : '';
}

function renderLimitations(limitationText: string): string {
  return `~~~\n${limitationText}\n~~~`;
}

function buildCheckSummary(result: PrVerificationResult, repository: string, pullRequest: number, headSha: string): string {
  const built = buildSummary(result);
  const generatedCount = result.plan.generatedTests.length;
  const lines = [
    'VERIFAI runtime verification',
    `Verdict: ${result.verdict}. ${built.verdictLine}.`,
    `Repository: ${repository.toLowerCase()} pull request #${pullRequest} at head ${headSha}.`,
    `Evidence manifest SHA-256: ${built.manifestLine}.`,
    `Candidate cleanup: ${built.cleanupLine}.`,
    `Model-generated tests in the plan: ${generatedCount}. They remain unconfirmed hypotheses and never produce a Verified verdict by themselves.`,
    'Verifier limitations:',
    renderLimitations(built.limitationText),
    truncateNote(built.truncated),
    'Published by the VERIFAI verification service after live head/base re-checks. This check never approves a human and never merges.',
  ].filter((line) => line.length > 0);
  const summary = lines.join('\n');
  if (summary.length > PR_CHECKS_LIMITS.maxSummaryCharacters) {
    fail('OUTPUT_OVERFLOW', 'check summary exceeds its bound', 500);
  }
  return summary;
}

function buildCommentBody(
  result: PrVerificationResult,
  repository: string,
  pullRequest: number,
  headSha: string,
  supersedeNote: string | null,
): string {
  const built = buildSummary(result);
  const lines = [
    commentMarker(repository, pullRequest, headSha),
    supersedeNote ? supersedeNote : '## VERIFAI runtime verification evidence (bounded)',
    `Verdict: ${result.verdict}. ${built.verdictLine}.`,
    `Head: ${headSha}. Evidence manifest SHA-256: ${built.manifestLine}. Cleanup: ${built.cleanupLine}.`,
    'Verifier limitations (plain text, links not rendered):',
    renderLimitations(built.limitationText),
    truncateNote(built.truncated),
    'Model hypotheses stay Unconfirmed; they do not read as verification evidence.',
    'This comment is written by the VERIFAI verification service. It never requests approvals and never merges.',
  ].filter((line) => line.length > 0);
  const body = lines.join('\n');
  if (body.length > PR_CHECKS_LIMITS.maxCommentCharacters) {
    fail('OUTPUT_OVERFLOW', 'comment exceeds its bound', 500);
  }
  return body;
}

interface CheckRunResponseBody {
  id?: unknown;
}

function readCheckRunId(value: unknown): number {
  const body = readRecord(value, 'check run response');
  const id = body.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    fail('MALFORMED_GITHUB_RESPONSE', 'check run response lacks a usable id', 502);
  }
  return id;
}

interface CommentResponseBody {
  id?: unknown;
}

function readCommentId(value: unknown): number {
  const body = readRecord(value, 'comment response');
  const id = body.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    fail('MALFORMED_GITHUB_RESPONSE', 'comment response lacks a usable id', 502);
  }
  return id;
}

async function githubRequest<T>(
  transport: GitHubTransport,
  method: string,
  path: string,
  body: unknown,
  token: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw new Error('Publication aborted');
  return transport.request<T>(method, path, body, token);
}

async function findExistingCheckRunId(
  transport: GitHubTransport,
  repository: string,
  headSha: string,
  externalId: string,
  token: string,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const list = await githubRequest<unknown>(
    transport,
    'GET',
    `/repos/${repository.toLowerCase()}/commits/${headSha}/check-runs?per_page=${PR_CHECKS_LIMITS.maxReconciliationScan}`,
    undefined,
    token,
    signal,
  );
  const body = readRecord(list, 'check-run list');
  const runs = body.check_runs;
  if (!Array.isArray(runs)) fail('MALFORMED_GITHUB_RESPONSE', 'check-run list must contain check_runs', 502);
  for (const item of runs.slice(0, PR_CHECKS_LIMITS.maxReconciliationScan)) {
    const run = isRecord(item) ? item : fail('MALFORMED_GITHUB_RESPONSE', 'check-run entry must be an object', 502);
    if (run.external_id === externalId) {
      const id = run.id;
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
    }
  }
  return null;
}

async function findExistingCommentId(
  transport: GitHubTransport,
  repository: string,
  pullRequest: number,
  headSha: string,
  token: string,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const list = await githubRequest<unknown>(
    transport,
    'GET',
    `/repos/${repository.toLowerCase()}/issues/${pullRequest}/comments?per_page=${PR_CHECKS_LIMITS.maxReconciliationScan}`,
    undefined,
    token,
    signal,
  );
  if (!Array.isArray(list)) fail('MALFORMED_GITHUB_RESPONSE', 'comment list must be an array', 502);
  const marker = commentMarker(repository, pullRequest, headSha);
  for (const item of list.slice(0, PR_CHECKS_LIMITS.maxReconciliationScan)) {
    const comment = isRecord(item) ? item : fail('MALFORMED_GITHUB_RESPONSE', 'comment entry must be an object', 502);
    const body = comment.body;
    if (typeof body === 'string' && body.startsWith(marker)) {
      const id = comment.id;
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
    }
  }
  return null;
}

/**
 * Publish one head-bound runtime check and one bounded evidence comment.
 *
 * Argument order: result, request, transport, config, store. The module is
 * server-only; the caller must read the token from environment configuration
 * and must not pass a result that originated from an unauthenticated client.
 */
export async function publishPrRuntimeCheck(
  result: unknown,
  request: unknown,
  transport: GitHubTransport,
  config: unknown,
  store: PrChecksPublicationStore,
  options: PrChecksPublishOptions = {},
): Promise<PrChecksPublicationResult> {
  validateConfig(config);
  validateRequestShape(request);
  const publishConfig = config as Required<PrChecksPublishConfig>;
  const publishRequest = request as PrVerificationRequest;
  const signal = options.signal;

  const candidateResult = validateResultPayload(result);
  const candidate = candidateResult.candidate;
  assertResultMatchesRequest(candidate, publishRequest);

  if (!digestPattern.test(candidateResult.evidenceManifestSha256)) {
    fail('EVIDENCE_MANIFEST_MISSING', 'the result has no valid evidence manifest digest', 422);
  }
  if (!candidateResult.cleanupComplete) {
    fail('CLEANUP_INCOMPLETE', 'candidate cleanup is not complete; nothing may publish', 422);
  }
  if (candidateResult.superseded) {
    fail('RESULT_SUPERSEDED', 'the result is already marked superseded', 409);
  }
  if (candidateResult.verdict === 'Verified') {
    assertVerifiedSuccessIsJustified(candidateResult, candidate);
  }

  const repository = publishRequest.repository.toLowerCase();
  const headSha = publishRequest.expectedHeadSha.toLowerCase();
  const conclusion = prChecksConclusion(candidateResult.verdict);
  const externalId = externalIdFor(repository, publishRequest.pullRequest, headSha);
  const key = prChecksPublicationKey(repository, publishRequest.pullRequest, headSha);

  const liveBefore = readLiveSnapshot(
    await githubRequest<unknown>(transport, 'GET', `/repos/${repository}/pulls/${publishRequest.pullRequest}`, undefined, publishConfig.token, signal),
    repository,
  );
  assertLivePullIsPublishable(liveBefore);
  const supersedeBefore = detectSupersession(liveBefore, publishRequest, candidate);
  if (supersedeBefore) {
    const record = await store.get(key);
    return {
      outcome: 'superseded',
      verdict: candidateResult.verdict,
      conclusion,
      headSha,
      checkRunId: record?.checkRunId ?? null,
      commentId: record?.commentId ?? null,
      externalId,
      repository,
      pullRequest: publishRequest.pullRequest,
      reason: supersedeBefore.reason,
      details: supersedeBefore.details,
    };
  }

  const summary = buildCheckSummary(candidateResult, repository, publishRequest.pullRequest, headSha);

  const recorded = await store.get(key);
  let checkRunId: number | null = null;
  if (recorded?.checkRunId) {
    checkRunId = recorded.checkRunId;
  } else {
    checkRunId = await findExistingCheckRunId(transport, repository, headSha, externalId, publishConfig.token, signal);
  }

  if (checkRunId !== null) {
    const updated = await githubRequest<unknown>(
      transport,
      'PATCH',
      `/repos/${repository}/check-runs/${checkRunId}`,
      {
        name: checkName,
        status: 'completed',
        conclusion,
        external_id: externalId,
        output: { title: checkName, summary },
      },
      publishConfig.token,
      signal,
    );
    readCheckRunId(updated);
  } else {
    const created = await githubRequest<unknown>(
      transport,
      'POST',
      `/repos/${repository}/check-runs`,
      {
        name: checkName,
        head_sha: headSha,
        status: 'completed',
        conclusion,
        external_id: externalId,
        output: { title: checkName, summary },
      },
      publishConfig.token,
      signal,
    );
    checkRunId = readCheckRunId(created);
  }

  await persistRecord(store, {
    key,
    repository,
    pullRequest: publishRequest.pullRequest,
    headSha,
    checkRunId,
    commentId: recorded?.commentId ?? null,
    externalId,
    principal: publishConfig.principal,
  });

  let commentId: number | null = recorded?.commentId ?? null;
  if (commentId === null) {
    commentId = await findExistingCommentId(transport, repository, publishRequest.pullRequest, headSha, publishConfig.token, signal);
  }
  const commentBody = buildCommentBody(candidateResult, repository, publishRequest.pullRequest, headSha, null);
  if (commentId !== null) {
    const updated = await githubRequest<unknown>(
      transport,
      'PATCH',
      `/repos/${repository}/issues/comments/${commentId}`,
      { body: commentBody },
      publishConfig.token,
      signal,
    );
    commentId = readCommentId(updated);
  } else {
    const created = await githubRequest<unknown>(
      transport,
      'POST',
      `/repos/${repository}/issues/${publishRequest.pullRequest}/comments`,
      { body: commentBody },
      publishConfig.token,
      signal,
    );
    commentId = readCommentId(created);
  }

  await persistRecord(store, {
    key,
    repository,
    pullRequest: publishRequest.pullRequest,
    headSha,
    checkRunId,
    commentId,
    externalId,
    principal: publishConfig.principal,
  });

  const liveAfterList = await readLiveAfterWrite(
    transport,
    repository,
    publishRequest.pullRequest,
    publishConfig.token,
    signal,
  );
  if (liveAfterList.status === 'error') {
    return {
      outcome: 'published',
      verdict: candidateResult.verdict,
      conclusion,
      headSha,
      checkRunId,
      commentId,
      externalId,
      repository,
      pullRequest: publishRequest.pullRequest,
      reason: 'POST_WRITE_VERIFY_FAILED',
      details: 'the writes committed, but the final head/base currency check could not be read; a retry is safe and idempotent',
    };
  }
  const supersedeAfter = detectSupersession(liveAfterList.snapshot!, publishRequest, candidate);
  if (supersedeAfter) {
    if (conclusion === 'success') {
      await githubRequest<unknown>(
        transport,
        'PATCH',
        `/repos/${repository}/check-runs/${checkRunId}`,
        {
          name: checkName,
          status: 'completed',
          conclusion: 'neutral',
          external_id: externalId,
          output: { title: checkName, summary: supersededSummary(headSha, supersedeAfter.reason) },
        },
        publishConfig.token,
        signal,
      );
      const supersededBody = buildCommentBody(candidateResult, repository, publishRequest.pullRequest, headSha, 'SUPERSEDED: the pull request advanced after publication; this proof is no longer current.');
      await githubRequest<unknown>(
        transport,
        'PATCH',
        `/repos/${repository}/issues/comments/${commentId}`,
        { body: supersededBody },
        publishConfig.token,
        signal,
      );
      await persistRecord(store, {
        key,
        repository,
        pullRequest: publishRequest.pullRequest,
        headSha,
        checkRunId,
        commentId,
        externalId,
        principal: publishConfig.principal,
      });
    }
    return {
      outcome: 'superseded',
      verdict: candidateResult.verdict,
      conclusion,
      headSha,
      checkRunId,
      commentId,
      externalId,
      repository,
      pullRequest: publishRequest.pullRequest,
      reason: supersedeAfter.reason,
      details: supersedeAfter.details,
    };
  }

  return {
    outcome: 'published',
    verdict: candidateResult.verdict,
    conclusion,
    headSha,
    checkRunId,
    commentId,
    externalId,
    repository,
    pullRequest: publishRequest.pullRequest,
  };
}

async function readLiveAfterWrite(
  transport: GitHubTransport,
  repository: string,
  pullRequest: number,
  token: string,
  signal: AbortSignal | undefined,
): Promise<{ status: 'ok'; snapshot: LivePullSnapshot } | { status: 'error' }> {
  try {
    const value = await githubRequest<unknown>(transport, 'GET', `/repos/${repository}/pulls/${pullRequest}`, undefined, token, signal);
    return { status: 'ok', snapshot: readLiveSnapshot(value, repository) };
  } catch {
    return { status: 'error' };
  }
}

function detectSupersession(
  live: LivePullSnapshot,
  publishRequest: PrVerificationRequest,
  candidate: CandidateRevision,
): { reason: PrChecksSupersedeReason; details: string } | null {
  if (live.headSha !== publishRequest.expectedHeadSha.toLowerCase()) {
    return { reason: 'HEAD_MOVED', details: `live head ${live.headSha} no longer matches the expected head` };
  }
  if (live.baseSha !== candidate.baseSha.toLowerCase()) {
    return { reason: 'BASE_MOVED', details: `live base ${live.baseSha} no longer matches the candidate base ${candidate.baseSha}` };
  }
  return null;
}

function supersededSummary(headSha: string, reason: PrChecksSupersedeReason): string {
  return [
    'VERIFAI runtime verification (superseded)',
    `The check published at head ${headSha} was superseded: ${reason === 'HEAD_MOVED' ? 'the pull request head advanced after publication' : 'the pull request base changed after publication'}.`,
    'No proof at this head is labelled current. Re-run verification for the new head.',
  ].join('\n');
}

async function persistRecord(
  store: PrChecksPublicationStore,
  record: Omit<PrChecksPublicationRecord, 'updatedAt'>,
): Promise<void> {
  await store.save({ ...record, updatedAt: new Date().toISOString() });
}

/**
 * Structural validation of the result payload before any consistency check.
 */
function validateResultPayload(value: unknown): PrVerificationResult {
  const result = isRecord(value) ? value : fail('RESULT_MALFORMED', 'result must be an object', 400);
  if (!isRecord(result.candidate)) fail('RESULT_MALFORMED', 'result.candidate must be an object', 400);
  const candidateRecord = result.candidate as Record<string, unknown>;
  const candidate: CandidateRevision = {
    repository: (typeof candidateRecord.repository === 'string' && candidateRecord.repository.length > 0 && candidateRecord.repository.length <= 512) ? candidateRecord.repository : fail('RESULT_MALFORMED', 'candidate.repository is out of bounds', 400),
    pullRequest: (typeof candidateRecord.pullRequest === 'number' && Number.isSafeInteger(candidateRecord.pullRequest) && candidateRecord.pullRequest > 0) ? candidateRecord.pullRequest : fail('RESULT_MALFORMED', 'candidate.pullRequest must be a positive integer', 400),
    headRepository: (typeof candidateRecord.headRepository === 'string' && candidateRecord.headRepository.length <= 512) ? candidateRecord.headRepository : fail('RESULT_MALFORMED', 'candidate.headRepository is out of bounds', 400),
    baseSha: readSha(candidateRecord.baseSha, 'candidate.baseSha'),
    headSha: readSha(candidateRecord.headSha, 'candidate.headSha'),
    mergeBaseSha: readSha(candidateRecord.mergeBaseSha, 'candidate.mergeBaseSha'),
    changedFiles: [],
    diffDigest: '',
  };
  if (!Array.isArray(candidateRecord.changedFiles) || candidateRecord.changedFiles.length > 4000) {
    fail('RESULT_MALFORMED', 'candidate.changedFiles must be a bounded array', 400);
  }
  const changedFiles: string[] = [];
  candidateRecord.changedFiles.forEach((file, index) => {
    if (typeof file !== 'string' || file.length === 0 || file.length > 4096) {
      fail('RESULT_MALFORMED', `candidate.changedFiles[${index}] is out of bounds`, 400);
    }
    changedFiles.push(file);
  });
  candidate.changedFiles = changedFiles;
  if (typeof candidateRecord.diffDigest !== 'string' || !digestPattern.test(candidateRecord.diffDigest)) {
    fail('RESULT_MALFORMED', 'candidate.diffDigest must be a 64-character digest', 400);
  }
  candidate.diffDigest = candidateRecord.diffDigest;

  const verdict = result.verdict;
  if (verdict !== 'Verified' && verdict !== 'Failed' && verdict !== 'Incomplete' && verdict !== 'Unknown') {
    fail('INVALID_VERDICT', 'result.verdict must be a PrVerdict', 400);
  }
  if (!Array.isArray(result.observations)) fail('RESULT_MALFORMED', 'result.observations must be an array', 400);
  if (result.observations.length > PR_CHECKS_LIMITS.maxObservations) {
    fail('RESULT_MALFORMED', 'result.observations exceed the bounded size', 400);
  }
  result.observations.forEach((observation, index) => validateObservation(observation, index));
  if (!Array.isArray(result.limitations)) fail('RESULT_MALFORMED', 'result.limitations must be an array', 400);
  if (result.limitations.length > 100) fail('RESULT_MALFORMED', 'result.limitations exceed the bounded size', 400);
  result.limitations.forEach((item, index) => {
    if (item !== undefined && typeof item !== 'string') fail('RESULT_MALFORMED', `result.limitations[${index}] must be a string`, 400);
  });
  const cleanupComplete = readBoolean(result.cleanupComplete, 'result.cleanupComplete');
  const superseded = result.superseded === undefined ? false : readBoolean(result.superseded, 'result.superseded');
  if (typeof result.evidenceManifestSha256 !== 'string') {
    fail('RESULT_MALFORMED', 'result.evidenceManifestSha256 must be a string', 400);
  }
  const plan = validatePlan(result.plan);
  return {
    candidate,
    plan,
    observations: result.observations as unknown as CheckObservation[],
    verdict,
    limitations: result.limitations as string[],
    evidenceManifestSha256: result.evidenceManifestSha256 as string,
    cleanupComplete,
    superseded,
  };
}
