import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../public/js/chat-navigation.js', import.meta.url), 'utf8');

function setup(hash = '') {
  const listeners = {}, documentListeners = {}, frames = [], scrollTo = vi.fn();
  const element = () => {
    const classes = new Set();
    return { inert: false, hidden: true, attributes: {}, children: [], listeners: {}, style: { setProperty: vi.fn() },
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
      setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
      append(child) { this.children.push(child); }, addEventListener(type, listener) { this.listeners[type] = listener; },
      focus: vi.fn(), remove: vi.fn(), contentWindow: { postMessage: vi.fn() } };
  };
  const workspace = element(), main = element(), footer = element(), card = element(), body = element(), html = element();
  const location = { hash, pathname: '/', search: '', origin: 'https://camp.example', get href() { return this.origin + '/' + this.hash; } };
  const history = { state: null };
  const updateLocation = (state, _title, path) => { history.state = state; location.hash = new URL(path, location.origin).hash; };
  history.replaceState = vi.fn(updateLocation); history.pushState = vi.fn(updateLocation);
  const document = { title: '营地助手', body, documentElement: html,
    getElementById: id => ({ 'chat-workspace': workspace, 'main-content': main, 'open-chat': card })[id],
    querySelector: () => footer,
    createElement() { const frame = element(); frames.push(frame); return frame; },
    addEventListener(type, listener) { documentListeners[type] = listener; } };
  const window = { location, innerHeight: 800, scrollY: 412, scrollTo,
    addEventListener(type, listener) { listeners[type] = listener; } };
  const callbacks = { validateSession: vi.fn(async () => ({ identityCode: '12345678' })),
    onIdentityRequired: vi.fn(), onError: vi.fn(), beforeOpen: vi.fn(), translate: x => x };
  runInNewContext(source, { window, document, history });
  const api = window.MrzhChatNavigation.create(callbacks);
  async function navigate(next) { location.hash = next; await api.sync(); }
  function message(type, options = {}) { listeners.message({ origin: location.origin, source: frames.at(-1)?.contentWindow, data: { type }, ...options }); }
  return { api, callbacks, frames, workspace, main, footer, card, body, html, location, document, history,
    listeners, documentListeners, scrollTo, navigate, message, window };
}

describe('persistent #chat workspace', () => {
  it('loads one chat frame and keeps it while switching home, Back and Forward', async () => {
    const ui = setup();
    await ui.navigate('#chat');
    const frame = ui.frames[0];
    expect(frame.src).toBe('/chat/?embedded=1');
    expect(ui.workspace.hidden).toBe(false);
    expect(ui.main.inert).toBe(true);
    expect(ui.document.title).toBe('互动中心');
    await ui.navigate('');
    expect(ui.workspace.hidden).toBe(true);
    expect(ui.main.inert).toBe(false);
    expect(ui.document.title).toBe('营地助手');
    expect(ui.scrollTo).toHaveBeenLastCalledWith(0, 412);
    expect(frame.remove).not.toHaveBeenCalled();
    await ui.navigate('#chat');
    expect(ui.frames).toHaveLength(1);
    expect(ui.callbacks.validateSession).toHaveBeenCalledTimes(2);
    expect(ui.card.attributes['aria-expanded']).toBe('true');
    await ui.navigate('#vote');
    expect(ui.workspace.hidden).toBe(true);
    expect(ui.location.hash).toBe('#vote');
  });
  it('uses the hash for the card entry and accepts home only from its own same-origin frame', async () => {
    const ui = setup(); ui.api.open(); expect(ui.location.hash).toBe('chat');
    await ui.navigate('#chat');
    ui.message('camp-chat:home', { origin: 'https://evil.example' });
    expect(ui.location.hash).toBe('#chat');
    ui.message('camp-chat:home', { source: {} });
    expect(ui.location.hash).toBe('#chat');
    ui.message('camp-chat:home'); expect(ui.location.hash).toBe('');
  });
  it('does not create or expose chat without a valid identity session', async () => {
    const ui = setup(); ui.callbacks.validateSession.mockResolvedValue(null);
    await ui.navigate('#chat');
    expect(ui.frames).toHaveLength(0);
    expect(ui.callbacks.onIdentityRequired).toHaveBeenCalledOnce();
    expect(ui.location.hash).toBe('');
    expect(ui.workspace.hidden).toBe(true);
  });
  it('destroys retained chat when an identity expires, including before frame startup', async () => {
    const ui = setup(); await ui.navigate('#chat');
    ui.message('camp-chat:identity-required');
    expect(ui.frames[0].remove).toHaveBeenCalledOnce();
    expect(ui.workspace.hidden).toBe(true);
    expect(ui.main.inert).toBe(false);
    expect(ui.callbacks.onIdentityRequired).toHaveBeenCalledOnce();
  });
  it('drops the cached identity frame on logout or account changes', async () => {
    const ui = setup(); await ui.navigate('#chat'); await ui.navigate('');
    ui.documentListeners['mrzh:identitychange']({ detail: { identityCode: '' } });
    expect(ui.frames[0].remove).toHaveBeenCalledOnce();
    await ui.navigate('#chat'); expect(ui.frames).toHaveLength(2);
  });
  it('does not reopen chat if a pending identity check finishes after navigating home', async () => {
    const ui = setup(); let resolve;
    ui.callbacks.validateSession.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = ui.navigate('#chat'); await ui.navigate('');
    resolve({ identityCode: '12345678' }); await pending;
    expect(ui.frames).toHaveLength(0);
    expect(ui.workspace.hidden).toBe(true);
  });
  it('keeps the original home scroll position when Forward restores a chat history entry', async () => {
    const ui = setup(); await ui.navigate('#chat');
    const entry = ui.history.state;
    await ui.navigate('');
    ui.history.state = entry;
    ui.window.scrollY = 0;
    await ui.navigate('#chat');
    await ui.navigate('');
    expect(ui.scrollTo).toHaveBeenLastCalledWith(0, 412);
  });
  it('keeps drafts on same-identity profile refreshes from another tab', async () => {
    const ui = setup(); await ui.navigate('#chat'); await ui.navigate('');
    ui.listeners.storage({ key: 'mrzh.identity-session', newValue: JSON.stringify({ identityCode: '12345678', playerName: '新名称' }) });
    expect(ui.frames[0].remove).not.toHaveBeenCalled();
  });
  it('reports network errors without treating them as a logout', async () => {
    const ui = setup(); const error = new Error('offline'); ui.callbacks.validateSession.mockRejectedValue(error);
    await ui.navigate('#chat');
    expect(ui.callbacks.onError).toHaveBeenCalledWith(error);
    expect(ui.callbacks.onIdentityRequired).not.toHaveBeenCalled();
    expect(ui.frames).toHaveLength(0);
  });
  it('restores an interactive homepage after a direct #chat visit during initial loading', async () => {
    const ui = setup(); ui.html.classList.add('is-page-loading'); ui.main.inert = true;
    await ui.navigate('#chat'); ui.html.classList.remove('is-page-loading'); await ui.navigate('');
    expect(ui.main.inert).toBe(false);
    expect(ui.card.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it('updates the cached frame title and sends activation without reloading it', async () => {
    const ui = setup(); await ui.navigate('#chat');
    ui.message('camp-chat:ready');
    expect(ui.frames[0].contentWindow.postMessage).toHaveBeenLastCalledWith({ type: 'camp-chat:visibility', visible: true }, ui.location.origin);
    await ui.navigate('');
    expect(ui.frames[0].contentWindow.postMessage).toHaveBeenLastCalledWith({ type: 'camp-chat:visibility', visible: false }, ui.location.origin);
    ui.documentListeners['mrzh:languagechange']();
    expect(ui.frames[0].title).toBe('互动中心');
  });
});
