import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const maxBytes = 16 * 1024;

function validate(record, key) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.key !== key
    || typeof key !== 'string' || !key || key.length > 1024
    || typeof record.repository !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(record.repository)
    || !Number.isSafeInteger(record.pullRequest) || record.pullRequest <= 0
    || typeof record.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(record.headSha)
    || ![record.checkRunId, record.commentId].every(id => id === null || Number.isSafeInteger(id) && id > 0)
    || typeof record.externalId !== 'string' || record.externalId.length > 1024
    || typeof record.principal !== 'string' || record.principal.length > 200
    || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error('invalid PR publication record');
  }
  return structuredClone(record);
}

/** Atomic private records. The caller holds the job store's publication lock around remote writes. */
export class FilePrChecksPublicationStore {
  constructor(directory) { this.directory = directory; }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077
      || process.getuid && stat.uid !== process.getuid()) throw new Error('PR publication directory must be private and owned');
  }

  path(key) {
    if (typeof key !== 'string' || !key || key.length > 1024) throw new Error('invalid publication key');
    return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  async get(key) {
    await this.init();
    let handle;
    try { handle = await open(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > maxBytes
        || process.getuid && stat.uid !== process.getuid()) throw new Error('invalid private publication record file');
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new Error('publication record exceeds size limit');
      return validate(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), key);
    } finally { await handle.close(); }
  }

  async save(record) {
    const snapshot = validate(record, record?.key);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > maxBytes) throw new Error('publication record exceeds size limit');
    await this.init();
    const target = this.path(snapshot.key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, target);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
