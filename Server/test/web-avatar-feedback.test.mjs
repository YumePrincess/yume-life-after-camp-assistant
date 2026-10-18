import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../public/js/identity-avatar.js', import.meta.url), 'utf8');
function setup(save = vi.fn().mockResolvedValue(undefined)) {
  const nodes = []; const events = [];
  const window = { MrzhI18n: { t: value => value }, MrzhFeedback: {
    notice: message => events.push(`notice:${message}`),
    begin: () => { events.push('processing'); return 1; }, end: () => events.push('done')
  } };
  runInNewContext(source, { window,
    document: { createElement: tag => {
      const node = { tag, children: [], listeners: {},
        append(...nodes) { this.children.push(...nodes); },
        setAttribute() {}, showModal() {}, remove() {},
        addEventListener(type, callback) { this.listeners[type] = callback; },
        close() { this.listeners.close?.(); },
        getContext: () => ({ clearRect() {}, drawImage() {} }),
        toBlob: callback => callback({ type: 'image/webp' })
      };
      nodes.push(node); return node;
    }, body: { append() {} } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Image: class { width = 512; height = 512; decode() { return Promise.resolve(); } }
  });
  window.MrzhAvatar.open(save);
  return { nodes, events, chooser: nodes.find(node => node.type === 'file'), save: nodes.find(node => node.textContent === '保存头像') };
}
describe('avatar operation popups', () => {
  it('shows invalid file errors in a popup without inserting an error line', async () => {
    const ui = setup();
    ui.chooser.files = [{ type: 'image/gif', size: 100 }]; await ui.chooser.onchange();
    expect(ui.events).toEqual(['notice:请选择5MB以内的PNG、JPEG或WebP图片']);
    expect(ui.nodes.filter(node => node.tag === 'p').map(node => node.textContent)).toEqual(['AVATAR', '拖动图片调整位置，使用滑块缩放。']);
  });
  it.each([false, true])('closes processing before reporting avatar upload result (failure: %s)', async fails => {
    const save = fails ? vi.fn().mockRejectedValue(new Error('Upload failed')) : vi.fn().mockResolvedValue(undefined);
    const ui = setup(save);
    ui.chooser.files = [{ type: 'image/png', size: 100 }]; await ui.chooser.onchange();
    await ui.save.onclick();
    expect(ui.events).toEqual(['processing', 'done', fails ? 'notice:Upload failed' : 'notice:头像已更新。']);
    expect(ui.chooser.disabled).toBe(false);
  });
});
