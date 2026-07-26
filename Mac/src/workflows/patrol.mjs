import { delay } from "../process.mjs";
import { inside, reached } from "../clock.mjs";
import { runBrickTransport } from "./brick.mjs";

export async function runPatrol(context, command, bundle, signal) {
  const { ui, vision, report } = context;
  const patrol = bundle.automationConfig.tasks.patrol;
  const brick = bundle.automationConfig.tasks.brick_transport;
  const timezone = bundle.automationConfig.timezone;

  await ui.executeFlow("teleportNoticeBoard", {}, signal);
  await ui.executeFlow("openPatrol", {}, signal);
  await ui.executeFlow("createPatrolTeam", {}, signal);
  await ui.executeFlow("shareTeam", {}, signal);
  await report("info", "patrol_team", "巡逻队伍已创建并分享到营地频道");

  while (true) {
    if (reached(timezone, patrol.deadline)) {
      throw new Error("巡逻截止前队伍人数仍未达到 4 人");
    }
    await ui.executeFlow("openTeamPanel", {}, signal);
    const frame = await vision.capture("patrol-team-size", signal);
    const fourMembers =
      vision.find(frame.observations, "4/4") ||
      vision.find(frame.observations, "队伍人数4");
    if (fourMembers && reached(timezone, patrol.teamReadyTime)) break;
    await delay(patrol.chatPollSeconds * 1000, signal);
  }

  await ui.executeFlow("startHardPatrol", {}, signal);
  await ui.executeFlow("switchToBookDefense", {}, signal);
  await ui.executeFlow("shareTeam", {}, signal);
  const readyAt = new Date().toISOString();
  await report("info", "patrol_ready", "困难巡逻已确认，队伍已切换为保卫古籍并分享", {
    readyAt
  });
  await context.progress(0.25, "patrol_ready");
  let nextShareAt = Date.now() + patrol.shareIntervalMinutes * 60_000;
  let lastCleanupFingerprint = "";

  if (
    brick.enabled &&
    brick.inlineWithPatrol &&
    inside(timezone, brick.time, brick.latestStart)
  ) {
    await runBrickTransport(context, command, bundle, signal, async () => {
      if (Date.now() >= nextShareAt) {
        await ui.executeFlow("shareTeam", {}, signal);
        await report("info", "patrol_share", "搬砖期间已再次分享到营地频道");
        nextShareAt = Date.now() + patrol.shareIntervalMinutes * 60_000;
      }
      const match = await scanCampChat(context, lastCleanupFingerprint, signal);
      if (match) {
        lastCleanupFingerprint = `${match.text}:${match.x}:${match.y}`;
      }
    });
  } else if (brick.enabled && reached(timezone, brick.latestStart)) {
    await report("warning", "brick_skipped", "巡逻队伍未在最晚时间前就绪，今日不执行搬砖");
  }

  while (!reached(timezone, patrol.deadline)) {
    if (Date.now() >= nextShareAt) {
      await ui.executeFlow("shareTeam", {}, signal);
      await report("info", "patrol_share", "已再次分享到营地频道");
      nextShareAt = Date.now() + patrol.shareIntervalMinutes * 60_000;
    }
    const commandMatch = await scanCampChat(context, lastCleanupFingerprint, signal);
    const fingerprint = commandMatch
      ? `${commandMatch.text}:${commandMatch.x}:${commandMatch.y}`
      : "";
    if (fingerprint) lastCleanupFingerprint = fingerprint;
    await delay(patrol.chatPollSeconds * 1000, signal);
  }
  await report("info", "patrol_done", "已到巡逻任务结束时间");
}

async function scanCampChat(context, previousFingerprint, signal) {
  const { ui, vision } = context;
  await ui.executeFlow("openCampChat", {}, signal);
  const frame = await vision.capture("camp-chat", signal);
  const commandMatch = vision.find(frame.observations, "清理巡逻队");
  const fingerprint = commandMatch
    ? `${commandMatch.text}:${commandMatch.x}:${commandMatch.y}`
    : "";
  if (commandMatch && fingerprint !== previousFingerprint) {
    await cleanupPatrolTeam(context, signal);
    return commandMatch;
  }
  return null;
}

async function cleanupPatrolTeam(context, signal) {
  const { ui, vision, adb, report } = context;
  await ui.executeFlow("openTeamPanel", {}, signal);
  const frame = await vision.capture("patrol-progress", signal);
  if (vision.find(frame.observations, "已完成")) {
    await ui.executeFlow("kickCompletedMembers", {}, signal);
  }
  await ui.executeFlow("openCampChat", {}, signal);
  await adb.typeUnicode("清理已完成", signal);
  await adb.key(66, signal);
  await report("info", "patrol_cleanup", "已处理已完成但未退出的队员，并回复营地频道");
}
