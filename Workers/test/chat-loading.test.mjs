import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../public/js/loading.js', import.meta.url), 'utf8');

function setup(language = 'en') {
  const classes = new Set();
  const node = () => ({ hidden: true, textContent: '', style: {}, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; }, addEventListener: vi.fn() });
  const selectors = ['[role="progressbar"]', '.page-loading-bar', '.page-loading-percent', '.page-loading-percent-contrast', '.page-loading-title', '.page-loading-message', '.page-loading-actions', '[data-loading-retry]', '[data-loading-home]'];
  const elements = Object.fromEntries(selectors.map(key => [key, node()]));
  const overlay = { ...node(), hidden: false, classList: { add: key => classes.add(key) },
    querySelector: key => elements[key] || null, contains: () => false };
  const app = { inert: true, removeAttribute(key) { if (key === 'inert') this.inert = false; } };
  const timers = [], reload = vi.fn();
  const document = {
    body: { classList: { contains: key => key === 'chat-page' } },
    documentElement: { classList: { add: vi.fn(), remove: vi.fn() } },
    getElementById: id => id === 'page-loading' ? overlay : id === 'app' ? app : null,
    // The shared loader executes before the later #app element is parsed.
    querySelectorAll: () => [], querySelector: () => null,
    readyState: 'complete', images: [], fonts: { ready: Promise.resolve() },
  };
  const window = { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: vi.fn(), location: { reload },
    YumePreferences: { getLanguageChoice: () => language, resolveLanguage: choice => choice } };
  vm.runInNewContext(source, { window, document, getComputedStyle: () => ({ backgroundImage: 'none' }) });
  return { window, app, classes, elements, timers, reload, settle: name => window.MrzhLoading.settle(name) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('interaction center startup loading screen', () => {
  it('waits for the first rendered view after authentication and conversation data are ready', async () => {
    const h = setup();
    h.settle('identity'); h.settle('data'); await flush();
    expect(h.elements['[role="progressbar"]'].attributes['aria-valuenow']).toBe('90');
    expect(h.app.inert).toBe(true);
    expect(h.classes.has('is-complete')).toBe(false);
    h.settle('view');
    expect(h.elements['[role="progressbar"]'].attributes['aria-valuenow']).toBe('100');
    expect(h.app.inert).toBe(false);
    expect(h.classes.has('is-complete')).toBe(true);
  });
  it('does not reveal an empty app while conversations are pending', async () => {
    const h = setup();
    h.settle('identity'); h.settle('view'); await flush();
    expect(h.classes.has('is-complete')).toBe(false);
    h.settle('data'); await flush();
    expect(h.classes.has('is-complete')).toBe(true);
  });
  it('keeps the overlay on startup failure with retry and home actions', async () => {
    const h = setup(); h.window.MrzhLoading.fail();
    for (const key of ['identity', 'data', 'view']) h.settle(key);
    await flush();
    expect(h.classes.has('is-complete')).toBe(false);
    expect(h.app.inert).toBe(true);
    expect(h.elements['.page-loading-actions'].hidden).toBe(false);
    expect(h.elements['.page-loading-message'].textContent).toContain('Unable to load');
    h.timers.find(timer => timer.delay === 20000).callback();
    expect(h.elements['.page-loading-message'].textContent).toContain('Unable to load');
    h.elements['[data-loading-retry]'].addEventListener.mock.calls[0][1]();
    expect(h.reload).toHaveBeenCalledOnce();
  });
  it('allows a slow request to finish after showing recovery controls', async () => {
    const h = setup(); h.timers.find(timer => timer.delay === 20000).callback();
    expect(h.elements['.page-loading-actions'].hidden).toBe(false);
    expect(h.elements['.page-loading-message'].textContent).toContain('longer than expected');
    for (const key of ['identity', 'view', 'data']) h.settle(key);
    await flush(); expect(h.classes.has('is-complete')).toBe(true);
  });
  it.each([['zh-cn', '互动中心'], ['zh-tw', '互動中心'], ['en', 'Interaction Center'], ['ja', '交流センター'], ['fr', 'Centre d’interaction']])('uses the homepage %s preference before the app bundle is ready', (language, title) => {
    const h = setup(language);
    expect(h.elements['.page-loading-title'].textContent).toBe(title);
    expect(h.elements['[data-loading-home]'].textContent).not.toBe('');
    expect(h.elements['[role="progressbar"]'].attributes['aria-label']).not.toBe('');
  });
});
