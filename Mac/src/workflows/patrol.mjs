import { delay } from "../process.mjs";
import { reached } from "../clock.mjs";
import { center } from "../vision.mjs";

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
    handledAt: new Map(),
    chatFingerprint: ""
  };
  teamCommandState.chatFingerprint = await readCampChatFingerprint(
    context,
    signal
  );
  await ui.executeFlow("openTeamPanel", {}, signal);
  await report(
    "info",
    "patrol_chat_baseline",
    "已记录古籍队伍分享后的营地频道基线；只处理此后出现的新复制指令"
  );

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
  const copied = await copyNewestPatrolCommand(
    context,
    teamCommandState,
    signal
  );
  await ui.executeFlow("openTeamPanel", {}, signal);
  if (copied) {
    const cooldownMs =
      Math.max(
        5,
        Number(context.config.patrolTeam?.kickCommandCooldownSeconds) || 60
      ) * 1000;
    const previous = teamCommandState.handledAt.get(copied.text) || 0;
    if (Date.now() - previous >= cooldownMs) {
      teamCommandState.handledAt.set(copied.text, Date.now());
      if (copied.refused) {
        await report(
          "warning",
          "patrol_kick_refused",
          `已拒绝 ${copied.text}：指令不得包含 1 号位，1 号位是队长/本机角色`
        );
      } else {
        await report(
          "info",
          "patrol_kick_plan",
          `${copied.text} 将按 ${copied.slots.join(" → ")} 的倒序请离，避免后续队员前移导致错踢`
        );
        for (const slotNumber of copied.slots) {
          await kickTeamSlot(context, slotNumber, signal);
        }
      }
    }
  }
  const frame = await vision.captureTransient("patrol-team-barrage", signal);
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

export function parsePatrolKickCommand(value) {
  const normalized = String(value || "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "")
    .toUpperCase();
  const match = normalized.match(/^T([1-8]+)$/);
  if (!match) return null;
  const digits = [...match[1]].map(Number);
  if (digits.includes(1)) {
    return {
      text: normalized,
      slots: [],
      refused: true
    };
  }
  const slots = [...new Set(digits)]
    .filter((slot) => slot >= 2 && slot <= 8)
    .sort((left, right) => right - left);
  if (!slots.length) return null;
  return {
    text: normalized,
    slots,
    refused: false
  };
}

export function descendingTeamSlots(value) {
  const command = parsePatrolKickCommand(value);
  return command && !command.refused ? command.slots : [];
}

async function kickTeamSlot(context, slotNumber, signal) {
  const { ui, vision, report } = context;
  const slot = context.config.patrolTeam?.slots?.find(
    (item) => Number(item.number) === slotNumber
  );
  if (!slot) {
    await report("error", "patrol_kick_invalid_slot", `未配置 T${slotNumber} 槽位`);
    return;
  }
  await ui.executeFlow("openTeamPanel", {}, signal);
  const layout = await vision.captureTransient(
    `patrol-kick-layout-${slotNumber}`,
    signal
  );
  const observations = layout.observations;
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

async function readCampChatFingerprint(context, signal) {
  const { ui, vision } = context;
  await ui.executeFlow("openCampChat", {}, signal);
  const frame = await vision.captureTransient("patrol-camp-chat-baseline", signal);
  return campChatFingerprint(
    frame.observations,
    context.config.patrolTeam?.chat?.messageRegion
  );
}

async function copyNewestPatrolCommand(context, state, signal) {
  const { ui, vision, adb, report } = context;
  const chat = context.config.patrolTeam?.chat;
  if (!chat?.messageRegion) {
    await report(
      "error",
      "patrol_chat_uncalibrated",
      "未配置营地聊天消息区域，已跳过本轮 T 指令扫描"
    );
    return null;
  }
  await ui.executeFlow("openCampChat", {}, signal);
  const frame = await vision.captureTransient("patrol-camp-chat", signal);
  const fingerprint = campChatFingerprint(
    frame.observations,
    chat.messageRegion
  );
  if (fingerprint === state.chatFingerprint) return null;
  state.chatFingerprint = fingerprint;

  const candidates = messageCandidatePoints(
    frame.observations,
    chat.messageRegion,
    chat.fallbackMessagePoints,
    chat.maximumCandidates
  );
  for (const [index, point] of candidates.entries()) {
    await ui.tap(point, signal);
    const contextMenu = await vision.captureTransient(
      `patrol-chat-context-${index + 1}`,
      signal
    );
    const copy = ["复制", "复制消息"]
      .map((label) => vision.find(contextMenu.observations, label))
      .find(Boolean);
    if (!copy) {
      await ui.tap(chat.dismissContextPoint, signal);
      continue;
    }
    await ui.tap(center(copy), signal);
    const clipboard = await adb.readHostClipboard(signal).catch(() => "");
    const command = parsePatrolKickCommand(clipboard);
    if (command) {
      await report(
        "info",
        "patrol_chat_command_copied",
        `已从营地消息“复制”读取指令 ${command.text}`,
        { clipboard: command.text, slots: command.slots }
      );
      return command;
    }
  }
  return null;
}

function campChatFingerprint(observations, region) {
  if (!region) return "";
  return observations
    .filter((item) => {
      const point = center(item);
      return (
        point.x >= region.left &&
        point.x <= region.right &&
        point.y >= region.top &&
        point.y <= region.bottom
      );
    })
    .map(
      (item) =>
        `${String(item.text).trim()}:${Math.round(center(item).x / 12)}:${Math.round(
          center(item).y / 12
        )}`
    )
    .sort()
    .join("|");
}

function messageCandidatePoints(
  observations,
  region,
  fallbackPoints = [],
  maximumCandidates = 6
) {
  const excluded =
    /^(?:营地频道|成员|频道|私聊|世界|队伍|营地|萌芽邀请|聊天室|当前|场景|回归|同城|扬声器|收起)$/;
  const points = observations
    .filter((item) => {
      const point = center(item);
      return (
        point.x >= region.left &&
        point.x <= region.right &&
        point.y >= region.top &&
        point.y <= region.bottom &&
        !excluded.test(String(item.text).replace(/\s+/g, ""))
      );
    })
    .map(center)
    .sort((left, right) => right.y - left.y);
  for (const point of fallbackPoints || []) points.push(point);
  const unique = [];
  for (const point of points) {
    if (
      unique.some(
        (current) =>
          Math.abs(current.x - point.x) < 80 &&
          Math.abs(current.y - point.y) < 55
      )
    ) {
      continue;
    }
    unique.push(point);
    if (unique.length >= Math.max(1, Number(maximumCandidates) || 6)) break;
  }
  return unique;
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
