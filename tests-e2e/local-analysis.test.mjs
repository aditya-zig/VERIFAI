import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDemoServer } from '../scripts/serve-web.mjs';

const repositoryUrl = 'https://github.com/octocat/Hello-World.git';
const severities = new Set(['critical', 'high', 'medium', 'low', 'info']);
const fixturePhrases = ['mock finding', 'test finding', 'example vulnerability', 'lorem ipsum'];

test('legacy analysis HTTP endpoint returns a real cloned-source model finding and preserves explicit cleanup', async (context) => {
  const server = createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.shutdown());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // The supported UI uses the master audit endpoint (local-audit.test.mjs).
  // These retained legacy endpoints are exercised behaviorally, not by
  // looking for obsolete JavaScript route strings in the landing page.

  const cloneResponse = await fetch(`${baseUrl}/api/local/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: repositoryUrl }),
  });
  assert.equal(cloneResponse.status, 201);
  const clone = await cloneResponse.json();
  assert.equal(clone.repository.fullName, 'octocat/Hello-World');

  await access(join(clone.clone.workspacePath, '.git'));
  const readme = await readFile(join(clone.clone.workspacePath, 'README'), 'utf8');
  assert.match(readme, /Hello World/i);

  const analyzeResponse = await fetch(
    `${baseUrl}/api/local/repositories/${encodeURIComponent(clone.id)}/analyze`,
    { method: 'POST' },
  );
  assert.equal(analyzeResponse.status, 200);
  const analysis = await analyzeResponse.json();

  const finding = analysis.finding;
  assert.equal(typeof finding?.title, 'string');
  assert.ok(finding.title.trim().length > 0, 'finding has a title');
  assert.ok(severities.has(String(finding.severity).toLowerCase()), 'finding has a real severity');
  assert.equal(typeof finding?.description, 'string');
  assert.ok(finding.description.trim().length > 0, 'finding has a description');
  assert.equal(typeof finding?.evidence?.file, 'string');
  assert.ok(finding.evidence.file.length > 0, 'finding cites an evidence file');
  assert.ok(
    clone.files.items.includes(finding.evidence.file),
    'the evidence file comes from the cloned repo file list',
  );
  await access(join(clone.clone.workspacePath, finding.evidence.file));

  const lowered = `${finding.title} ${finding.description}`.toLowerCase();
  for (const phrase of fixturePhrases) {
    assert.ok(!lowered.includes(phrase), `finding is not the fixture phrase: ${phrase}`);
  }

  assert.equal(typeof analysis?.model?.provider, 'string');
  assert.ok(analysis.model.provider.length > 0, 'response names the model provider');
  assert.equal(typeof analysis?.model?.model, 'string');
  assert.ok(analysis.model.model.length > 0, 'response names the model');
  assert.ok(
    !/mock|fake|fixture|hardcode/i.test(`${analysis.model.provider} ${analysis.model.model}`),
    'the model is not a mock label',
  );

  const cleanupResponse = await fetch(
    `${baseUrl}/api/local/repositories/${encodeURIComponent(clone.id)}/cleanup`,
    { method: 'POST' },
  );
  assert.equal(cleanupResponse.status, 200);
  assert.equal((await cleanupResponse.json()).cleaned, true);
  await assert.rejects(access(clone.clone.workspacePath));
});
