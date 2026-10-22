export const RECALL_WINDOW_MS = 120000;

export function recallDeadline(message) {
  const raw = String(message?.createdAt || '');
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? raw.replace(' ', 'T') + 'Z' : raw;
  return Date.parse(timestamp) + RECALL_WINDOW_MS;
}

export function canRecallMessage(message, userId, now = Date.now()) {
  if (!message || message.recalledAt || message.sender?.kind !== 'local'
      || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0
      || Number(message.sender.id) !== Number(userId)) return false;
  const deadline = recallDeadline(message);
  return Number.isFinite(deadline) && now >= deadline - RECALL_WINDOW_MS && now <= deadline;
}
