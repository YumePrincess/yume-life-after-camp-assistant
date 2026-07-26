export function createRoutineWorkflow(workflows) {
  return async function runAutomationRoutine(context, command, bundle, signal) {
    const routine = command.payload?.detail?.routine;
    if (!routine?.groups?.length) throw new Error("例程没有可执行步骤");
    for (let groupIndex = 0; groupIndex < routine.groups.length; groupIndex += 1) {
      const group = routine.groups[groupIndex];
      await context.report(
        "info",
        "routine_group",
        `例程“${routine.name}”开始第 ${groupIndex + 1} 组：${group.join(" + ")}`
      );
      const combinedPatrolBrick =
        group.includes("patrol") && group.includes("brick_transport");
      const executable = combinedPatrolBrick
        ? group.filter((task) => task !== "brick_transport")
        : group;
      if (group.length > 1 && !combinedPatrolBrick) {
        await context.report(
          "warning",
          "routine_serialized",
          "同组任务共享一个 MuMu 界面，已按配置顺序安全串行；巡逻＋搬砖是当前可协同执行的组合"
        );
      }
      for (const taskKey of executable) {
        const workflow = workflows[taskKey];
        if (!workflow) throw new Error(`例程包含未知动作：${taskKey}`);
        await workflow(context, command, bundle, signal);
      }
    }
  };
}
