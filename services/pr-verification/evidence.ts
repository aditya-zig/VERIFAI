import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestDefinition } from '../../packages/contracts/src/index.js';
import { sha256Hex } from './profile.js';

/**
 * Content-addressed test artifacts.
 *
 * Bytes are written and hashed before a check may run. Loading re-hashes the
 * bytes on disk, so edits between planning and evaluation, a stale restart or
 * a swapped file fail closed instead of silently changing what was approved.
 *
 * Files live under <root>/tests/<sha256> with mode 0600 in a 0700 directory.
 * The public handle is an opaque `artifact://tests/<sha256>` reference; no
 * caller-supplied path ever reaches the filesystem.
 */
export const ARTIFACT_LIMITS = Object.freeze({
  maxArtifactBytes: 65_536,
  maxReferenceLength: 128,
  maxEvidenceRefs: 32,
});

export type ArtifactErrorCode =
  | 'INVALID_ROOT'
  | 'INVALID_SOURCE'
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

const digestPattern = /^[0-9a-f]{64}$/;
const referencePattern = /^artifact:\/\/tests\/([0-9a-f]{64})$/;

// The repository's minimal node shim omits lstat/open. They are loaded lazily
// so artifact reads can reject symlinks and bound file size before reading.
async function filesystem(): Promise<any> {
  return import('node:fs/promises');
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function artifactRefFor(contentSha256: string): string {
  if (!digestPattern.test(contentSha256)) {
    throw new ArtifactError('INVALID_REF', 'artifact digest must be 64 lower-case hex characters');
  }
  return `artifact://tests/${contentSha256}`;
}

export function artifactFilePath(root: string, contentSha256: string): string {
  if (!digestPattern.test(contentSha256)) {
    throw new ArtifactError('INVALID_REF', 'artifact digest must be 64 lower-case hex characters');
  }
  return join(root, 'tests', contentSha256);
}

function parseReference(reference: unknown): string {
  if (typeof reference !== 'string' || reference.length > ARTIFACT_LIMITS.maxReferenceLength) {
    throw new ArtifactError('INVALID_REF', 'artifact reference is not a bounded string');
  }
  const match = referencePattern.exec(reference);
  if (!match) throw new ArtifactError('INVALID_REF', 'artifact reference must be artifact://tests/<sha256>');
  return match[1] as string;
}

export class TestArtifactStore {
  readonly root: string;

  constructor(root: string) {
    if (typeof root !== 'string' || !root.startsWith('/') || root === '/') {
      throw new ArtifactError('INVALID_ROOT', 'artifact root must be an absolute private directory');
    }
    this.root = root.replace(/\/+$/, '');
  }

  /** Persist bytes under their digest. Existing identical bytes are reused. */
  async persist(source: string): Promise<StoredArtifact> {
    if (typeof source !== 'string') {
      throw new ArtifactError('INVALID_SOURCE', 'artifact source must be a string');
    }
    const bytes = Buffer.from(source, 'utf8');
    if (bytes.length > ARTIFACT_LIMITS.maxArtifactBytes) {
      throw new ArtifactError('TOO_LARGE', `artifact exceeds ${ARTIFACT_LIMITS.maxArtifactBytes} bytes`);
    }
    const contentSha256 = sha256Hex(bytes);
    const artifactRef = artifactRefFor(contentSha256);
    const directory = join(this.root, 'tests');
    const path = artifactFilePath(this.root, contentSha256);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fs = await filesystem();
    // mkdir does not tighten an existing directory, so enforce privacy.
    await fs.chmod(directory, 0o700);
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
      if (!info.isFile()) throw new ArtifactError('NOT_REGULAR', 'existing artifact is not a regular file');
      if (info.size > ARTIFACT_LIMITS.maxArtifactBytes) {
        throw new ArtifactError('TOO_LARGE', `artifact exceeds ${ARTIFACT_LIMITS.maxArtifactBytes} bytes`);
      }
      const existing = await readFile(path);
      if (!existing.equals(bytes)) {
        throw new ArtifactError('TAMPERED', 'existing artifact bytes do not match their content address');
      }
    } else {
      await this.syncDirectory(directory, fs);
    }

    return Object.freeze({ artifactRef, contentSha256, bytes: bytes.length });
  }

  /** Load and re-hash bytes. Any mismatch, symlink or missing file fails. */
  async load(reference: string): Promise<Uint8Array> {
    const digest = parseReference(reference);
    const path = artifactFilePath(this.root, digest);
    const fs = await filesystem();

    let info: any;
    try {
      info = await fs.lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new ArtifactError('MISSING', 'artifact bytes are not present');
      throw error;
    }
    if (!info.isFile()) throw new ArtifactError('NOT_REGULAR', 'artifact path is not a regular file');
    if (info.size > ARTIFACT_LIMITS.maxArtifactBytes) {
      throw new ArtifactError('TOO_LARGE', `artifact exceeds ${ARTIFACT_LIMITS.maxArtifactBytes} bytes`);
    }

    const bytes = await readFile(path);
    if (sha256Hex(bytes) !== digest) {
      throw new ArtifactError('TAMPERED', 'artifact bytes do not match their content address');
    }
    return bytes;
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

  private async syncDirectory(directory: string, fs: any): Promise<void> {
    try {
      const handle = await fs.open(directory, 'r');
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
