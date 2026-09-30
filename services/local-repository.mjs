import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnedProcess } from './local-command.mjs';

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

function listTrackedFiles(repositoryPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryPath, 'ls-files', '-z'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const files = [];
    const rootFiles = new Set();
    const languages = new Map();
    let count = 0;
    let pending = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);

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
      reject(new Error(`Could not read cloned repository: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
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

  async clone(url, { signal } = {}) {
    const repository = parseRepositoryUrl(url);
    const controller = new AbortController();
    this.#clones.add(controller);
    let workspacePath;
    try {
      workspacePath = await mkdtemp(join(tmpdir(), 'verifai-repository-'));
      const cloneSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      await runGit(['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet', '--', repository.url, workspacePath], { signal: cloneSignal });
      const listing = await listTrackedFiles(workspacePath);
      const info = await readRepository(workspacePath, listing);
      const files = {
        count: listing.count,
        items: listing.items,
        truncated: listing.truncated,
        languages: listing.languages,
      };
      const id = randomUUID();
      const record = {
        id,
        repository,
        clone: { success: true, workspacePath },
        files,
        info,
      };
      this.#repositories.set(id, record);
      return record;
    } catch (error) {
      if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
      throw error;
    } finally { this.#clones.delete(controller); }
  }

  get(id) {
    return this.#repositories.get(id);
  }

  async cleanup(id) {
    const record = this.#repositories.get(id);
    if (!record) return false;
    await rm(record.clone.workspacePath, { recursive: true, force: true });
    this.#repositories.delete(id);
    return true;
  }

  async cleanupAll() {
    for (const controller of this.#clones) controller.abort();
    while (this.#clones.size) await new Promise(resolve => setTimeout(resolve, 10));
    const ids = [...this.#repositories.keys()];
    await Promise.all(ids.map((id) => this.cleanup(id)));
  }
}
