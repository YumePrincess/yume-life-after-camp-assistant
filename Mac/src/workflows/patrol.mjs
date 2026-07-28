import { delay } from "../process.mjs";
import { clockMinutes, reached, zonedClock } from "../clock.mjs";

export async function runPatrol(context, command, bundle, signal) {
  const { ui, vision, report } = context;
  const patrol = bundle.automationConfig.tasks.patrol;
  const timezone = bundle.automationConfig.timezone;

  await ui.executeFlow("createPatrolTeam", {}, signal);
  await ui.keyIfAnyText(["加入队伍语音频道"], 111, signal);
  await ui.executeFlow("shareTeam", {}, signal);
  await report("info", "patrol_team", "巡逻队伍已创建并分享到营地频道");

  while (true) {
    if (reached(timezone, patrol.deadline)) {
      throw new Error("巡逻截止前队伍人数仍未达到 4 人");
    }
    await ui.executeFlow("openTeamPanel", {}, signal);
    const frame = await vision.capture("patrol-team-size", signal);
    if (
      (await patrolTeamIsFull(context, frame, signal)) &&
      reached(timezone, patrol.teamReadyTime)
    ) {
      break;
    }
    await delay(Math.max(1, Number(patrol.chatPollSeconds) || 2) * 1000, signal);
  }

  await ui.executeFlow("teleportNoticeBoard", {}, signal);
  await ui.executeFlow("openPatrol", {}, signal);
  await ui.executeFlow("startHardPatrol", {}, signal);
  await ui.executeFlow("exitPatrolPages", {}, signal);
  await ui.executeFlow("switchToBookDefense", {}, signal);
  await ui.executeFlow("shareTeam", {}, signal);
  await ui.executeFlow("openTeamPanel", {}, signal);
  const readyAt = new Date().toISOString();
  await report("info", "patrol_ready", "困难巡逻已确认，队伍已切换为保卫古籍并分享", {
    readyAt
  });
  await context.progress(0.25, "patrol_ready");
  let nextShareAt = Date.now() + patrol.shareIntervalMinutes * 60_000;

  while (!reached(timezone, patrol.deadline)) {
    if (Date.now() >= nextShareAt) {
      await ui.executeFlow("shareTeam", {}, signal);
      await report("info", "patrol_share", "已再次分享到营地频道");
      nextShareAt = Date.now() + patrol.shareIntervalMinutes * 60_000;
    }
    const deadlineDelay = millisecondsUntil(timezone, patrol.deadline);
    const shareDelay = Math.max(0, nextShareAt - Date.now());
    await delay(Math.max(250, Math.min(deadlineDelay, shareDelay)), signal);
  }
  await report("info", "patrol_done", "已到巡逻任务结束时间");
}

async function patrolTeamIsFull(context, frame, signal) {
  const { vision, report } = context;
  const fourMembers =
    vision.find(frame.observations, "4/4") ||
    vision.find(frame.observations, "队伍人数4");
  if (fourMembers) return true;
  if (vision.find(frame.observations, "等待队员加入")) return false;
  if (!vision.advisor?.enabled) return false;

  const advice = await vision
    .adviseCurrent(
      "patrol-team-full-advisor",
      {
        expectedState: "patrol_team_full,patrol_team_waiting",
        taskHint: "确认当前4人巡逻队是否四个位置都已有玩家",
        ocrTexts: frame.observations.map((item) => item.text)
      },
      signal
    )
    .catch(() => null);
  const minimum =
    Number(vision.advisor.config.minimumActionConfidence) || 0.95;
  const accepted =
    advice?.state === "patrol_team_full" &&
    Number(advice.confidence) >= minimum;
  await report(
    "info",
    "patrol_ai_team_decision",
    `巡逻 AI 辅助判断：${advice?.state || "unavailable"}`,
    { ...advice, accepted }
  );
  return accepted;
}

function millisecondsUntil(timezone, value) {
  const now = zonedClock(timezone);
  const seconds =
    (clockMinutes(value) - now.minute) * 60 - now.second;
  return Math.max(250, seconds * 1000);
}
