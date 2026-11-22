import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useErrorNotice, useProcessingDialog } from '../chat/frontend/src/composables/useOperationFeedback.js';
afterEach(() => vi.unstubAllGlobals());
function setup() {
  let token = 0;
  const api = { notice: vi.fn(), begin: vi.fn(() => ++token), end: vi.fn() };
  vi.stubGlobal('window', { MrzhFeedback: api });
  return { api, scope: effectScope() };
}
describe('chat operation feedback', () => {
  it('shows an error popup, supports retry actions, and stops observing after leaving the page', async () => {
    const ui = setup(); const error = ref(''); const retry = vi.fn();
    ui.scope.run(() => useErrorNotice(error, () => ({ actions: [{ label: 'Retry', run: retry }] })));
    error.value = 'Upload failed'; await nextTick();
    expect(ui.api.notice).toHaveBeenCalledWith('Upload failed', { actions: [{ label: 'Retry', run: retry }] });
    error.value = ''; await nextTick(); error.value = 'Upload failed'; await nextTick();
    expect(ui.api.notice).toHaveBeenCalledTimes(2);
    ui.scope.stop(); error.value = 'Stale failure'; await nextTick();
    expect(ui.api.notice).toHaveBeenCalledTimes(2);
  });
  it('closes processing after completion and on unmount, keeping operation tokens separate', async () => {
    const ui = setup(); const busy = ref(false); const cancel = vi.fn();
    ui.scope.run(() => useProcessingDialog(busy, () => 'Loading editor', cancel));
    busy.value = true; await nextTick();
    expect(ui.api.begin).toHaveBeenCalledWith({ message: 'Loading editor', cancel });
    busy.value = false; await nextTick(); expect(ui.api.end).toHaveBeenCalledWith(1);
    busy.value = true; await nextTick(); ui.scope.stop();
    expect(ui.api.end.mock.calls.map(([token]) => token)).toEqual([1, 2]);
  });
});
