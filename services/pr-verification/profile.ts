import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Trusted PR check profile.
 *
 * A profile is the approved policy for one repository. Repository, policy
 * commit, runtime image and dependency digests are fixed data, not request
 * fields. Required checks and their scripts are immutable once defined, so a
 * pull request diff cannot remove, reorder or weaken them.
 *
 * This module hashes and validates data only. It does not run checks, call a
 * model or reach AWS.
 */
export const PROFILE_LIMITS = Object.freeze({
  maxRequiredChecks: 8,
  maxDependencyDigests: 32,
  maxCommandCharacters: 300,
  maxScriptBytes: 65_536,
  maxTimeoutMs: 600_000,
  defaultProfileFileBytes: 1_048_576,
  maxProfileFileBytes: 4_194_304,
});

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

export interface ProfileDependency {
  readonly name: string;
  readonly sha256: string;
}

export interface ApprovedCheck {
  readonly checkId: string;
  readonly command: string;
  /** Bounded test wrapper bytes persisted by the planner before execution. */
  readonly script: string;
  readonly timeoutMs: number;
}

export interface PrCheckProfileInput {
  readonly profileId: string;
  readonly policyVersion: string;
  readonly repository: string;
  readonly policyCommitSha: string;
  readonly imageDigest: string;
  readonly dependencyDigests: readonly ProfileDependency[];
  readonly requiredChecks: readonly ApprovedCheck[];
  readonly regressionCheck: ApprovedCheck;
}

export interface PrCheckProfile extends PrCheckProfileInput {
  readonly profileDigest: string;
}

const repositoryPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const imagePattern = /^sha256:[0-9a-f]{64}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const checkIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const dependencyNamePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable JSON for digests: object keys sorted, arrays keep their order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) result[key] = canonicalize(record[key]);
    return result;
  }
  return value;
}

function fail(message: string): never {
  throw new ProfileValidationError(message);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  if (value.length > maximum) fail(`${label} exceeds ${maximum} characters`);
  if (value.includes('\0')) fail(`${label} must not contain NUL`);
  return value;
}

function validateCheck(value: unknown, label: string): ApprovedCheck {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const check = value as Record<string, unknown>;
  const checkId = text(check.checkId, `${label}.checkId`, 64);
  if (!checkIdPattern.test(checkId)) fail(`${label}.checkId must be a lower-case identifier`);
  const command = text(check.command, `${label}.command`, PROFILE_LIMITS.maxCommandCharacters);
  if (/[\r\n]/.test(command)) fail(`${label}.command must be a single line`);
  const script = text(check.script, `${label}.script`, PROFILE_LIMITS.maxScriptBytes);
  if (Buffer.byteLength(script, 'utf8') > PROFILE_LIMITS.maxScriptBytes) {
    fail(`${label}.script exceeds ${PROFILE_LIMITS.maxScriptBytes} bytes`);
  }
  const timeoutMs = check.timeoutMs;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > PROFILE_LIMITS.maxTimeoutMs
  ) {
    fail(`${label}.timeoutMs must be an integer between 1 and ${PROFILE_LIMITS.maxTimeoutMs}`);
  }
  return Object.freeze({ checkId, command, script, timeoutMs });
}

function validateDependencies(value: unknown): readonly ProfileDependency[] {
  if (!Array.isArray(value) || value.length === 0) fail('dependencyDigests must be a non-empty array');
  if (value.length > PROFILE_LIMITS.maxDependencyDigests) {
    fail(`dependencyDigests must contain at most ${PROFILE_LIMITS.maxDependencyDigests} entries`);
  }
  const seen = new Set<string>();
  const dependencies = value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail(`dependencyDigests[${index}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const name = text(entry.name, `dependencyDigests[${index}].name`, 200);
    if (!dependencyNamePattern.test(name)) fail(`dependencyDigests[${index}].name is not a safe path label`);
    if (seen.has(name)) fail(`dependencyDigests contains a duplicate entry for ${name}`);
    seen.add(name);
    const sha256 = text(entry.sha256, `dependencyDigests[${index}].sha256`, 64);
    if (!digestPattern.test(sha256)) fail(`dependencyDigests[${index}].sha256 must be 64 lower-case hex characters`);
    return Object.freeze({ name, sha256 });
  });
  return Object.freeze(dependencies);
}

function normalized(input: PrCheckProfileInput): PrCheckProfileInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('profile must be an object');
  }
  const profileId = text(input.profileId, 'profileId', 64);
  if (!checkIdPattern.test(profileId)) fail('profileId must be a lower-case identifier');
  const policyVersion = text(input.policyVersion, 'policyVersion', 32);
  const repository = text(input.repository, 'repository', 140);
  if (!repositoryPattern.test(repository)) fail('repository must be a lower-case owner/name');
  const policyCommitSha = text(input.policyCommitSha, 'policyCommitSha', 40);
  if (!commitPattern.test(policyCommitSha)) fail('policyCommitSha must be 40 lower-case hex characters');
  const imageDigest = text(input.imageDigest, 'imageDigest', 80);
  if (!imagePattern.test(imageDigest)) fail('imageDigest must be sha256:<64 lower-case hex characters>');

  const dependencyDigests = validateDependencies(input.dependencyDigests);

  if (!Array.isArray(input.requiredChecks)) fail('requiredChecks must be an array');
  if (input.requiredChecks.length === 0) fail('requiredChecks must contain at least one check');
  if (input.requiredChecks.length > PROFILE_LIMITS.maxRequiredChecks) {
    fail(`requiredChecks must contain at most ${PROFILE_LIMITS.maxRequiredChecks} checks`);
  }
  const requiredChecks = input.requiredChecks.map((check, index) =>
    validateCheck(check, `requiredChecks[${index}]`),
  );
  const regressionCheck = validateCheck(input.regressionCheck, 'regressionCheck');

  const ids = new Set<string>();
  for (const check of requiredChecks) {
    if (ids.has(check.checkId)) fail(`duplicate checkId ${check.checkId} in requiredChecks`);
    if (check.checkId === regressionCheck.checkId) {
      fail(`checkId ${check.checkId} is reserved for the regression check`);
    }
    ids.add(check.checkId);
  }
  if (requiredChecks.some((check) => check.command === regressionCheck.command)) {
    fail('regressionCheck must use an independent command, not a same-command replay');
  }

  return {
    profileId,
    policyVersion,
    repository,
    policyCommitSha,
    imageDigest,
    dependencyDigests,
    requiredChecks: Object.freeze(requiredChecks),
    regressionCheck,
  };
}

export function computeProfileDigest(input: PrCheckProfileInput | PrCheckProfile): string {
  const value = input as PrCheckProfile;
  return sha256Hex(
    stableStringify({
      profileId: value.profileId,
      policyVersion: value.policyVersion,
      repository: value.repository,
      policyCommitSha: value.policyCommitSha,
      imageDigest: value.imageDigest,
      dependencyDigests: value.dependencyDigests,
      requiredChecks: value.requiredChecks,
      regressionCheck: value.regressionCheck,
    }),
  );
}

/**
 * Validate approved policy data and freeze it. The returned profile digest is
 * the content address used by plans and by the verdict evaluator.
 */
export function defineApprovedProfile(input: PrCheckProfileInput): PrCheckProfile {
  const value = normalized(input);
  return Object.freeze({ ...value, profileDigest: computeProfileDigest(value) });
}

export interface LoadApprovedProfileOptions {
  /** Hard bound for the profile file. Default 1 MiB, maximum 4 MiB. */
  readonly maxBytes?: number;
}

/**
 * Load and validate the approved profile from an absolute file path.
 *
 * Parsing is offline: no environment overrides, no remote fetch, no model or
 * AWS call. Invalid JSON, a non-file path, an oversized file or invalid policy
 * data all fail with ProfileValidationError.
 */
export async function loadApprovedProfile(
  path: string,
  options: LoadApprovedProfileOptions = {},
): Promise<PrCheckProfile> {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') {
    fail('profile path must be an absolute file path');
  }
  if (options === null || typeof options !== 'object') {
    fail('profile load options must be an object');
  }
  const maxBytes = options.maxBytes ?? PROFILE_LIMITS.defaultProfileFileBytes;
  if (
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > PROFILE_LIMITS.maxProfileFileBytes
  ) {
    fail(`maxBytes must be an integer between 1 and ${PROFILE_LIMITS.maxProfileFileBytes}`);
  }

  const fs: any = await import('node:fs/promises');
  let info: any;
  try {
    info = await fs.lstat(path);
  } catch {
    fail('profile file cannot be read');
  }
  if (!info.isFile()) fail('profile path must be a regular file');
  if (info.size > maxBytes) fail(`profile file exceeds ${maxBytes} bytes`);

  const raw = (await readFile(path, 'utf8')) as string;
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) fail(`profile file exceeds ${maxBytes} bytes`);
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('profile file is not valid JSON');
  }
  return defineApprovedProfile(parsed as PrCheckProfileInput);
}
