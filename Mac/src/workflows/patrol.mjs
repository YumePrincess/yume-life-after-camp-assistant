import { delay } from "../process.mjs";
import { inside, reached } from "../clock.mjs";
import { center } from "../vision.mjs";
import { runBrickTransport } from "./brick.mjs";

export async function runPatrol(context, command, bundle, signal) {
  const { ui, vision, report } = context;
  const patrol = bundle.automationConfig.tasks.patrol;
  const brick = bundle.automationConfig.tasks.brick_transport;
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
    const fourMembers =
      vision.find(frame.observations, "4/4") ||
      vision.find(frame.observations, "队伍人数4");
    if (fourMembers && reached(timezone, patrol.teamReadyTime)) break;
    await delay(patrol.chatPollSeconds * 1000, signal);
  }

  await ui.executeFlow("teleportNoticeBoard", {}, signal);
  await ui.executeFlow("openPatrol", {}, signal);
  await ui.executeFlow("startHardPatrol", {}, signal);
  await ui.executeFlow("switchToBookDefense", {}, signal);
  await ui.executeFlow("shareTeam", {}, signal);
  await ui.executeFlow("openTeamPanel", {}, signal);
  const readyAt = new Date().toISOString();
  await report("info", "patrol_ready", "困难巡逻已确认，队伍已切换为保卫古籍并分享", {
    readyAt
  });
  await context.progress(0.25, "patrol_ready");
  let nextShareAt = Date.now() + patrol.shareIntervalMinutes * 60_000;
  let lastCleanupFingerprint = "";
  const teamCommandState = {
    handledAt: new Map()
  };

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
      const match = await scanPatrolCommands(
        context,
        lastCleanupFingerprint,
        teamCommandState,
        signal
      );
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
    const commandMatch = await scanPatrolCommands(
      context,
      lastCleanupFingerprint,
      teamCommandState,
      signal
    );
    const fingerprint = commandMatch
      ? `${commandMatch.text}:${commandMatch.x}:${commandMatch.y}`
      : "";
    if (fingerprint) lastCleanupFingerprint = fingerprint;
    await delay(patrol.chatPollSeconds * 1000, signal);
  }
  await report("info", "patrol_done", "已到巡逻任务结束时间");
}

async function scanPatrolCommands(
  context,
  previousFingerprint,
  teamCommandState,
  signal
) {
  const { ui, vision, report } = context;
  await ui.executeFlow("openTeamPanel", {}, signal);
  const frame = await vision.captureTransient("patrol-team-barrage", signal);
  const slotCommand = findTeamSlotCommand(frame.observations);
  if (slotCommand) {
    const cooldownMs =
      Math.max(
        5,
        Number(context.config.patrolTeam?.kickCommandCooldownSeconds) || 60
      ) * 1000;
    const previous = teamCommandState.handledAt.get(slotCommand.text) || 0;
    if (Date.now() - previous >= cooldownMs) {
      teamCommandState.handledAt.set(slotCommand.text, Date.now());
      if (slotCommand.slot === 1) {
        await report(
          "warning",
          "patrol_kick_refused",
          "已拒绝 T1 指令：1 号位是队长/本机角色"
        );
      } else {
        await kickTeamSlot(context, slotCommand.slot, frame.observations, signal);
      }
    }
  }
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

function findTeamSlotCommand(observations) {
  return observations
    .map((observation) => ({
      observation,
      normalized: String(observation.text).replace(/\s+/g, "").toUpperCase()
    }))
    .map(({ observation, normalized }) => {
      const match = normalized.match(/^T([1-8])$/);
      return match
        ? {
            text: `T${match[1]}`,
            slot: Number(match[1]),
            observation
          }
        : null;
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.observation.confidence - a.observation.confidence ||
        b.observation.width * b.observation.height -
          a.observation.width * a.observation.height
    )[0];
}

async function kickTeamSlot(context, slotNumber, observations, signal) {
  const { ui, vision, report } = context;
  const slot = context.config.patrolTeam?.slots?.find(
    (item) => Number(item.number) === slotNumber
  );
  if (!slot) {
    await report("error", "patrol_kick_invalid_slot", `未配置 T${slotNumber} 槽位`);
    return;
  }
  const empty = observations.some((observation) => {
    if (!String(observation.text).replace(/\s+/g, "").includes("等待队员加入")) {
      return false;
    }
    const point = center(observation);
    return point.x >= slot.left && point.x < slot.right;
  });
  if (empty) {
    await report(
      "warning",
      "patrol_kick_empty_slot",
      `已忽略 T${slotNumber}：对应队伍位置为空`
    );
    return;
  }

  await ui.tap(slot, signal);
  const menu = await vision.captureTransient(`patrol-kick-slot-${slotNumber}`, signal);
  const kickAction = ["请离队伍", "请离", "移出队伍", "踢出队伍"]
    .map((text) => vision.find(menu.observations, text))
    .filter(Boolean)
    .sort((a, b) => center(b).y - center(a).y)[0];
  if (!kickAction) {
    await report(
      "warning",
      "patrol_kick_action_missing",
      `T${slotNumber} 已定位槽位，但未识别到弹出列表最下方的红色请离按钮`
    );
    return;
  }
  await ui.tap(center(kickAction), signal);
  const afterKickAction = await vision.captureTransient(
    `patrol-kick-confirm-${slotNumber}`,
    signal
  );
  const confirm = vision.find(afterKickAction.observations, "确定", "exact");
  if (confirm) {
    await ui.tap(center(confirm), signal);
  }
  await report(
    "info",
    "patrol_kick_done",
    confirm
      ? `已按 T${slotNumber} 指令确认请离 ${slotNumber} 号队员`
      : `已按 T${slotNumber} 指令点击最下方红色按钮请离 ${slotNumber} 号队员`
  );
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
