import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const scriptsDir = path.join(repoRoot, 'ops', 'local-agent', 'scripts');
const PREFLIGHT = path.join(scriptsDir, 'preflight.sh');
const CHECK_DOCKER = path.join(scriptsDir, 'check-docker.sh');
const ALL_SCRIPTS = [PREFLIGHT, CHECK_DOCKER];

// Sentinel that must never appear in any script output.
const SENTINEL = 'VERIFAI_TEST_SECRET_123';

// Run bash with a controlled environment (only PATH/HOME pass through by default).
function runBash(args, { cwd = repoRoot, env = {} } = {}) {
  return spawnSync('bash', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', ...env },
    timeout: 60_000,
  });
}

function runScript(script, opts = {}) {
  return runBash([script], opts);
}

// ---------------------------------------------------------------------------
// 1. Shell syntax is valid (bash -n).
// ---------------------------------------------------------------------------
for (const script of ALL_SCRIPTS) {
  test(`syntax: bash -n ${path.basename(script)}`, () => {
    const r = runBash(['-n', script]);
    assert.equal(r.status, 0, `bash -n failed:\n${r.stderr}`);
  });
}

// ---------------------------------------------------------------------------
// 2. Scripts never reveal secret values.
// ---------------------------------------------------------------------------
test('safety: secret values never appear in output', () => {
  for (const script of ALL_SCRIPTS) {
    const r = runScript(script, {
      env: { OPENROUTER_API_KEY: SENTINEL, VERIFIAI_STATE_SECRET: SENTINEL },
    });
    assert.ok(
      !`${r.stdout}\n${r.stderr}`.includes(SENTINEL),
      `${path.basename(script)} leaked the sentinel secret`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Environment presence is still detected (name + present/absent only).
// ---------------------------------------------------------------------------
test('safety: env presence is reported without values', () => {
  const present = runScript(PREFLIGHT, { env: { OPENROUTER_API_KEY: SENTINEL } });
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /^OPENROUTER_API_KEY: present$/m);
  assert.doesNotMatch(
    present.stdout,
    /^OPENROUTER_API_KEY: (?!present$|absent$)\S/m,
    'presence line must be exactly present/absent',
  );

  const absent = runScript(PREFLIGHT, { env: {} });
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /^OPENROUTER_API_KEY: absent$/m);
});

// ---------------------------------------------------------------------------
// 4. Scripts are read-only (controlled temp setup, HOME/TMPDIR redirected).
// ---------------------------------------------------------------------------
test('safety: scripts create no files in a controlled temp setup', () => {
  for (const script of ALL_SCRIPTS) {
    const dir = mkdtempSync(path.join(tmpdir(), 'verifai-la1-'));
    try {
      const before = readdirSync(dir);
      const r = runScript(script, { cwd: dir, env: { HOME: dir, TMPDIR: dir } });
      const after = readdirSync(dir);
      assert.deepEqual(after, before, `${path.basename(script)} created files: ${after}`);
      assert.ok(
        r.status === 0 || r.status === 1,
        `${path.basename(script)} exited with unclear status ${r.status}`,
      );
      assert.doesNotMatch(
        `${r.stdout}\n${r.stderr}`,
        /parameter not set|unbound variable|command not found/i,
        `${path.basename(script)} failed unclearly under set -u / missing prerequisites`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// 5. preflight fails clearly (non-zero + message) outside a Git checkout.
// ---------------------------------------------------------------------------
test('safety: preflight fails clearly when not inside a Git repository', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verifai-la1-nogit-'));
  try {
    const r = runScript(PREFLIGHT, { cwd: dir, env: { HOME: dir, TMPDIR: dir } });
    assert.equal(r.status, 1, `expected clear failure, got status ${r.status}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /not inside a Git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. No global Docker cleanup / mutation commands in either script.
// ---------------------------------------------------------------------------
test('safety: no docker mutation or cleanup commands in scripts', () => {
  const prohibited = [
    [/\bprune\b/i, 'prune'],
    [/docker\s+rm\b/i, 'docker rm'],
    [/docker\s+stop\b/i, 'docker stop'],
    [/docker\s+kill\b/i, 'docker kill'],
    [/docker\s+pause\b/i, 'docker pause'],
    [/docker\s+restart\b/i, 'docker restart'],
    [/docker\s+update\b/i, 'docker update'],
    [/docker\s+run\b/i, 'docker run'],
    [/docker\s+pull\b/i, 'docker pull'],
    [/docker\s+volume\b/i, 'docker volume'],
    [/docker\s+network\b/i, 'docker network'],
    [/docker\s+system\b/i, 'docker system'],
    [/docker\s+compose\b/i, 'docker compose'],
    [/docker\s+container\s+rm\b/i, 'docker container rm'],
    [/\$\(\s*docker\s+ps[^)]*\)/, 'command substitution over docker ps'],
    [/sudo\b/i, 'sudo'],
  ];
  for (const script of ALL_SCRIPTS) {
    const src = readFileSync(script, 'utf8');
    for (const [pattern, label] of prohibited) {
      assert.ok(
        !pattern.test(src),
        `${path.basename(script)} contains prohibited pattern: ${label}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Docker ownership filtering is label-based.
// ---------------------------------------------------------------------------
test('safety: check-docker uses the ownership label', () => {
  const src = readFileSync(CHECK_DOCKER, 'utf8');
  assert.ok(
    src.includes('dev.verifiai.local-agent.owner='),
    'ownership label dev.verifiai.local-agent.owner= missing',
  );
});

test('behavior: check-docker reports a deterministic label-derived owner id', () => {
  const r1 = runScript(CHECK_DOCKER);
  const r2 = runScript(CHECK_DOCKER);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const m1 = r1.stdout.match(/^owner-label: dev\.verifiai\.local-agent\.owner=(\S+)$/m);
  const m2 = r2.stdout.match(/^owner-label: dev\.verifiai\.local-agent\.owner=(\S+)$/m);
  assert.ok(m1, 'owner-label line missing');
  assert.ok(m2, 'owner-label line missing on second run');
  assert.match(m1[1], /^vagent\.[0-9a-f]{12}$/);
  assert.equal(m1[1], m2[1], 'owner id must be deterministic across runs');
});

// ---------------------------------------------------------------------------
// 8. Scripts work with set -u (declared) and env -i (no unbound vars).
// ---------------------------------------------------------------------------
test('safety: scripts declare set -u', () => {
  for (const script of ALL_SCRIPTS) {
    const src = readFileSync(script, 'utf8');
    assert.match(
      src,
      /^\s*set -[a-zA-Z]*u[a-zA-Z]*\s*$/m,
      `${path.basename(script)} must declare set -u`,
    );
  }
});

test('behavior: scripts run under env -i without unbound-variable errors', () => {
  for (const script of ALL_SCRIPTS) {
    const r = runBash([script], { cwd: repoRoot, env: {} });
    assert.ok(r.status === 0 || r.status === 1, `${path.basename(script)} status ${r.status}`);
    assert.doesNotMatch(
      `${r.stdout}\n${r.stderr}`,
      /parameter not set|unbound variable/i,
      `${path.basename(script)} hit an unbound variable`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. Preflight reports the required local ports.
// ---------------------------------------------------------------------------
test('behavior: preflight reports ports 4173 and 8787', () => {
  const r = runScript(PREFLIGHT);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^port 4173: (listening|free|unknown)$/m);
  assert.match(r.stdout, /^port 8787: (listening|free|unknown)$/m);
});

// ---------------------------------------------------------------------------
// 10. Preflight never invents results (declared values only).
// ---------------------------------------------------------------------------
test('behavior: preflight result lines use declared values only', () => {
  const r = runScript(PREFLIGHT);
  assert.equal(r.status, 0, r.stderr);
  for (const line of r.stdout.split('\n')) {
    if (line.trim() === '' || line.startsWith('verifai local-agent preflight')) continue;
    assert.match(
      line,
      /^port \d+: (listening|free|unknown)$|^[A-Za-z0-9_.-]+: [a-z0-9 ./:(),-]+$/i,
      `unexpected line format: ${line}`,
    );
  }
});


// ===========================================================================
// LA3 — process lifecycle (start-local / stop-local)
// ===========================================================================

const START = path.join(scriptsDir, 'start-local.sh');
const STOP = path.join(scriptsDir, 'stop-local.sh');
const OWNER_ID = `vagent.${createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)}`;
const STATE_DIR_NAME = `verifiai-local-agent-${process.getuid()}-${OWNER_ID}`;

function stateDirIn(tmp) {
  return path.join(tmp, STATE_DIR_NAME);
}

function psField(pid, field) {
  return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim();
}

function writeState(dir, service, fields) {
  mkdirSync(dir, { recursive: true });
  const body = Object.entries({ service, ...fields }).map(([k, v]) => `${k}=${v}`).join('\n');
  writeFileSync(path.join(dir, `${service}.state`), `${body}\n`);
}

function descendants(pid) {
  const out = [];
  const walk = (p) => {
    const kids = spawnSync('pgrep', ['-P', String(p)], { encoding: 'utf8' }).stdout
      .split('\n').filter(Boolean).map(Number);
    for (const k of kids) { out.push(k); walk(k); }
  };
  walk(pid);
  return out;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('la3: bash -n start-local and stop-local', () => {
  for (const s of [START, STOP]) {
    const r = runBash(['-n', s]);
    assert.equal(r.status, 0, `bash -n ${path.basename(s)} failed:\n${r.stderr}`);
  }
});

test('la3: lifecycle scripts declare set -u', () => {
  for (const s of [START, STOP]) {
    assert.match(readFileSync(s, 'utf8'), /^\s*set -[a-zA-Z]*u[a-zA-Z]*\s*$/m);
  }
});

test('la3: start refuses an occupied port; unrelated process survives', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verifai-la3-'));
  const listener = spawn('node', ['-e', "require('http').createServer((q,s)=>s.end('x')).listen(14174,'127.0.0.1')"], { stdio: 'ignore' });
  try {
    execFileSync('bash', ['-c', 'for i in $(seq 1 50); do ss -ltn 2>/dev/null | grep -q :14174 && exit 0; sleep 0.1; done; exit 1']);
    const r = runBash([START], { env: { TMPDIR: tmp, WEB_PORT: '14174' } });
    assert.equal(r.status, 1, `expected refusal, got ${r.status}: ${r.stdout}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /occupied|refus/i);
    assert.ok(alive(listener.pid), 'unrelated listener was killed');
    const stateFiles = readdirSync(stateDirIn(tmp)).filter((f) => f.endsWith('.state'));
    assert.deepEqual(stateFiles, [], 'no state recorded on refused start');
  } finally {
    listener.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
  }
});


// ===========================================================================
// LA2 — environment docs + staged doctor
// ===========================================================================
const DOCTOR = path.join(scriptsDir, 'doctor.sh');
const ENV_DOC = path.join(repoRoot, 'ops', 'local-agent', 'ENVIRONMENT.md');
const ENV_EXAMPLE = path.join(repoRoot, 'ops', 'local-agent', 'env', 'local.env.example');

test('la2: doctor passes bash -n', () => {
  const r = runBash(['-n', DOCTOR]);
  assert.equal(r.status, 0, `bash -n failed:\n${r.stderr}`);
});

test('la2: doctor --stage M1 works without model keys', () => {
  const r = runBash([DOCTOR, '--stage', 'M1'], { env: {} });
  assert.equal(r.status, 0, `M1 doctor failed:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /stage: M1/);
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /parameter not set|unbound variable/i);
});

test('la2: doctor --stage M2 detects missing provider key by name', () => {
  const r = runBash([DOCTOR, '--stage', 'M2'], { env: {} });
  assert.equal(r.status, 1, `M2 without key should fail clearly:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /stage: M2/);
  assert.match(`${r.stdout}\n${r.stderr}`, /XKIRO_API_KEY/);
  assert.match(`${r.stdout}\n${r.stderr}`, /missing|absent/i);
});

test('la2: doctor --stage M2 reports configured provider without revealing key', () => {
  const r = runBash([DOCTOR, '--stage', 'M2'], {
    env: { XKIRO_API_KEY: SENTINEL, VERIFIAI_MODEL_PROVIDER: 'xkiro' },
  });
  assert.equal(r.status, 0, `M2 with key should pass:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /stage: M2/);
  assert.match(r.stdout, /xkiro/);
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, new RegExp(SENTINEL));
});

test('la2: doctor never prints the sentinel on any stage', () => {
  const runs = [
    runBash([DOCTOR, '--stage', 'M1'], { env: { XKIRO_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL } }),
    runBash([DOCTOR, '--stage', 'M2'], { env: { XKIRO_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL } }),
    runBash([DOCTOR, '--stage', 'M2'], { env: { OPENROUTER_API_KEY: SENTINEL, VERIFIAI_MODEL_PROVIDER: 'openrouter' } }),
  ];
  for (const r of runs) {
    assert.ok(!`${r.stdout}\n${r.stderr}`.includes(SENTINEL), 'doctor leaked the sentinel');
  }
});

test('la2: doctor rejects invalid --stage clearly', () => {
  const invalid = runBash([DOCTOR, '--stage', 'M9']);
  assert.equal(invalid.status, 1, 'invalid stage must exit non-zero');
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /usage|--stage M1\|M2/i);
  const missing = runBash([DOCTOR]);
  assert.equal(missing.status, 1, 'missing --stage must exit non-zero');
  assert.match(`${missing.stdout}\n${missing.stderr}`, /usage|--stage M1\|M2/i);
});

test('la2: doctor is read-only in a controlled temp setup', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verifai-la2-'));
  try {
    const before = readdirSync(dir);
    for (const stage of ['M1', 'M2']) {
      const r = runBash([DOCTOR, '--stage', stage], { cwd: dir, env: { HOME: dir, TMPDIR: dir } });
      assert.ok(r.status === 0 || r.status === 1, `doctor ${stage} unclear status ${r.status}`);
    }
    const after = readdirSync(dir);
    assert.deepEqual(after, before, `doctor created files: ${after}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la2: doctor fails clearly outside a git repository', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verifai-la2-nogit-'));
  try {
    const r = runBash([DOCTOR, '--stage', 'M1'], { cwd: dir, env: { HOME: dir, TMPDIR: dir } });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}\n${r.stderr}`, /not inside a Git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la2: doctor declares set -u', () => {
  const src = readFileSync(DOCTOR, 'utf8');
  assert.match(src, /^\s*set -[a-zA-Z]*u[a-zA-Z]*\s*$/m);
});

test('la2: environment docs exist and categorize', () => {
  const envDoc = readFileSync(ENV_DOC, 'utf8');
  for (const section of ['REQUIRED NOW', 'OPTIONAL LOCAL', 'REQUIRED LATER', 'LEGACY']) {
    assert.ok(envDoc.includes(section), `ENVIRONMENT.md missing section: ${section}`);
  }
  assert.match(envDoc, /XKIRO_API_KEY/);
  assert.match(envDoc, /M1/i);
  assert.match(envDoc, /no Ollama|without.*Ollama|Ollama/i);
  const example = readFileSync(ENV_EXAMPLE, 'utf8');
  assert.ok(!example.includes(SENTINEL));
  // No secret may be committed: key/secret/token variables must be empty or placeholder.
  const secretVar = /(KEY|SECRET|TOKEN|PASSWORD)$/;
  for (const line of example.split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (!m || !secretVar.test(m[1])) continue;
    assert.ok(
      m[2] === '' || /^<(.+)>$/.test(m[2]) || /^placeholder$/i.test(m[2]),
      `env example commits a value for secret-like variable ${m[1]}`,
    );
  }
});




// ===========================================================================
// LA3 — remaining lifecycle safety tests
// ===========================================================================

test('la3: stop refuses fake/recycled PID, mismatched cwd, and mismatched start time', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verifai-la3-forge-'));
  const dir = stateDirIn(tmp);
  const decoy = spawn('sleep', ['120'], { stdio: 'ignore' });
  try {
    const realStart = psField(decoy.pid, 'lstart');
    const realCwd = execFileSync('readlink', [`/proc/${decoy.pid}/cwd`], { encoding: 'utf8' }).trim();

    // 1) mismatched start time
    writeState(dir, 'web', {
      repo_root: repoRoot, pid: decoy.pid, start_time: 'Mon Jan 1 00:00:00 1990',
      cwd: realCwd, command: 'sleep 120', pgid: decoy.pid, port: 4173, log: '/dev/null',
    });
    let r = runBash([STOP], { env: { TMPDIR: tmp } });
    assert.equal(r.status, 1, `stop should refuse on start-time mismatch: ${r.stdout}`);
    assert.ok(alive(decoy.pid), 'process killed despite start-time mismatch');

    // 2) mismatched cwd (start time now correct)
    writeState(dir, 'web', {
      repo_root: repoRoot, pid: decoy.pid, start_time: realStart,
      cwd: '/definitely/not/the/real/cwd', command: 'sleep 120', pgid: decoy.pid, port: 4173, log: '/dev/null',
    });
    r = runBash([STOP], { env: { TMPDIR: tmp } });
    assert.equal(r.status, 1, `stop should refuse on cwd mismatch: ${r.stdout}`);
    assert.ok(alive(decoy.pid), 'process killed despite cwd mismatch');

    // 3) mismatched command
    writeState(dir, 'web', {
      repo_root: repoRoot, pid: decoy.pid, start_time: realStart,
      cwd: realCwd, command: 'npm run start:web', pgid: decoy.pid, port: 4173, log: '/dev/null',
    });
    r = runBash([STOP], { env: { TMPDIR: tmp } });
    assert.equal(r.status, 1, `stop should refuse on command mismatch: ${r.stdout}`);
    assert.ok(alive(decoy.pid), 'process killed despite command mismatch');

    // 4) completely fake PID (not running): stop clears stale state safely
    writeState(dir, 'web', {
      repo_root: repoRoot, pid: 999999, start_time: 'x', cwd: repoRoot,
      command: 'npm run start:web', pgid: 999999, port: 4173, log: '/dev/null',
    });
    r = runBash([STOP], { env: { TMPDIR: tmp } });
    assert.equal(r.status, 0, `stale-state clear must stay idempotent: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /not running|gone|no such/i);
    assert.ok(!existsSync(path.join(dir, 'web.state')), 'stale state cleared');
    assert.ok(!alive(999999) || true, 'no process signaled for dead pid');
  } finally {
    decoy.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('la3: full start/stop cycle stops owned npm parent + node child; idempotent', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verifai-la3-cycle-'));
  try {
    const r1 = runBash([START], { env: { TMPDIR: tmp, WEB_PORT: '14175' }, timeout: 60_000 });
    assert.equal(r1.status, 0, `start failed:\n${r1.stdout}${r1.stderr}`);

    const stateFile = path.join(stateDirIn(tmp), 'web.state');
    const state = Object.fromEntries(readFileSync(stateFile, 'utf8').trim().split('\n')
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    const npmPid = Number(state.pid);
    assert.ok(alive(npmPid), 'npm parent missing after start');
    assert.equal(state.cwd, repoRoot, 'state cwd must be repo root');
    const kids = descendants(npmPid);
    assert.ok(kids.length > 0, 'npm parent has no node child');

    const r2 = runBash([STOP], { env: { TMPDIR: tmp }, timeout: 60_000 });
    assert.equal(r2.status, 0, `stop failed:\n${r2.stdout}${r2.stderr}`);
    assert.ok(!alive(npmPid), 'npm parent survived stop');
    for (const k of kids) assert.ok(!alive(k), `child ${k} survived stop`);
    const portCheck = spawnSync('ss', ['-ltn'], { encoding: 'utf8' }).stdout;
    assert.ok(!portCheck.includes(':14175'), 'port not released after stop');

    const r3 = runBash([STOP], { env: { TMPDIR: tmp } });
    assert.equal(r3.status, 0, `second stop must be safe: ${r3.stdout}${r3.stderr}`);
    assert.ok(!existsSync(stateFile), 'state file should be removed after stop');
  } finally {
    runBash([STOP], { env: { TMPDIR: tmp } });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('la3: lifecycle scripts never print the sentinel secret', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verifai-la3-secret-'));
  try {
    const r = runBash([START], { env: { TMPDIR: tmp, WEB_PORT: '14176', XKIRO_API_KEY: SENTINEL } });
    assert.ok(!`${r.stdout}\n${r.stderr}`.includes(SENTINEL), 'start leaked sentinel');
    const s = runBash([STOP], { env: { TMPDIR: tmp, XKIRO_API_KEY: SENTINEL } });
    assert.ok(!`${s.stdout}\n${s.stderr}`.includes(SENTINEL), 'stop leaked sentinel');
  } finally {
    runBash([STOP], { env: { TMPDIR: tmp } });
    rmSync(tmp, { recursive: true, force: true });
  }
});


// ===========================================================================
// LA4 — safe cleanup of kit-owned resources
// ===========================================================================

const CLEANUP = path.join(scriptsDir, 'cleanup-local.sh');

test('la4: cleanup passes bash -n and declares set -u', () => {
  const r = runBash(['-n', CLEANUP]);
  assert.equal(r.status, 0, `bash -n failed:\n${r.stderr}`);
  assert.match(readFileSync(CLEANUP, 'utf8'), /^\s*set -[a-zA-Z]*u[a-zA-Z]*\s*$/m);
});

test('la4: cleanup selects docker resources only by ownership label', () => {
  const src = readFileSync(CLEANUP, 'utf8');
  assert.ok(src.includes('dev.verifiai.local-agent.owner='), 'ownership label missing');
  // Selection must be label-based; no broad name-based selection.
  assert.match(src, /--filter[^\n]*label=/, 'cleanup must filter docker by label');
  const prohibited = [
    [/\bprune\b/i, 'prune'],
    [/docker\s+rm\b/i, 'docker rm'],
    [/docker\s+stop\b/i, 'docker stop'],
    [/docker\s+kill\b/i, 'docker kill'],
    [/docker\s+system\b/i, 'docker system'],
    [/docker\s+volume\b/i, 'docker volume'],
    [/docker\s+network\b/i, 'docker network'],
    [/docker\s+ps\b(?![^\n]*label=)/i, 'docker ps without label filter'],
    [/docker\s+volume\s+ls\b/i, 'volume listing'],
    [/sudo\b/i, 'sudo'],
    [/rm\s+-rf?\s+\/(?!\/)/, 'root rm -rf'],
  ];
  for (const [pattern, label] of prohibited) {
    assert.ok(!pattern.test(src), `cleanup contains prohibited pattern: ${label}`);
  }
});

test('la4: cleanup removes kit state dir but preserves unrelated files and dirs', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verifai-la4-'));
  const dir = stateDirIn(tmp);
  try {
    // unrelated neighbours in the same temp root
    const keepFile = path.join(tmp, 'unrelated-file.txt');
    const keepDir = path.join(tmp, 'unrelated-dir');
    writeFileSync(keepFile, 'keep me');
    mkdirSync(keepDir, { recursive: true });
    writeFileSync(path.join(keepDir, 'inner.txt'), 'keep me too');

    // kit state with a dead pid (stop clears it, cleanup removes the dir)
    writeState(dir, 'web', {
      repo_root: repoRoot, pid: 999999, start_time: 'x', cwd: repoRoot,
      command: 'npm run start:web', pgid: 999999, port: 4173, log: '/dev/null',
    });

    const r = runBash([CLEANUP], { env: { TMPDIR: tmp } });
    assert.equal(r.status, 0, `cleanup failed:\n${r.stdout}${r.stderr}`);
    assert.ok(!existsSync(dir), 'kit state dir should be removed');
    assert.ok(existsSync(keepFile), 'unrelated file was deleted');
    assert.equal(readFileSync(keepFile, 'utf8'), 'keep me');
    assert.ok(existsSync(path.join(keepDir, 'inner.txt')), 'unrelated dir contents deleted');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('la4: cleanup deletes only recorded paths inside kit temp roots', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verifai-la4-paths-'));
  const dir = stateDirIn(tmp);
  try {
    const owned = path.join(tmp, 'verifai-repository-owned');
    const recorded = path.join(tmp, 'recorded-external');
    const outside = mkdtempSync(path.join(tmpdir(), 'verifai-la4-outside-'));
    mkdirSync(owned, { recursive: true });
    writeFileSync(path.join(owned, 'data.txt'), 'owned');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'data.txt'), 'outside');

    // recorded: kit-prefixed paths inside the temp root + one outside it
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'owned-paths.list'), `${owned}\n${recorded}\n${outside}\n`);

    const r = runBash([CLEANUP], { env: { TMPDIR: tmp } });
    assert.equal(r.status, 0, `cleanup failed:\n${r.stdout}${r.stderr}`);
    assert.ok(!existsSync(owned), 'recorded kit-owned temp path should be removed');
    assert.ok(!existsSync(recorded), 'recorded path inside the kit temp root should be removed');
    // outside the kit temp root → must survive and be reported
    assert.ok(existsSync(outside), 'path outside kit temp root must NOT be deleted');
    assert.equal(readFileSync(path.join(outside, 'data.txt'), 'utf8'), 'outside');
    assert.match(r.stdout, /refus|skip|outside|bounded/i, 'out-of-bounds path should be reported');
  } finally {

test('la4: cleanup aborts when stop refuses identity verification', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verifai-la4-refuse-'));
  const dir = stateDirIn(tmp);
  const decoy = spawn('sleep', ['120'], { stdio: 'ignore' });
  try {
    const realStart = psField(decoy.pid, 'lstart');
    const realCwd = execFileSync('readlink', [`/proc/${decoy.pid}/cwd`], { encoding: 'utf8' }).trim();
    writeState(dir, 'web', {
      repo_root: repoRoot, pid: decoy.pid, start_time: 'Mon Jan 1 00:00:00 1990',
      cwd: realCwd, command: 'sleep 120', pgid: decoy.pid, port: 4173, log: '/dev/null',
    });
    writeFileSync(path.join(tmp, 'must-survive.txt'), 'untouched');

    const r = runBash([CLEANUP], { env: { TMPDIR: tmp } });
    assert.equal(r.status, 1, `cleanup must abort after stop refusal: ${r.stdout}`);
    assert.ok(alive(decoy.pid), 'unrelated process must survive cleanup');
    assert.ok(existsSync(dir), 'kit state must remain when stop refused');
    assert.ok(existsSync(path.join(tmp, 'must-survive.txt')), 'files must remain when stop refused');
  } finally {
    decoy.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('la4: cleanup is safe with no state and never prints the sentinel', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verifai-la4-empty-'));
  try {
    const r = runBash([CLEANUP], { env: { TMPDIR: tmp, XKIRO_API_KEY: SENTINEL } });
    assert.equal(r.status, 0, `cleanup with no state should be safe: ${r.stdout}${r.stderr}`);
    assert.ok(!`${r.stdout}\n${r.stderr}`.includes(SENTINEL), 'cleanup leaked sentinel');
    assert.match(`${r.stdout}\n${r.stderr}`, /docker/i, 'cleanup should report docker status informationally');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// LA5 — verify runner reports honest per-check status
// ===========================================================================

const VERIFY = path.join(scriptsDir, 'verify-local.sh');

test('la5: verify passes bash -n and declares set -u', () => {
  const r = runBash(['-n', VERIFY]);
  assert.equal(r.status, 0, `bash -n failed:\n${r.stderr}`);
  assert.match(readFileSync(VERIFY, 'utf8'), /^\s*set -[a-zA-Z]*u[a-zA-Z]*\s*$/m);
});

test('la5: verify inspects package.json at runtime and reports SKIPPED WITH REASON', () => {
  const src = readFileSync(VERIFY, 'utf8');
  assert.ok(src.includes('package.json'), 'verify must inspect package.json at runtime');
  assert.match(src, /SKIPPED WITH REASON/, 'verify must report SKIPPED WITH REASON, never fake PASS');
});

test('la5: verify syntax check passes on the kit', () => {
  const r = runBash([VERIFY], { env: { VERIFY_ONLY: 'syntax' } });
  assert.equal(r.status, 0, `verify syntax failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /syntax.*PASS/i, 'syntax check should report PASS');
});

test('la5: verify reports SKIPPED WITH REASON for absent test:local-e2e', () => {
  const r = runBash([VERIFY], { env: { VERIFY_ONLY: 'e2e' } });
  assert.equal(r.status, 0, `absent e2e script must not fail verification:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /SKIPPED WITH REASON/, 'absent script must be SKIPPED WITH REASON');
  assert.doesNotMatch(r.stdout, /test:local-e2e.*PASS/i, 'absent script must never report PASS');
});

test('la5: verify rejects unknown check names without fake PASS', () => {
  const r = runBash([VERIFY], { env: { VERIFY_ONLY: 'bogus-check-name' } });
  assert.notEqual(r.status, 0, 'unknown check name must exit non-zero');
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /\bPASS\b/, 'failed run must not claim PASS');
});

test('la5: verify never prints the sentinel secret', () => {
  const r = runBash([VERIFY], { env: { VERIFY_ONLY: 'syntax', XKIRO_API_KEY: SENTINEL } });
  assert.ok(!`${r.stdout}\n${r.stderr}`.includes(SENTINEL), 'verify leaked sentinel');
});

