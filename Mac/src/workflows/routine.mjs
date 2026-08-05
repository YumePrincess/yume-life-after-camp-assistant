export function createRoutineWorkflow(workflows) {
  return async function runAutomationRoutine(context, command, bundle, signal) {
  const routine = command.payload?.detail?.routine;
  if (!routine?.groups?.length) throw new Error("例程没有可执行步骤");
  const taskCount = Math.max(
    1,
    routine.groups.reduce((count, group) => count + group.length, 0)
  );
  let taskIndex = 0;
  for (let groupIndex = 0; groupIndex < routine.groups.length; groupIndex += 1) {
      const group = routine.groups[groupIndex];
      await context.report(
        "info",
        "routine_group",
        `例程“${routine.name}”开始第 ${groupIndex + 1} 组：${group.join(" + ")}`
      );
      if (group.length > 1) {
        await context.report(
          "warning",
          "routine_serialized",
          "同组任务共享一个 MuMu 界面，已按配置顺序安全串行"
        );
      }
      for (const taskKey of group) {
        const workflow = workflows[taskKey];
        if (!workflow) throw new Error(`例程包含未知动作：${taskKey}`);
        const currentTaskIndex = taskIndex;
        taskIndex += 1;
        const routineContext = {
          ...context,
          progress: async (value, step) => {
            const local = Math.min(
              1,
              Math.max(0, (Number(value) - 0.02) / 0.98)
            );
            const routineProgress =
              0.02 + ((currentTaskIndex + local) / taskCount) * 0.96;
            await context.progress(routineProgress, step);
          }
        };
        await workflow(routineContext, command, bundle, signal);
        await context.progress(
          0.02 + ((currentTaskIndex + 1) / taskCount) * 0.96,
          "routine_task_complete"
        );
      }
    }
  };
}
