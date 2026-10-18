import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../public/js/operation-feedback.js', import.meta.url), 'utf8');
class Element {
  constructor(tag) { Object.assign(this, { tag, children: [], attributes: {}, open: false, listeners: {} }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelector(tag) { for (const child of this.children) { if (child.tag === tag) return child; const nested = child.querySelector(tag); if (nested) return nested; } return null; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.listeners.close?.(); }
  focus() {}
}
function setup(language = 'zh-cn') {
  const dialogs = [];
  const window = { YumePreferences: { getLanguageChoice: () => language, resolveLanguage: value => value } };
  runInNewContext(source, { window, document: {
    createElement: tag => new Element(tag), body: { append: node => dialogs.push(node) }
  } });
  return { api: window.MrzhFeedback, dialogs, result: () => dialogs.find(node => node.className.endsWith('--result')), progress: () => dialogs.find(node => node.className.endsWith('--progress')) };
}
describe('shared operation popup lifecycle', () => {
  it('tracks concurrent operations independently and never shows a stale progress dialog', () => {
    const ui = setup();
    const first = ui.api.begin(); const second = ui.api.begin();
    expect(ui.progress().open).toBe(true);
    ui.api.end(first); expect(ui.progress().open).toBe(true);
    ui.api.end(second); expect(ui.progress().open).toBe(false);
    ui.api.end(first); expect(ui.progress().open).toBe(false);
  });
  it('queues results, deduplicates the same pending notice, and resolves each on dismissal', async () => {
    const ui = setup();
    const first = ui.api.notice('保存成功');
    expect(ui.api.notice('保存成功')).toBe(first);
    const second = ui.api.notice('另一结果');
    expect(ui.result().querySelector('p').textContent).toBe('保存成功');
    ui.result().close(); await first;
    expect(ui.result().open).toBe(true);
    expect(ui.result().querySelector('p').textContent).toBe('另一结果');
    ui.result().close(); await second;
    expect(ui.result().open).toBe(false);
  });
  it('gives results priority over processing and resumes only unfinished operations', async () => {
    const ui = setup(); const token = ui.api.begin();
    const result = ui.api.notice('需确认的结果');
    expect(ui.progress().open).toBe(false);
    ui.api.end(token); ui.result().close(); await result;
    expect(ui.progress().open).toBe(false);
  });
  it.each([['zh-cn', '操作提示', '关闭'], ['zh-tw', '操作提示', '關閉'], ['en', 'Notice', 'Close'], ['fr', 'Information', 'Fermer'], ['ja', 'お知らせ', '閉じる']])('localizes %s controls and treats message content as text', (language, title, close) => {
    const ui = setup(language); void ui.api.notice('<img src=x onerror=alert(1)>');
    expect(ui.result().querySelector('h2').textContent).toBe(title);
    expect(ui.result().querySelector('button').textContent).toBe(close);
    expect(ui.result().querySelector('p').textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
