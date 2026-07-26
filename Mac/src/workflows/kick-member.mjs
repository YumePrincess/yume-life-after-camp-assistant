export async function runKickMember(context, command, _bundle, signal) {
  requireKickCalibration(context);
  const memberName = command.payload?.detail?.memberName;
  if (
    typeof memberName !== "string" ||
    !memberName.trim() ||
    command.payload?.detail?.destructiveConfirmation !== true
  ) {
    throw new Error("踢出成员任务缺少经过后台二次确认的精确成员姓名");
  }
  const { ui, vision, adb, config, report } = context;
  await ui.executeFlow("teleportCityHall", {}, signal);
  await ui.executeFlow("navigateToSandTable", {}, signal);
  await ui.executeFlow("openActivity", {}, signal);
  await kickExactMember(context, memberName, signal);
  await context.api.snapshot(
    command.runId,
    "departed",
    [memberName],
    new Date().toISOString(),
    signal
  );
}

export async function runKickInactiveMembers(context, command, _bundle, signal) {
  requireKickCalibration(context);
  const memberNames = command.payload?.detail?.memberNames;
  if (
    !Array.isArray(memberNames) ||
    !memberNames.length ||
    command.payload?.detail?.destructiveConfirmation !== true
  ) {
    throw new Error("自动斩杀任务缺少最新精确名单或确认标记");
  }
  await context.ui.executeFlow("teleportCityHall", {}, signal);
  await context.ui.executeFlow("navigateToSandTable", {}, signal);
  await context.ui.executeFlow("openActivity", {}, signal);
  const departed = [];
  for (const [index, memberName] of memberNames.entries()) {
    if (index > 0) {
      await context.ui.executeFlow("resetActivityList", {}, signal);
    }
    try {
      await kickExactMember(context, memberName, signal);
      departed.push(memberName);
    } catch (error) {
      if (!error.message.startsWith("未在最新活跃名单中精确找到成员")) throw error;
      departed.push(memberName);
      await context.report(
        "warning",
        "kick_member_already_departed",
        `${memberName} 已不在最新游戏名单中，跳过指纹并从当前展示名单移除`
      );
    }
  }
  await context.api.snapshot(
    command.runId,
    "departed",
    departed,
    new Date().toISOString(),
    signal
  );
}

function requireKickCalibration(context) {
  if (context.config.memberKick?.enabled !== true) {
    throw new Error(
      "踢出成员的最终指纹坐标尚未由管理员指定测试玩家完成实机验收；已安全阻止执行"
    );
  }
}

async function kickExactMember(context, memberName, signal) {
  const { ui, vision, adb, config, report } = context;
  let found = null;
  for (let page = 0; page < config.tables.activity.pagination.maxPages; page += 1) {
    const frame = await vision.capture(`kick-find-${page + 1}`, signal);
    found = vision.find(frame.observations, memberName, "exact");
    if (found) {
      await ui.tap(
        { x: found.x + found.width / 2, y: found.y + found.height / 2 },
        signal
      );
      break;
    }
    await adb.mouseSwipe(
      config.tables.activity.pagination.from,
      config.tables.activity.pagination.to,
      config.tables.activity.pagination.durationMs,
      signal
    );
    await ui.afterAction(signal);
  }
  if (!found) throw new Error(`未在最新活跃名单中精确找到成员：${memberName}`);

  await ui.clickText("踢出营地", { mode: "exact", timeoutSeconds: 12 }, signal);
  await ui.clickText("确定", { mode: "exact", timeoutSeconds: 12 }, signal);
  await report(
    "warning",
    "kick_fingerprint",
    `即将为 ${memberName} 执行最终指纹确认`
  );
  await ui.tap(config.memberKick.finalFingerprint, signal);
  await ui.waitAnyText(
    ["已踢出营地", "营地资料", "全部成员"],
    { timeoutSeconds: 15 },
    signal
  );
  await report("info", "kick_done", `已完成踢出营地流程：${memberName}`);
}
