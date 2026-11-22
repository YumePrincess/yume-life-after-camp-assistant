import { computed, onScopeDispose, ref, watch } from 'vue';
import { canRecallMessage, recallDeadline } from '../recall.js';

// Keep an open context menu current at the exact recall deadline, without polling.
export function useMessageRecall(message, userId) {
  const now = ref(Date.now());
  let timer = null;
  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  const stop = watch([message, userId], () => {
    clearTimer();
    now.value = Date.now();
    if (canRecallMessage(message.value, userId.value, now.value)) {
      timer = setTimeout(() => {
        now.value = Date.now();
        timer = null;
      }, recallDeadline(message.value) - now.value + 1);
    }
  }, { immediate: true });
  onScopeDispose(() => { stop(); clearTimer(); });
  return computed(() => canRecallMessage(message.value, userId.value, now.value));
}
