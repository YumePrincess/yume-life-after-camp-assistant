import { delay } from "../process.mjs";
import { inside } from "../clock.mjs";

export async function runBrickTransport(
  context,
  command,
  bundle,
  signal,
  afterCycle = async () => {}
) {
  const task = bundle.automationConfig.tasks.brick_transport;
  const timezone = bundle.automationConfig.timezone;
  const manual = command.payload?.triggerMode === "manual";
  const manualCycles = Math.max(
    1,
    Math.min(20, Number(command.payload?.detail?.maxCycles) || 1)
  );
  const manualWaitSeconds = Math.max(
    30,
    Math.min(600, Number(command.payload?.detail?.maxWaitSeconds) || 180)
  );
  let cycles = 0;
  const shouldContinue = () =>
    manual ? cycles < manualCycles : inside(timezone, task.time, task.stop);

  brickCycles: while (shouldContinue()) {
    await context.ui.executeFlow(
      "brickNavigateFurnitureStore",
      { cycle: cycles + 1 },
      signal
    );
    const waitDeadline = manual
      ? Date.now() + manualWaitSeconds * 1000
      : Number.POSITIVE_INFINITY;
    while (true) {
      try {
        await context.ui.executeFlow(
          "brickWaitAndPick",
          { cycle: cycles + 1 },
          signal
        );
        break;
      } catch (error) {
        if (signal.aborted) throw signal.reason || error;
        if (!/OCR could not find|Timed out|timeout/i.test(error.message)) {
          throw error;
        }
        if (!manual && !inside(timezone, task.time, task.stop)) {
          break brickCycles;
        }
        if (manual && Date.now() >= waitDeadline) {
          throw new Error(`等待家具店砖块刷新超过 ${manualWaitSeconds} 秒`);
        }
        await context.report(
          "info",
          "brick_wait_refresh",
          "家具店气球旁暂未发现可搬建材，保持原地并等待左右砖块刷新",
          { reason: error.message }
        );
        await delay(3_000, signal);
      }
    }

    await context.report(
      "info",
      "brick_picked",
      `第 ${cycles + 1} 轮已搬起建材，正在后退进入喷泉光圈`
    );
    await context.ui.executeFlow(
      "brickCarryAndDrop",
      { cycle: cycles + 1 },
      signal
    );
    cycles += 1;
    await context.report("info", "brick_cycle", `完成第 ${cycles} 轮搬砖`);
    await afterCycle();
  }
  await context.report(
    "info",
    "brick_done",
    manual
      ? `手动搬砖任务结束，共完成 ${cycles} 轮`
      : `搬砖时间窗结束，共完成 ${cycles} 轮`
  );
}
