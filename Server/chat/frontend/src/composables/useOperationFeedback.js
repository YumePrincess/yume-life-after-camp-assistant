import { onScopeDispose, watch } from 'vue';

export function useErrorNotice(source, options = () => ({})) {
  watch(source, message => {
    if (message) void window.MrzhFeedback.notice(message, options());
  }, { immediate: true });
}

export function useProcessingDialog(source, message, cancel) {
  let token = null;
  const finish = () => {
    if (token !== null) window.MrzhFeedback.end(token);
    token = null;
  };
  watch(source, busy => {
    finish();
    if (busy) token = window.MrzhFeedback.begin({ message: message(), cancel });
  }, { immediate: true });
  onScopeDispose(finish);
}
