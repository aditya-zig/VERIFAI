// A very small DOM for the delivered single-file app.
//
// The page is one HTML file with an inline script, so the tests drive the real
// script: the harness only supplies the browser APIs the script touches
// (elements, events, location, fetch). Assertions are made on the markup the
// app renders, not on the source text.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const PAGE_URL = new URL('../apps/web/index.html', import.meta.url);
export const pageHtml = await readFile(PAGE_URL, 'utf8');
export const pageScript = pageHtml.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];

const camel = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { for (const name of names) this.names.add(name); }
  remove(...names) { for (const name of names) this.names.delete(name); }
  contains(name) { return this.names.has(name); }
  toggle(name) { if (this.names.has(name)) this.names.delete(name); else this.names.add(name); }
}

export class FakeElement {
  constructor(doc, options = {}) {
    this.doc = doc;
    this.id = options.id || '';
    this.tagName = options.tagName || 'div';
    this.attributes = { ...(options.attributes || {}) };
    this.dataset = {};
    for (const [key, value] of Object.entries(this.attributes)) {
      if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = value;
    }
    this.classList = new FakeClassList();
    this.value = options.value ?? (options.attributes && options.attributes.value) ?? '';
    this.disabled = false;
    this._innerHTML = '';
    this.textContent = '';
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); this.doc.onMarkup(this, this._innerHTML); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value);
  }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelector(selector) { return this.doc.querySelector(selector); }
  closest(selector) { return this.doc.closest(this, selector); }
  focus() { this.doc.focused = this; }
  addEventListener() {}
  removeEventListener() {}
  requestSubmit() { this.doc.dispatch('submit', { target: this, preventDefault() {} }); }
}

export class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.derived = new Set();
    this.fixed = new Set();
    this.listeners = new Map();
    this.title = '';
    this.focused = null;
    this.app = this.register('app', { fixed: true });
    this.register('toast', { fixed: true });
    this.register('appAnnouncement', { fixed: true });
  }
  register(id, options = {}) {
    const element = new FakeElement(this, { id, ...options });
    this.elements.set(id, element);
    if (options.fixed) this.fixed.add(id);
    else this.derived.add(id);
    return element;
  }
  onMarkup(element) {
    if (element !== this.app) return;
    for (const id of this.derived) this.elements.delete(id);
    this.derived.clear();
  }
  getElementById(id) {
    if (this.fixed.has(id)) return this.elements.get(id);
    const existing = this.elements.get(id);
    if (existing) return existing;
    for (const element of this.elements.values()) {
      const tag = collectTags(element.innerHTML || '').find(entry => entry.attributes.id === id);
      if (tag) return this.register(id, { attributes: tag.attributes, tagName: tag.tagName });
    }
    return null;
  }
  querySelector(selector) {
    if (selector.startsWith('#')) return this.getElementById(selector.slice(1));
    const attribute = selector.match(/^\[([a-zA-Z-]+)="([^"]*)"\]$/);
    if (attribute) return this.findByAttribute(attribute[1], attribute[2]);
    return null;
  }
  closest(element, selector) {
    if (selector.startsWith('#')) return element.id === selector.slice(1) ? element : null;
    const withValue = selector.match(/^\[([a-zA-Z-]+)="([^"]*)"\]$/);
    if (withValue) return element.getAttribute(withValue[1]) === withValue[2] ? element : null;
    const presence = selector.match(/^\[([a-zA-Z-]+)\]$/);
    if (presence) return element.getAttribute(presence[1]) != null ? element : null;
    return null;
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatch(type, event) {
    const handler = this.listeners.get(type);
    if (!handler) return false;
    handler(event);
    return true;
  }
  findByAttribute(name, value) {
    for (const element of this.elements.values()) {
      const tag = collectTags(element.innerHTML || '').find(entry => entry.attributes[name] === value);
      if (tag) return new FakeElement(this, { id: tag.attributes.id || '', tagName: tag.tagName, attributes: tag.attributes });
    }
    return null;
  }
  findAllByAttribute(name, value) {
    const found = [];
    for (const element of this.elements.values()) {
      for (const tag of collectTags(element.innerHTML || '')) {
        if (tag.attributes[name] === value) found.push(tag);
      }
    }
    return found;
  }
}

export function collectTags(markup, tagName) {
  const tags = [];
  const name = tagName || '[a-zA-Z][a-zA-Z0-9-]*';
  const pattern = new RegExp('<(' + name + ')((?:\\s+[a-zA-Z-]+(?:="[^"]*")?)*)\\s*\\/?>', 'g');
  let match;
  while ((match = pattern.exec(markup))) {
    const attributes = {};
    const attributePattern = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let attributeMatch;
    while ((attributeMatch = attributePattern.exec(match[2]))) attributes[attributeMatch[1]] = attributeMatch[2] ?? '';
    tags.push({ tagName: match[1], attributes, markup: match[0] });
  }
  return tags;
}

export function openApp({ hash = '', fetchImpl } = {}) {
  const doc = new FakeDocument();
  const calls = [];
  const fetchStub = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    const response = await fetchImpl(url, options, calls.length);
    return response;
  };
  const location = { hash, hostname: '127.0.0.1', origin: 'http://127.0.0.1:4173' };
  const context = vm.createContext({
    document: doc,
    location,
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: () => {},
    scrollTo: () => {},
    addEventListener: () => {},
  });
  context.window = context;
  vm.runInContext(pageScript, context);
  return { doc, context, calls, location };
}

export async function waitFor(predicate, { timeoutMs = 4000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  return predicate();
}

export function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}
