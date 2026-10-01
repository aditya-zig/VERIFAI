import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const RESULT_HELPERS = [
  'escapeHtml', 'resultTone', 'factTone', 'resultBadge', 'chip', 'monoChip',
  'fact', 'factGrid', 'evidenceCard', 'sandboxDisplay', 'hashChip',
];

const PAGE_URL = new URL('../apps/web/index.html', import.meta.url);

export async function loadResultPage() {
  const html = await readFile(PAGE_URL, 'utf8');
  const body = html.match(/function renderMasterAudit\(run, host\) \{([\s\S]*?)\n  \}/)?.[1];
  if (!body) throw new Error('master renderer missing from apps/web/index.html');
  const sources = RESULT_HELPERS.map(name => functionSource(html, name));
  return {
    html,
    body,
    // The real helpers, extracted from the page, so a refactor cannot silently
    // drift away from what the tests exercise.
    script: `${sources.join('\n\n')}\nfunction renderMasterAudit(run,host){${body}\n}\nrenderMasterAudit(run,host);`,
  };
}

export function functionSource(html, name) {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} exists in the result page`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    const char = html[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

export function renderWithHelpers(page, run) {
  const host = { innerHTML: '', querySelector: () => null };
  vm.runInNewContext(page.script, { run, host });
  return host.innerHTML;
}
