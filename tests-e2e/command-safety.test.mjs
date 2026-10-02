import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectCommand, executeCommand, runOwnedProcess } from '../services/local-command.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'verifai-command-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('arbitrary shell, model argv, installs, pipes and hooks are rejected before spawn', async (t) => {
  const cwd = await fixture(t);
  for (const script of ['rm -rf .', 'curl https://example.com', 'node --version | cat', 'npm install', 'node server.js', 'node --version &']) {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: script } }));
    await assert.rejects(selectCommand(cwd, ['package.json']), /no supported safe command/);
  }
  await assert.rejects(executeCommand(cwd, { executable: 'sh', args: ['-c', 'echo forbidden'] }), /Blocked command/);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --version', pretest: 'touch forbidden' } }));
  const selected = await selectCommand(cwd, ['package.json']);
  assert.equal((await executeCommand(cwd, selected)).exitCode, 0);
  await assert.rejects(readFile(join(cwd, 'forbidden')));
});

test('syntax check runs inside cloned cwd and captures a real failed check', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --check bad.js' } }));
  await writeFile(join(cwd, 'bad.js'), 'const = ;\n');
  const evidence = await executeCommand(cwd, await selectCommand(cwd, ['package.json', 'bad.js']));
  assert.equal(evidence.exitCode, 1);
  assert.match(evidence.stderr, /SyntaxError/);
  assert.equal(evidence.stdout, '');
  assert.equal(evidence.status, 'Failed');
});

test('symlinked or escaping files cannot become executable check input', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --check escape.js' } }));
  await symlink('/etc/passwd', join(cwd, 'escape.js'));
  await assert.rejects(selectCommand(cwd, ['package.json', 'escape.js']), /no supported safe command/);
  await assert.rejects(executeCommand(cwd, { executable: 'node', args: ['--check', '../outside.js'], file: '../outside.js' }), /Blocked command/);
});

test('timeout kills the entire owned process group and returns Incomplete', async (t) => {
  const cwd = await fixture(t);
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  const result = await runOwnedProcess(process.execPath, ['-e', script], { cwd, timeoutMs: 400 });
  assert.equal(result.status, 'Incomplete');
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
  const pids = JSON.parse(await readFile(join(cwd, 'pids.json'), 'utf8'));
  for (const pid of pids) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '), `owned pid ${pid} is not running`);
  }
});

test('output is byte-capped and API credentials and NODE_OPTIONS never enter child env', async (t) => {
  const cwd = await fixture(t);
  const result = await runOwnedProcess(process.execPath, ['-e', `console.log(JSON.stringify(Object.keys(process.env)));process.stdout.write('x'.repeat(40000)+'TAIL');process.stderr.write('y'.repeat(40000)+'END');`], { cwd });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 8192);
  assert.ok(Buffer.byteLength(result.stderr) <= 8192);
  assert.ok(result.stdout.endsWith('TAIL'));
  assert.ok(result.stderr.endsWith('END'));
  const environment = await runOwnedProcess(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], { cwd });
  const keys = JSON.parse(environment.stdout);
  assert.ok(!keys.some((key) => /KEY|TOKEN|SECRET|NODE_OPTIONS/.test(key)));
});
