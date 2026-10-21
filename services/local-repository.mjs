import { randomUUID } from 'node:crypto';
import { lstat, opendir, readFile } from 'node:fs/promises';
import { registerWorkspace, removeWorkspace } from './repository-workspaces.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { runOwnedProcess } from './local-command.mjs';

export const defaultRepositoryBounds = Object.freeze({
  workspaceBytes: 100 * 1024 * 1024,
  workspaceEntries: 20_000,
  retainedWorkspaces: 4,
  workspaceCheckIntervalMs: 100,
});

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function overrunError(reason, limits) {
  const error = reason === 'bytes'
    ? new Error(`Repository materialization exceeded the workspace limit of ${limits.maxBytes} bytes`)
    : new Error(`Repository materialization exceeded the workspace limit of ${limits.maxEntries} entries`);
  error.statusCode = 413;
  return error;
}

// Bounded size/entry accounting of an owned workspace. Symlinks are counted as
// entries but never followed, so neither their targets' bytes nor their
// targets' subtrees enter the account. The walk stops the moment a ceiling is
// crossed and reads each directory incrementally, so the accounting itself
// stays bounded by the ceilings instead of by the repository's shape.
export async function workspaceUsage(root, { maxBytes, maxEntries }) {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) continue;
      throw error;
    }
    // The async iterator closes the handle on completion, break, and throw.
    for await (const entry of handle) {
      entries += 1;
      if (entries > maxEntries) return { bytes, entries, overrun: 'entries' };
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        bytes += (await lstat(join(directory, entry.name))).size;
      } catch (error) {
        if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
        continue;
      }
      if (bytes > maxBytes) return { bytes, entries, overrun: 'bytes' };
    }
  }
  return { bytes, entries, overrun: null };
}

// Polls the owned workspace while materialization runs and reports the first
// overrun. The poller aborts the clone's owned controller, which kills the
// owned git process tree through the existing abort path in runOwnedProcess.
function startWorkspaceMonitor(workspacePath, limits, intervalMs, onOverrun) {
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    let usage;
    try {
      usage = await workspaceUsage(workspacePath, limits);
    } catch {
      // Transient filesystem races while git writes; the settled recheck after
      // materialization still enforces the ceiling.
      usage = { overrun: null };
    }
    if (stopped) return;
    if (usage.overrun) {
      stopped = true;
      onOverrun(usage.overrun);
      return;
    }
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref?.();
  };
  void tick();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

const fileLimit = 100;
const languageByExtension = new Map([
  ['.c', 'C'], ['.cc', 'C++'], ['.cpp', 'C++'], ['.cs', 'C#'], ['.dart', 'Dart'],
  ['.go', 'Go'], ['.html', 'HTML'], ['.java', 'Java'], ['.js', 'JavaScript'],
  ['.jsx', 'JavaScript'], ['.kt', 'Kotlin'], ['.php', 'PHP'], ['.py', 'Python'],
  ['.rb', 'Ruby'], ['.rs', 'Rust'], ['.swift', 'Swift'], ['.ts', 'TypeScript'],
  ['.tsx', 'TypeScript'], ['.vue', 'Vue'],
]);

function parseRepositoryUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a public GitHub repository URL.');

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Enter a valid public GitHub repository URL.');
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Only public HTTPS repositories on github.com are supported.');
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')) {
    throw new Error('Use a GitHub URL in the form https://github.com/owner/repository.');
  }

  const [owner, rawName] = parts;
  const name = rawName.replace(/\.git$/i, '');
  if (!name) throw new Error('The GitHub repository name is missing.');

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}.git`,
  };
}

async function runGit(args, { cwd, timeoutMs = 119_000, signal } = {}) {
  const result = await runOwnedProcess('/usr/bin/git', args, { cwd, timeoutMs, signal });
  if (result.status !== 'Completed') throw new Error(result.stderr.trim() || `git ${args[0]} Incomplete (${result.status})`);
  return result;
}

function listTrackedFiles(repositoryPath, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-C', repositoryPath, 'ls-files', '-z'], {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const files = [];
    const rootFiles = new Set();
    const languages = new Map();
    let count = 0;
    let pending = '';
    let stderr = '';
    let finished = false;
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const paths = `${pending}${chunk}`.split('\0');
      pending = paths.pop() || '';
      for (const path of paths) recordPath(path);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(new Error(`Could not read cloned repository: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (pending) recordPath(pending);
      if (code !== 0) return reject(new Error(stderr.trim() || `Could not read repository file list${signal ? ` (${signal})` : ''}`));
      const detectedLanguages = [...languages.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([name]) => name);
      resolve({ count, items: files, truncated: count > files.length, languages: detectedLanguages, rootFiles });
    });

    function recordPath(path) {
      if (!path) return;
      count += 1;
      if (files.length < fileLimit) files.push(path);
      if (!path.includes('/') && ['README', 'README.md', 'README.rst', 'README.txt', 'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile', 'composer.json'].includes(path)) {
        rootFiles.add(path);
      }
      const fileName = path.slice(path.lastIndexOf('/') + 1);
      const dot = fileName.lastIndexOf('.');
      if (dot > 0) {
        const language = languageByExtension.get(fileName.slice(dot).toLowerCase());
        if (language) languages.set(language, (languages.get(language) || 0) + 1);
      }
    }
  });
}

async function readRepository(repositoryPath, files) {
  const rootFiles = new Set(files.items.filter((path) => !path.includes('/')));
  const manifests = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile', 'composer.json']
    .filter((name) => rootFiles.has(name));
  const packageManager = rootFiles.has('pnpm-lock.yaml') ? 'pnpm'
    : rootFiles.has('yarn.lock') ? 'yarn'
      : rootFiles.has('package-lock.json') ? 'npm'
        : null;
  let packageInfo = null;
  if (rootFiles.has('package.json')) {
    try {
      const packagePath = join(repositoryPath, 'package.json');
      const packageStat = await lstat(packagePath);
      if (packageStat.isFile() && packageStat.size <= 64 * 1024) {
        const parsed = JSON.parse(await readFile(packagePath, 'utf8'));
        packageInfo = {
          name: typeof parsed.name === 'string' ? parsed.name : null,
          description: typeof parsed.description === 'string' ? parsed.description.slice(0, 240) : null,
        };
      }
    } catch {
      packageInfo = null;
    }
  }

  return {
    manifests,
    packageManager,
    package: packageInfo,
    hasReadme: [...rootFiles].some((path) => /^readme(?:\.[^/]+)?$/i.test(path)),
  };
}

export class LocalRepositoryService {
  #repositories = new Map();
  #clones = new Set();
  #registries = new Map();
  #maxWorkspaceBytes;
  #maxWorkspaceEntries;
  #maxRetainedWorkspaces;
  #workspaceCheckIntervalMs;
  #runGit;

  constructor({
    maxWorkspaceBytes = defaultRepositoryBounds.workspaceBytes,
    maxWorkspaceEntries = defaultRepositoryBounds.workspaceEntries,
    maxRetainedWorkspaces = defaultRepositoryBounds.retainedWorkspaces,
    workspaceCheckIntervalMs = defaultRepositoryBounds.workspaceCheckIntervalMs,
    runGit: runGitImpl = runGit,
  } = {}) {
    this.#maxWorkspaceBytes = positiveSafeInteger(maxWorkspaceBytes, 'maxWorkspaceBytes');
    this.#maxWorkspaceEntries = positiveSafeInteger(maxWorkspaceEntries, 'maxWorkspaceEntries');
    this.#maxRetainedWorkspaces = positiveSafeInteger(maxRetainedWorkspaces, 'maxRetainedWorkspaces');
    this.#workspaceCheckIntervalMs = positiveSafeInteger(workspaceCheckIntervalMs, 'workspaceCheckIntervalMs');
    this.#runGit = runGitImpl;
  }

  async clone(url, { signal } = {}) {
    const repository = parseRepositoryUrl(url);
    // Admission: every bound is checked synchronously, before the ownership
    // registry, the workspace directory, or any process spawn. Callers cannot
    // widen these limits per request.
    signal?.throwIfAborted();
    if (this.#clones.size > 0) throw new Error('Another repository clone is already in progress; one materialization at a time');
    if (this.#repositories.size >= this.#maxRetainedWorkspaces) {
      throw new Error(`Repository workspace limit reached (${this.#maxRetainedWorkspaces}); clean up a repository before cloning another`);
    }
    const limits = { maxBytes: this.#maxWorkspaceBytes, maxEntries: this.#maxWorkspaceEntries };
    const controller = new AbortController();
    this.#clones.add(controller);
    let workspacePath;
    let registry;
    let monitor;
    let overrunReason = null;
    const id = randomUUID();
    try {
      ({ workspacePath, registry } = await registerWorkspace(id));
      monitor = startWorkspaceMonitor(workspacePath, limits, this.#workspaceCheckIntervalMs, (reason) => {
        overrunReason = reason;
        controller.abort();
      });
      const cloneSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      await this.#runGit(['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet', '--', repository.url, workspacePath], { signal: cloneSignal });
      const head = (await this.#runGit(['-C', workspacePath, 'rev-parse', 'HEAD'], { signal: cloneSignal })).stdout.trim();
      if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error('Could not resolve cloned HEAD commit');
      repository.commit = head;
      const listing = await listTrackedFiles(workspacePath, cloneSignal);
      const info = await readRepository(workspacePath, listing);
      cloneSignal.throwIfAborted();
      // The poller can miss a materialization shorter than one interval, so
      // the ceiling is re-checked against the settled workspace before success.
      const usage = await workspaceUsage(workspacePath, limits);
      if (usage.overrun) throw overrunError(usage.overrun, limits);
      monitor.stop();
      const files = {
        count: listing.count,
        items: listing.items,
        truncated: listing.truncated,
        languages: listing.languages,
      };
      const record = {
        id,
        repository,
        clone: { success: true, workspacePath },
        files,
        info,
      };
      this.#repositories.set(id, record);
      this.#registries.set(id, registry);
      return record;
    } catch (error) {
      if (workspacePath) await removeWorkspace(workspacePath, registry);
      if (overrunReason) throw overrunError(overrunReason, limits);
      throw error;
    } finally {
      monitor?.stop();
      this.#clones.delete(controller);
    }
  }

  get(id) {
    return this.#repositories.get(id);
  }

  async cleanup(id) {
    const record = this.#repositories.get(id);
    if (!record) return false;
    await removeWorkspace(record.clone.workspacePath, this.#registries.get(id));
    this.#repositories.delete(id);
    this.#registries.delete(id);
    return true;
  }

  async cleanupAll() {
    for (const controller of this.#clones) controller.abort();
    while (this.#clones.size) await new Promise(resolve => setTimeout(resolve, 10));
    const ids = [...this.#repositories.keys()];
    await Promise.all(ids.map((id) => this.cleanup(id)));
  }
}
