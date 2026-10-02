import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDemoServer } from '../scripts/serve-web.mjs';

// Execute the delivered page, rather than asserting text in unused source files.
const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');

function openPage(hash = '') {
  const app = { innerHTML: '', classList: { add() {}, remove() {} }, offsetWidth: 0 };
  const toast = { textContent: '', classList: { add() {}, remove() {} } };
  const context = vm.createContext({
    location: { hash, hostname: '127.0.0.1', origin: 'http://127.0.0.1:4173' },
    document: {
      getElementById: id => ({ app, toast })[id] || null,
      addEventListener() {},
      title: '',
    },
    requestAnimationFrame() {},
    addEventListener() {},
    scrollTo() {},
    setTimeout,
    clearTimeout,
    clearInterval,
  });
  context.window = context;
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }
  return { app, context };
}

test('the delivered landing renders the bounded real local check', () => {
  const { app, context } = openPage();
  assert.equal(context.document.title, 'Local repository check — VERIFAI');
  assert.match(app.innerHTML, /Inspect a public GitHub repository/);
  assert.match(app.innerHTML, /id="localRepositoryForm"/);
  assert.match(app.innerHTML, /This limited check is not full verification/);
  assert.match(app.innerHTML, /id="startLocalAudit"/);
  assert.doesNotMatch(app.innerHTML, /10 \/ 10 passed|Fix Verified/);
});

test('legacy prototype hashes cannot display a verdict without executed evidence', () => {
  for (const hash of ['#/verified', '#/repair', '#/results', '#/live', '#/project']) {
    const { app, context } = openPage(hash);
    assert.equal(context.document.title, 'Local repository check — VERIFAI', hash);
    assert.match(app.innerHTML, /id="localRepositoryForm"/, hash);
    assert.doesNotMatch(app.innerHTML, /10 \/ 10 passed|Fix Verified|3 \/ 3 failed/, hash);
  }
});

test('programmatic navigation cannot resurrect retired prototype screens', () => {
  const { app, context } = openPage();
  const landing = app.innerHTML;
  context.VERIFAI.navigate('verified');
  assert.equal(app.innerHTML, landing);
  assert.equal(context.VERIFAI.state.screen, 'landing');
});

test('unused frontend assets are not served as alternate implementations', async t => {
  const server = createDemoServer({ apiOnly: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  for (const file of ['app.js', 'styles.css']) {
    assert.equal((await fetch(`${base}/${file}`)).status, 404, file);
  }
});
