import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDemoServer } from '../scripts/serve-web.mjs';

const repositoryUrl = 'https://github.com/octocat/Hello-World.git';

test('the local repository flow clones a public GitHub repo, reads it, and cleans it up', async (context) => {
  const server = createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).service, 'verifai-local');

  const pageResponse = await fetch(baseUrl);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /id="localRepoUrl"/, 'frontend exposes a GitHub URL input');
  assert.match(page, /id="startLocalAudit"/, 'frontend exposes a start button');
  assert.match(page, /id="localRepoResult"/, 'frontend has a place to show real repository information');
  assert.match(page, /api\/local\/repositories/, 'the start button calls the local repository backend');
  assert.doesNotMatch(page, /src="\.\/app\.js"/, 'local repository checks do not load the audit prototype script');

  const cloneResponse = await fetch(`${baseUrl}/api/local/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: repositoryUrl }),
  });
  assert.equal(cloneResponse.status, 201);
  const result = await cloneResponse.json();
  assert.equal(result.repository.fullName, 'octocat/Hello-World');
  assert.equal(result.clone.success, true);
  assert.ok(result.files.count > 0);
  assert.ok(result.files.items.includes('README'));
  assert.equal(result.info.hasReadme, true);

  const gitDirectory = join(result.clone.workspacePath, '.git');
  await access(gitDirectory);
  assert.match(await readFile(join(result.clone.workspacePath, 'README'), 'utf8'), /Hello World/i);

  const cleanupResponse = await fetch(`${baseUrl}/api/local/repositories/${encodeURIComponent(result.id)}/cleanup`, { method: 'POST' });
  assert.equal(cleanupResponse.status, 200);
  assert.equal((await cleanupResponse.json()).cleaned, true);
  await assert.rejects(access(result.clone.workspacePath));
});
