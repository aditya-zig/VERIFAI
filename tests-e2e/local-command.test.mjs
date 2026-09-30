import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectCommand, executeCommand } from '../services/local-command.mjs';
import { createDemoServer } from '../scripts/serve-web.mjs';

test('a fast package script produces real captured execution evidence', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'verifai-command-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  const command = await selectCommand(cwd, ['package.json']);
  const evidence = await executeCommand(cwd, command);
  assert.equal(evidence.command, 'node --version');
  assert.equal(evidence.exitCode, 0);
  assert.match(evidence.stdout, /^v\d+\.\d+\.\d+\n$/);
  assert.equal(evidence.stderr, '');
  assert.ok(evidence.durationMs >= 0);
  assert.equal(evidence.status, 'Completed');
});

test('one real API model finding is attached to the actual fixture command output', async (t) => {
  const { auditRepository } = await import('../services/local-audit.mjs');
  const cwd = await mkdtemp(join(tmpdir(), 'verifai-command-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  const result = await auditRepository({ repository: { fullName: 'local/command-fixture' },
    clone: { workspacePath: cwd }, files: { items: ['package.json'] } });
  assert.equal(result.execution.exitCode, 0);
  assert.match(result.execution.stdout, /^v\d+\.\d+\.\d+\n$/);
  assert.deepEqual(result.finding.evidence.execution, result.execution);
  assert.ok(result.finding.description.length > 0);
  assert.equal(result.status, 'Completed');
});

test('public GitHub clone -> real command -> one API finding -> UI wiring -> cleanup', async (t) => {
  const server = createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/local/repositories`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://github.com/octocat/Hello-World' }) });
  assert.equal(response.status, 201);
  const clone = await response.json();
  t.after(() => fetch(`${base}/api/local/repositories/${clone.id}/cleanup`, { method: 'POST' }).catch(() => {}));
  const audited = await fetch(`${base}/api/local/repositories/${clone.id}/audit`, { method: 'POST' });
  assert.equal(audited.status, 200);
  const result = await audited.json();
  assert.equal(result.status, 'Completed', JSON.stringify(result));
  assert.equal(result.execution.command, 'git -c core.fsmonitor=false ls-files --error-unmatch -- README');
  assert.equal(result.execution.exitCode, 0);
  assert.equal(result.execution.stdout, 'README\n');
  assert.equal(result.execution.stderr, '');
  assert.deepEqual(result.finding.evidence.execution, result.execution);
  assert.ok(clone.files.items.includes(result.finding.evidence.file));
  const html = await (await fetch(base)).text();
  assert.match(html, /id="localExecutionEvidence"/);
  assert.match(html, /execution\.stdout/);
  const cleanup = await fetch(`${base}/api/local/repositories/${clone.id}/cleanup`, { method: 'POST' });
  assert.equal(cleanup.status, 200);
  await assert.rejects(access(clone.clone.workspacePath));
});
