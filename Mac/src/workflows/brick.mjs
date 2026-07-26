import { inside } from "../clock.mjs";

export async function runBrickTransport(
  context,
  _command,
  bundle,
  signal,
  afterCycle = async () => {}
) {
  const task = bundle.automationConfig.tasks.brick_transport;
  const timezone = bundle.automationConfig.timezone;
  let cycles = 0;
  while (inside(timezone, task.time, task.stop)) {
    await context.ui.executeFlow("brickTransportCycle", {}, signal);
    cycles += 1;
    await context.report("info", "brick_cycle", `完成第 ${cycles} 轮搬砖`);
    await afterCycle();
  }
  await context.report("info", "brick_done", `搬砖时间窗结束，共完成 ${cycles} 轮`);
}
