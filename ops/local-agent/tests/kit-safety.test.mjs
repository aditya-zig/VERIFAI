import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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



