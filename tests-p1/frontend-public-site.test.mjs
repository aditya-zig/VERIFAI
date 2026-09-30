import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8').catch(() => '');
const css = await readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8').catch(() => '');
const js = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8').catch(() => '');

test('public landing describes the supported limited local check without verification claims', () => {
  // M1/M2 replaced the marketing/swarm entry with the real local product.
  const landing = html.match(/function renderLocalLanding\(\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(landing, 'local landing renderer exists');
  assert.match(landing, /Inspect a public GitHub repository/);
  assert.match(landing, /localRepositoryFormMarkup\(\)/);
  assert.match(landing, /one safe command/);
  assert.match(landing, /one AI call/);
  assert.match(landing, /No installs, repair or pull requests/);
  assert.doesNotMatch(landing, /Start Verification|Fix verified|10 \/ 10/);
  assert.match(html, /This limited check is not full verification/);
});

test('frontend is wired to the real Deep Audit endpoint and live run state', () => {
  assert.match(js, /\/api\/audits/);
  assert.match(js, /fetchSwarm/);
  assert.match(js, /applySwarm/);
  assert.match(js, /\/swarm/);
  assert.match(js, /\/steer/);
  assert.match(js, /runFlagshipAudit/);
  assert.match(js, /runResult/);
  assert.match(js, /REAL SWARM/);
});

test('motion system includes scroll, connector, counter, typing, sticky and reduced-motion behavior', () => {
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /data-counter/);
  assert.match(js, /typeStatus/);
  assert.match(css, /stroke-dasharray/);
  assert.match(css, /position:\s*sticky/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@keyframes\s+cursorMove/);
});

test('responsive rules explicitly redesign mobile workflow layouts', () => {
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.hero-graph/);
  assert.match(css, /grid-template-columns:\s*1fr/);
  assert.match(css, /overflow-x:\s*hidden/);
});


test('live audit UI never turns worker completion or prototype controls into fake verification', () => {
  assert.doesNotMatch(js, /task\.state==='completed'\?'Verified'/);
  assert.doesNotMatch(js, /Payment-timeout experiment replayed\./);
  assert.match(js, /report\?\.findingState\|\|'Completed'/);
  assert.match(js, /Preview only — run Deep Audit for executed payment-timeout evidence\./);
  assert.doesNotMatch(html, /Pull request #82 created from verifiai\/fix-payment-timeout/);
  assert.match(html, /Prototype control only — a real PR unlocks only after independent verification\./);
  assert.match(html, /Illustrative product preview — run Deep Audit for executed evidence\./);
});
