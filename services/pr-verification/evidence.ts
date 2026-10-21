import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestDefinition } from '../../packages/contracts/src/index.js';
import { sha256Hex, stableStringify } from './profile.js';

/**
 * Private, content-addressed bytes for tests and evidence records.
 *
 * Everything is written and hashed before a caller may use it. Loading
 * re-hashes bytes on disk, so edits between planning and evaluation, a stale
 * restart or a swapped file fail closed instead of silently changing what was
 * approved.
 *
 * Files live under <root>/<collection>/<sha256> with mode 0600 in a 0700
 * directory. Public handles are opaque scheme references; caller-supplied
 * paths never reach the filesystem.
 */
export const ARTIFACT_LIMITS = Object.freeze({
  maxArtifactBytes: 65_536,
  maxEvidenceRecordBytes: 262_144,
  maxEvidenceRecordLimit: 4_194_304,
  maxReferenceLength: 128,
  maxEvidenceRefs: 32,
});

export type ArtifactErrorCode =
  | 'INVALID_ROOT'
  | 'INVALID_SOURCE'
  | 'INVALID_OPTIONS'
  | 'INVALID_REF'
  | 'MISSING'
  | 'TOO_LARGE'
  | 'NOT_REGULAR'
  | 'TAMPERED';

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

export interface StoredArtifact {
  readonly artifactRef: string;
  readonly contentSha256: string;
  readonly bytes: number;
}

export interface StoredEvidence {
  readonly evidenceRef: string;
  readonly contentSha256: string;
  readonly bytes: number;
}

export interface LoadedEvidence {
  readonly record: unknown;
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
}

export interface EvidenceWriterOptions {
  /** Hard bound for one JSON record. Default 256 KiB, maximum 4 MiB. */
  readonly maxRecordBytes?: number;
}

const digestPattern = /^[0-9a-f]{64}$/;
const artifactPrefix = 'artifact://tests/';
const evidencePrefix = 'evidence://records/';

// The repository's minimal node shim omits lstat/open. They are loaded lazily
// so reads can reject symlinks and bound file size before reading bytes.
async function filesystem(): Promise<any> {
  return import('node:fs/promises');
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function normalizeRoot(root: string): string {
  if (typeof root !== 'string' || !root.startsWith('/') || root === '/') {
    throw new ArtifactError('INVALID_ROOT', 'artifact root must be an absolute private directory');
  }
  return root.replace(/\/+$/, '');
}

function digestFromRef(reference: unknown, prefix: string): string {
  if (typeof reference !== 'string' || reference.length > ARTIFACT_LIMITS.maxReferenceLength) {
    throw new ArtifactError('INVALID_REF', 'content reference is not a bounded string');
  }
  if (!reference.startsWith(prefix)) {
    throw new ArtifactError('INVALID_REF', `content reference must start with ${prefix}`);
  }
  const digest = reference.slice(prefix.length);
  if (!digestPattern.test(digest)) {
    throw new ArtifactError('INVALID_REF', 'content reference must end with a 64 character lower-case hex digest');
  }
  return digest;
}

class PrivateContentStore {
  readonly root: string;
  readonly directory: string;
  readonly prefix: string;
  readonly maxBytes: number;

  constructor(root: string, collection: string, prefix: string, maxBytes: number) {
    this.root = normalizeRoot(root);
    this.directory = join(this.root, collection);
    this.prefix = prefix;
    this.maxBytes = maxBytes;
  }

  refFor(digest: string): string {
    return `${this.prefix}${digest}`;
  }

  digestFor(reference: unknown): string {
    return digestFromRef(reference, this.prefix);
  }

  pathFor(digest: string): string {
    if (!digestPattern.test(digest)) {
      throw new ArtifactError('INVALID_REF', 'content digest must be 64 lower-case hex characters');
    }
    return join(this.directory, digest);
  }

  async persist(bytes: Uint8Array): Promise<{ ref: string; digest: string; bytes: number }> {
    if (bytes.length > this.maxBytes) {
      throw new ArtifactError('TOO_LARGE', `content exceeds ${this.maxBytes} bytes`);
    }
    const digest = sha256Hex(bytes);
    const ref = this.refFor(digest);
    const path = this.pathFor(digest);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const fs = await filesystem();
    // mkdir does not tighten an existing directory, so enforce privacy.
    await fs.chmod(this.directory, 0o700);

    let created = false;
    try {
      const handle = await fs.open(path, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      created = true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    if (!created) {
      const info = await fs.lstat(path);
      if (!info.isFile()) throw new ArtifactError('NOT_REGULAR', 'existing content is not a regular file');
      if (info.size > this.maxBytes) {
        throw new ArtifactError('TOO_LARGE', `content exceeds ${this.maxBytes} bytes`);
      }
      const existing = await readFile(path);
      if (!existing.equals(bytes)) {
        throw new ArtifactError('TAMPERED', 'existing content bytes do not match their content address');
      }
    } else {
      await this.syncDirectory(fs);
    }

    return { ref, digest, bytes: bytes.length };
  }

  async load(reference: unknown): Promise<Uint8Array> {
    const digest = this.digestFor(reference);
    const path = this.pathFor(digest);
    const fs = await filesystem();

    let info: any;
    try {
      info = await fs.lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new ArtifactError('MISSING', 'content bytes are not present');
      throw error;
    }
    if (!info.isFile()) throw new ArtifactError('NOT_REGULAR', 'content path is not a regular file');
    if (info.size > this.maxBytes) {
      throw new ArtifactError('TOO_LARGE', `content exceeds ${this.maxBytes} bytes`);
    }

    const bytes = await readFile(path);
    if (sha256Hex(bytes) !== digest) {
      throw new ArtifactError('TAMPERED', 'content bytes do not match their content address');
    }
    return bytes;
  }

  private async syncDirectory(fs: any): Promise<void> {
    try {
      const handle = await fs.open(this.directory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is best effort; the file bytes are already flushed.
    }
  }
}

export function artifactRefFor(contentSha256: string): string {
  if (!digestPattern.test(contentSha256)) {
    throw new ArtifactError('INVALID_REF', 'artifact digest must be 64 lower-case hex characters');
  }
  return `${artifactPrefix}${contentSha256}`;
}

export function artifactFilePath(root: string, contentSha256: string): string {
  if (!digestPattern.test(contentSha256)) {
    throw new ArtifactError('INVALID_REF', 'artifact digest must be 64 lower-case hex characters');
  }
  return join(root, 'tests', contentSha256);
}

export function evidenceFilePath(root: string, contentSha256: string): string {
  if (!digestPattern.test(contentSha256)) {
    throw new ArtifactError('INVALID_REF', 'evidence digest must be 64 lower-case hex characters');
  }
  return join(root, 'records', contentSha256);
}

export class TestArtifactStore {
  readonly root: string;
  readonly #store: PrivateContentStore;

  constructor(root: string) {
    this.root = normalizeRoot(root);
    this.#store = new PrivateContentStore(this.root, 'tests', artifactPrefix, ARTIFACT_LIMITS.maxArtifactBytes);
  }

  /** Persist bytes under their digest. Existing identical bytes are reused. */
  async persist(source: string): Promise<StoredArtifact> {
    if (typeof source !== 'string') {
      throw new ArtifactError('INVALID_SOURCE', 'artifact source must be a string');
    }
    const bytes = Buffer.from(source, 'utf8');
    const stored = await this.#store.persist(bytes);
    return Object.freeze({
      artifactRef: stored.ref,
      contentSha256: stored.digest,
      bytes: stored.bytes,
    });
  }

  /** Load and re-hash bytes. Any mismatch, symlink or missing file fails. */
  async load(reference: string): Promise<Uint8Array> {
    return this.#store.load(reference);
  }

  /** Verify a plan definition's reference and digest against stored bytes. */
  async verify(definition: TestDefinition): Promise<Uint8Array> {
    if (definition === null || typeof definition !== 'object') {
      throw new ArtifactError('INVALID_REF', 'test definition must be an object');
    }
    if (
      typeof definition.contentSha256 !== 'string' ||
      !digestPattern.test(definition.contentSha256) ||
      definition.artifactRef !== artifactRefFor(definition.contentSha256)
    ) {
      throw new ArtifactError('INVALID_REF', 'test definition reference does not match its content digest');
    }
    return this.load(definition.artifactRef);
  }
}

function assertJsonValue(value: unknown, seen: Set<object>): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new ArtifactError('INVALID_SOURCE', 'evidence record numbers must be finite');
    }
    return;
  }
  if (type !== 'object') {
    throw new ArtifactError('INVALID_SOURCE', 'evidence record must contain only JSON values');
  }
  const object = value as object;
  if (seen.has(object)) {
    throw new ArtifactError('INVALID_SOURCE', 'evidence record must not contain cycles');
  }
  seen.add(object);
  if (Array.isArray(object)) {
    for (const item of object) assertJsonValue(item, seen);
  } else {
    for (const key of Object.keys(object)) {
      assertJsonValue((object as Record<string, unknown>)[key], seen);
    }
  }
  seen.delete(object);
}

/**
 * Writes caller-supplied JSON records as content-addressed evidence.
 *
 * The writer never creates a record, fills a verdict or marks a check passed.
 * A jobs worker writes the adapter's observation or log, then places the
 * returned `evidenceRef` in `CheckObservation.artifactRefs`.
 */
export class EvidenceWriter {
  readonly root: string;
  readonly #store: PrivateContentStore;

  constructor(root: string, options: EvidenceWriterOptions = {}) {
    const maxRecordBytes = options.maxRecordBytes ?? ARTIFACT_LIMITS.maxEvidenceRecordBytes;
    if (
      typeof maxRecordBytes !== 'number' ||
      !Number.isSafeInteger(maxRecordBytes) ||
      maxRecordBytes <= 0 ||
      maxRecordBytes > ARTIFACT_LIMITS.maxEvidenceRecordLimit
    ) {
      throw new ArtifactError(
        'INVALID_OPTIONS',
        `maxRecordBytes must be between 1 and ${ARTIFACT_LIMITS.maxEvidenceRecordLimit}`,
      );
    }
    this.root = normalizeRoot(root);
    this.#store = new PrivateContentStore(this.root, 'records', evidencePrefix, maxRecordBytes);
  }

  async write(record: unknown): Promise<StoredEvidence> {
    assertJsonValue(record, new Set());
    const text = stableStringify(record);
    if (typeof text !== 'string') {
      throw new ArtifactError('INVALID_SOURCE', 'evidence record could not be serialized');
    }
    const bytes = Buffer.from(text, 'utf8');
    const stored = await this.#store.persist(bytes);
    return Object.freeze({
      evidenceRef: stored.ref,
      contentSha256: stored.digest,
      bytes: stored.bytes,
    });
  }

  async read(evidenceRef: string): Promise<LoadedEvidence> {
    const bytes = await this.#store.load(evidenceRef);
    const contentSha256 = this.#store.digestFor(evidenceRef);
    let record: unknown;
    try {
      record = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new ArtifactError('TAMPERED', 'evidence record is not valid JSON');
    }
    return { record, bytes, contentSha256 };
  }

  pathFor(contentSha256: string): string {
    return this.#store.pathFor(contentSha256);
  }
}
