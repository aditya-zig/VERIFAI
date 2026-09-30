import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const maxOutputBytes = 8 * 1024; // per stream; total <32 KiB
const safePath = /^[A-Za-z0-9_./-]+$/;

async function regularFile(cwd, file) {
  if (!safePath.test(file) || file.startsWith('-') || file.startsWith('/') || file.split('/').includes('..')) return false;
  try {
    const full = join(cwd, file);
    const actual = await realpath(full);
    return actual.startsWith(`${await realpath(cwd)}${sep}`) && (await lstat(full)).isFile();
  } catch { return false; }
}

// Compile only explicitly recognized scripts to argv. NEVER run npm/yarn/pnpm:
// their lifecycle hooks, .npmrc and script-shell are untrusted executable input.
export async function selectCommand(cwd, files) {
  const manager = files.includes('pnpm-lock.yaml') ? 'pnpm'
    : files.includes('yarn.lock') ? 'yarn' : 'npm';
  if (files.includes('package.json') && await regularFile(cwd, 'package.json')) {
    try {
      const stat = await lstat(join(cwd, 'package.json'));
      if (stat.size <= 64 * 1024) {
        const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
        for (const name of ['test', 'typecheck', 'lint']) {
          const script = pkg.scripts?.[name];
          if (script === 'node --version') return { executable: 'node', args: ['--version'], source: `${manager} script: ${name}`, file: 'package.json' };
          const match = typeof script === 'string' && script.match(/^node --check ([A-Za-z0-9_./-]+\.(?:js|mjs|cjs))$/);
          if (match && files.includes(match[1]) && await regularFile(cwd, match[1])) {
            return { executable: 'node', args: ['--check', match[1]], source: `${manager} script: ${name}`, file: match[1] };
          }
        }
      }
    } catch { /* No safe script: use the explicitly allowed tracked-file check. */ }
  }
  const file = files.find((f) => /^readme(?:\.[A-Za-z0-9_-]+)?$/i.test(f));
  if (file && await regularFile(cwd, file)) {
    return { executable: 'git', args: ['-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', file], source: 'tracked README check (not a test suite)', file };
  }
  throw new Error('Incomplete: no supported safe command (node --version, node --check, or tracked README check)');
}

// Trusted process boundary. Callers supply hardcoded argv, never model text.
export function runOwnedProcess(executable, args, { cwd, timeoutMs = 10_000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= 120_000) throw new Error('Timeout must be below 120 seconds');
  return new Promise((resolveResult, reject) => {
    const start = performance.now();
    const child = spawn(executable, args, {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const killTree = (signal) => {
      if (child.pid) {
        try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    const timeout = setTimeout(() => { timedOut = true; killTree('SIGKILL'); }, timeoutMs);
    const collect = (previous, chunk) => {
      const combined = Buffer.concat([previous, chunk]);
      if (combined.length > maxOutputBytes) truncated = true;
      return combined.subarray(Math.max(0, combined.length - maxOutputBytes));
    };
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      killTree('SIGKILL'); // also owns any descendants left by the command
      resolveResult({ exitCode, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
        durationMs: Math.round(performance.now() - start), timedOut, truncated,
        status: timedOut ? 'Incomplete' : exitCode === 0 ? 'Completed' : 'Failed' });
    });
  });
}

export async function executeCommand(cwd, selected, options = {}) {
  const { executable, args, file } = selected ?? {};
  const version = executable === 'node' && JSON.stringify(args) === '["--version"]' && file === 'package.json';
  const check = executable === 'node' && Array.isArray(args) && args.length === 2 && args[0] === '--check' && args[1] === file && /\.(js|mjs|cjs)$/.test(file);
  const readme = executable === 'git' && /^readme(?:\.[A-Za-z0-9_-]+)?$/i.test(file) && JSON.stringify(args) === JSON.stringify(['-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', file]);
  if (!(version || check || readme) || !await regularFile(cwd, file)) throw new Error('Blocked command: not in the bounded command policy');
  const result = await runOwnedProcess(executable === 'node' ? process.execPath : '/usr/bin/git', args, { ...options, cwd: resolve(cwd) });
  return { command: [executable, ...args].join(' '), source: selected.source, ...result };
}
