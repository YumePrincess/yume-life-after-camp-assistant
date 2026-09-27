import { delay } from "./process.mjs";

// All task list pages use this gesture so diagnostics and production keep the
// same calibrated endpoints, move sequence, and fallback behavior.
export const TABLE_PAGE_SPEED_FACTOR = 0.42;
// 34ms is 30% shorter than the former 48ms interval while retaining the same
// 10px move segments and exact release point to avoid skipping rows.
export const TABLE_MOTION_MIN_INTERVAL_MS = 34;

export function scaledTableSwipeDurationMs(value, fallback = 1_000) {
  const configured = Number(value);
  return Math.max(
    100,
    Math.round(
      (Number.isFinite(configured) && configured > 0 ? configured : fallback) *
        TABLE_PAGE_SPEED_FACTOR
    )
  );
}

export async function memberAlignmentSwipe(adb, from, to, durationMs, signal) {
  if (typeof adb.shell !== "function") {
    await adb.mouseSwipe(from, to, durationMs, signal);
    return false;
  }
  const distance = Math.abs(Number(to.y) - Number(from.y));
  const steps = Math.max(2, Math.ceil(distance / 10));
  const intervalMs = Math.max(
    TABLE_MOTION_MIN_INTERVAL_MS,
    Math.round(durationMs / steps)
  );
  const shellMotion = async (action, y) => {
    await adb.shell(
      ["input", "mouse", "motionevent", action, Math.round(from.x), Math.round(y)],
      { signal, timeoutMs: 5_000 }
    );
  };
  try {
    await shellMotion("DOWN", from.y);
    for (let step = 1; step <= steps; step += 1) {
      await delay(intervalMs, signal);
      const progress = step / steps;
      await shellMotion("MOVE", from.y + (to.y - from.y) * progress);
    }
    await delay(intervalMs, signal);
    await shellMotion("UP", to.y);
    return false;
  } catch (error) {
    // Some MuMu/Android images allow input swipe but reject shell-level
    // mouse motionevent injection with INJECT_EVENTS. A touch gesture remains
    // a safe fallback for the same calibrated page endpoints.
    if (
      typeof adb.touchSwipe !== "function" ||
      !/INJECT_EVENTS|Injecting to another application|SecurityException/i.test(
        String(error?.message || error)
      )
    ) {
      throw error;
    }
    await adb.touchSwipe(from, to, durationMs, signal);
    return true;
  }
}
