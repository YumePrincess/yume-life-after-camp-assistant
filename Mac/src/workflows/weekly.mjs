export async function runWeeklySchedule(context, command, bundle, signal) {
  const schedule = command.payload?.detail?.weeklySchedule || bundle.weeklySchedule;
  const { ui, report } = context;
  await ui.executeFlow("teleportSpecialInfected", {}, signal);
  await ui.executeFlow("openWeeklySchedule", { schedule }, signal);
  await report(
    "info",
    "weekly_done",
    `已应用 ${schedule.events.length} 项感染者日程设置`
  );
}
