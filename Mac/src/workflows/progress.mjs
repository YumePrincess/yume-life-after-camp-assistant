export async function updateWorkflowProgress(context, value, step) {
  if (typeof context?.progress !== "function") return;
  if (value === null || value === undefined) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  await context.progress(
    Math.min(0.99, Math.max(0.02, numeric)),
    step
  );
}

export function progressForRange(start, end, completed, total) {
  const lower = Number(start);
  const upper = Number(end);
  const count = Math.max(1, Number(total) || 1);
  const done = Math.min(count, Math.max(0, Number(completed) || 0));
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  return lower + ((upper - lower) * done) / count;
}

export function progressRangeSlice(range, startFraction, endFraction = 1) {
  if (!range) return undefined;
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const lower = Math.min(1, Math.max(0, Number(startFraction) || 0));
  const upper = Math.min(1, Math.max(lower, Number(endFraction) || 0));
  return {
    ...range,
    start: progressForRange(start, end, lower, 1),
    end: progressForRange(start, end, upper, 1)
  };
}
