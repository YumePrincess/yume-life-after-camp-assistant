export function formatMediaTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}

export function mediaSeekTime(value, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1000, Math.max(0, Number(value) || 0)) / 1000 * duration;
}
