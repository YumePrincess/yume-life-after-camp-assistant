import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../public/js/public.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  let passwordChangeProof ='), source.indexOf('  byId("identity-logout").addEventListener'));
function setup({ mobile = true, request = vi.fn().mockResolvedValue({ verificationToken: 'proof' }) } = {}) {
  const nodes = {};
  const events = [];
  const byId = id => nodes[id] ||= {
    open: false, hidden: false, value: '', handlers: {}, submit: { disabled: false },
    reset() { this.value = ''; }, focus: vi.fn(),
    addEventListener(type, callback) { this.handlers[type] = callback; },
    querySelector() { return this.submit; },
    showModal() { this.open = true; },
    close() { this.open = false; this.handlers.close?.(); }
  };
  const notice = vi.fn(message => events.push(`notice:${message}`));
  const clear = vi.fn(() => events.push('signed-out'));
  runInNewContext(code, {
    byId, requireIdentitySession: () => true, request,
    window: { matchMedia: () => ({ matches: mobile }), MrzhI18n: { t: value => value } },
    showOperationProgress: () => { events.push('progress:open'); return 1; },
    hideOperationProgress: () => events.push('progress:close'),
    showOperationNotice: notice, clearIdentitySession: clear
  });
  const submit = id => byId(id).handlers.submit({ preventDefault() {}, currentTarget: byId(id) });
  byId('identity-change-password').handlers.click();
  return { nodes, byId, submit, request, events, notice, clear };
}

describe('identity password change feedback and mobile focus', () => {
  it('opens on the close button on mobile, while desktop still focuses the current password', () => {
    const ui = setup();
    expect(ui.byId('identity-password-change-close').focus).toHaveBeenCalled();
    expect(ui.byId('identity-password-change-old').focus).not.toHaveBeenCalled();
    const desktop = setup({ mobile: false });
    expect(desktop.byId('identity-password-change-old').focus).toHaveBeenCalled();
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/id="identity-password-change-close"[^>]*autofocus/);
    expect(html).not.toContain('identity-password-change-feedback');
  });
  it('validates empty current passwords with a popup before making a request', async () => {
    const ui = setup();
    await ui.submit('identity-password-change-verify');
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.events).toEqual(['notice:请输入当前密码。']);
  });
  it('keeps processing visible until verification completes, then shows the result and next step without focusing an input', async () => {
    let resolve;
    const ui = setup({ request: vi.fn(() => new Promise(done => { resolve = done; })) });
    ui.byId('identity-password-change-old').value = 'test-current';
    const pending = ui.submit('identity-password-change-verify');
    expect(ui.events).toEqual(['progress:open']);
    expect(ui.byId('identity-password-change-verify').submit.disabled).toBe(true);
    resolve({ verificationToken: 'proof' });
    await pending;
    expect(ui.events).toEqual(['progress:open', 'progress:close', 'notice:验证通过，请设置新密码。']);
    expect(ui.byId('identity-password-change-set').hidden).toBe(false);
    expect(ui.byId('identity-password-change-old').value).toBe('');
    expect(ui.byId('identity-password-change-new').focus).not.toHaveBeenCalled();
    expect(JSON.parse(ui.request.mock.calls[0][1].body)).toEqual({ action: 'verify', oldPassword: 'test-current' });
  });
  it('closes processing before reporting a failed verification and keeps the first step', async () => {
    const ui = setup({ request: vi.fn().mockRejectedValue(new Error('当前密码错误')) });
    ui.byId('identity-password-change-old').value = 'incorrect';
    await ui.submit('identity-password-change-verify');
    expect(ui.events).toEqual(['progress:open', 'progress:close', 'notice:当前密码错误']);
    expect(ui.byId('identity-password-change-set').hidden).toBe(true);
  });
  it('rejects invalid new passwords with result popups and no network request', async () => {
    const ui = setup();
    ui.byId('identity-password-change-new').value = 'short';
    await ui.submit('identity-password-change-set');
    expect(ui.notice).toHaveBeenLastCalledWith('密码必须为6至32位', expect.anything());
    ui.byId('identity-password-change-new').value = 'test-new';
    ui.byId('identity-password-change-confirm').value = 'mismatch';
    await ui.submit('identity-password-change-set');
    expect(ui.notice).toHaveBeenLastCalledWith('两次输入的新密码不一致。', expect.anything());
    expect(ui.request).not.toHaveBeenCalled();
  });
  it('sends the verification proof, signs out, and closes processing before the final result', async () => {
    const ui = setup();
    ui.byId('identity-password-change-old').value = 'test-current';
    await ui.submit('identity-password-change-verify');
    ui.events.length = 0;
    ui.byId('identity-password-change-new').value = 'test-new';
    ui.byId('identity-password-change-confirm').value = 'test-new';
    await ui.submit('identity-password-change-set');
    expect(JSON.parse(ui.request.mock.calls[1][1].body)).toEqual({ action: 'set', verificationToken: 'proof', newPassword: 'test-new' });
    expect(ui.events).toEqual(['progress:open', 'signed-out', 'progress:close', 'notice:密码修改成功，请重新登录。']);
    expect(ui.clear).toHaveBeenCalledTimes(1);
    expect(ui.byId('identity-password-change-dialog').open).toBe(false);
  });
  it('ignores verification results for a closed dialog and still clears processing', async () => {
    let resolve;
    const ui = setup({ request: vi.fn(() => new Promise(done => { resolve = done; })) });
    ui.byId('identity-password-change-old').value = 'test-current';
    const pending = ui.submit('identity-password-change-verify');
    ui.byId('identity-password-change-dialog').close();
    resolve({ verificationToken: 'stale' });
    await pending;
    expect(ui.events).toEqual(['progress:open', 'progress:close']);
    expect(ui.byId('identity-password-change-set').hidden).toBe(true);
  });
});
