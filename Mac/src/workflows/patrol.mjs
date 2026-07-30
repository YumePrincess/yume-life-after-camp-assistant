import { delay } from "../process.mjs";
import { clockMinutes, reached, zonedClock } from "../clock.mjs";

export async function runPatrol(context, command, bundle, signal) {
  const { ui, vision, report } = context;
  const patrol = bundle.automationConfig.tasks.patrol;
  const timezone = bundle.automationConfig.timezone;

  await report(
    "info",
    "patrol_notice_board_first",
    "巡逻任务登录完成后直接传送公告版，再创建营地巡逻队伍"
  );
  await ui.executeFlow("teleportNoticeBoard", {}, signal);
  await createPatrolTeam(context, signal);
  await ui.keyIfAnyText(["加入队伍语音频道"], 111, signal);
  await sharePatrolTeam(context, signal);
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

  await report(
    "info",
    "patrol_team_full",
    "已确认巡逻队伍四个位置均有人，正在收起队伍界面后接取任务"
  );
  await ui.executeFlow("closeTeamPanel", {}, signal);
  await ui.executeFlow("teleportNoticeBoard", {}, signal);
  await ui.executeFlow("openPatrol", {}, signal);
  await ui.executeFlow("startHardPatrol", {}, signal);
  await ui.executeFlow("exitPatrolPages", {}, signal);
  await ui.executeFlow("switchToBookDefense", {}, signal);
  await sharePatrolTeam(context, signal);
  await ui.executeFlow("openTeamPanel", {}, signal);
  const readyAt = new Date().toISOString();
  await report("info", "patrol_ready", "困难巡逻已确认，队伍已切换为保卫古籍并分享", {
    readyAt
  });
  await context.progress(0.25, "patrol_ready");
  let nextShareAt = Date.now() + patrol.shareIntervalMinutes * 60_000;

  while (!reached(timezone, patrol.deadline)) {
    if (Date.now() >= nextShareAt) {
      await sharePatrolTeam(context, signal);
      await report("info", "patrol_share", "已再次分享到营地频道");
      nextShareAt = Date.now() + patrol.shareIntervalMinutes * 60_000;
    }
    const deadlineDelay = millisecondsUntil(timezone, patrol.deadline);
    const shareDelay = Math.max(0, nextShareAt - Date.now());
    await delay(Math.max(250, Math.min(deadlineDelay, shareDelay)), signal);
  }
  await report("info", "patrol_done", "已到巡逻任务结束时间");
}

export async function createPatrolTeam(context, signal) {
  const { config, ui, adb, vision, report } = context;
  const controls = config.patrolTeamUi;
  if (!controls) {
    throw new Error("PATROL_TEAM_UI_NOT_CONFIGURED");
  }
  const settleMs = Math.max(800, Number(controls.stepSettleMs) || 1_200);
  const sleep = context.sleep || delay;
  let screen = await capturePatrolScreen(
    vision,
    "patrol-team-entry",
    signal
  );
  if (patrolTeamCreated(vision, screen.observations, controls)) {
    await report(
      "info",
      "patrol_team_already_created",
      "已确认当前队伍目标为“营地事务>营地巡逻任务”，跳过重复创建"
    );
    return;
  }

  let menuOpen = hasTextInRegion(
    vision,
    screen.observations,
    "创建队伍",
    controls.teamMenuRegion
  );
  let creatorOpen = hasTextInRegion(
    vision,
    screen.observations,
    "队伍目标",
    controls.creatorTitleRegion
  );
  if (!menuOpen && !creatorOpen) {
    const flagReady = controls.flagReadyTexts.some((text) =>
      hasTextInRegion(
        vision,
        screen.observations,
        text,
        controls.flagReadyRegion
      )
    );
    const channelConfig = config.postLoginPromotions;
    const channelReadyCount = (
      channelConfig?.channelReadyTexts || []
    ).filter((text) =>
      hasTextInRegion(
        vision,
        screen.observations,
        text,
        channelConfig.channelReadyRegion
      )
    ).length;
    const hudReady =
      channelReadyCount >=
      Math.max(
        2,
        Number(channelConfig?.channelReadyMinimumTexts) || 2
      );
    if (!flagReady && !hudReady) {
      throw new Error(
        "PATROL_FLAG_NOT_VISIBLE: 未识别到 CtrlQ，且底部频道 HUD 锚点不足，禁止点击游戏世界"
      );
    }
    const flagClickAttempts = Math.max(
      1,
      Math.min(2, Number(controls.flagClickAttempts) || 2)
    );
    for (
      let attempt = 1;
      attempt <= flagClickAttempts;
      attempt += 1
    ) {
      await report(
        "info",
        attempt === 1
          ? "patrol_flag_click"
          : "patrol_flag_mouse_focus_retry",
        attempt === 1
          ? `已确认${flagReady ? "旗帜快捷键提示" : `底部 ${channelReadyCount} 个频道 HUD`}锚点，点击旗帜按钮 (${controls.flagButton.x},${controls.flagButton.y})；点击后以队伍界面文字确认鼠标焦点`
          : `第一次旗帜点击未出现任何队伍界面锚点，判定可能只取得了 MuMu 鼠标焦点；再次点击同一旗帜坐标 (${controls.flagButton.x},${controls.flagButton.y})`
      );
      await ui.tap(controls.flagButton, signal);
      await sleep(settleMs, signal);
      screen = await capturePatrolScreen(
        vision,
        attempt === 1
          ? "patrol-team-menu-open"
          : `patrol-team-menu-open-${attempt}`,
        signal
      );
      if (patrolTeamCreated(vision, screen.observations, controls)) {
        await report(
          "info",
          "patrol_team_already_created",
          "旗帜入口已打开现有巡逻队，确认目标正确后跳过重复创建"
        );
        return;
      }
      menuOpen = hasTextInRegion(
        vision,
        screen.observations,
        "创建队伍",
        controls.teamMenuRegion
      );
      creatorOpen = hasTextInRegion(
        vision,
        screen.observations,
        "队伍目标",
        controls.creatorTitleRegion
      );
      const anyTeamPanel = (
        controls.focusAcquiredTexts || [
          "创建队伍",
          "自动匹配",
          "暂无队员加入",
          "调整",
          "离开队伍"
        ]
      ).some((text) =>
        hasTextInRegion(
          vision,
          screen.observations,
          text,
          controls.focusAcquiredRegion ||
            { left: 0, top: 0, right: 620, bottom: 1180 }
        )
      );
      if (menuOpen || creatorOpen || anyTeamPanel) break;
    }
    if (patrolTeamCreated(vision, screen.observations, controls)) {
      await report(
        "info",
        "patrol_team_already_created",
        "旗帜入口已打开现有巡逻队，确认目标正确后跳过重复创建"
      );
      return;
    }
    const comboAttempts = Math.max(
      0,
      Math.min(2, Number(controls.comboFallbackAttempts) || 2)
    );
    for (
      let attempt = 0;
      !menuOpen && !creatorOpen && attempt < comboAttempts;
      attempt += 1
    ) {
      await report(
        "warning",
        "patrol_flag_key_fallback",
        `旗帜点击后未打开队伍入口，正在执行第 ${attempt + 1}/${comboAttempts} 次 Ctrl+Q 备用；每次按键后先识别，已打开时不再重复以免折叠`
      );
      await adb.keyCombination(
        ["KEYCODE_CTRL_LEFT", "KEYCODE_Q"],
        signal,
        { holdMs: controls.comboHoldMs || 120 }
      );
      await sleep(settleMs, signal);
      screen = await capturePatrolScreen(
        vision,
        `patrol-team-menu-key-fallback-${attempt + 1}`,
        signal
      );
      if (patrolTeamCreated(vision, screen.observations, controls)) {
        await report(
          "info",
          "patrol_team_already_created",
          "Ctrl+Q 已打开现有巡逻队，确认目标正确后跳过重复创建"
        );
        return;
      }
      menuOpen = hasTextInRegion(
        vision,
        screen.observations,
        "创建队伍",
        controls.teamMenuRegion
      );
      creatorOpen = hasTextInRegion(
        vision,
        screen.observations,
        "队伍目标",
        controls.creatorTitleRegion
      );
    }
    if (!menuOpen && !creatorOpen) {
      throw new Error(
        "PATROL_TEAM_MENU_DID_NOT_OPEN: 旗帜点击及两次 Ctrl+Q 备用后仍未识别到“创建队伍”，禁止继续点击"
      );
    }
  }

  if (!creatorOpen) {
    await report(
      "info",
      "patrol_create_menu_click",
      "已确认左侧队伍菜单打开，点击“创建队伍”"
    );
    await ui.tap(controls.createMenuPoint, signal);
    await sleep(settleMs, signal);
    screen = await capturePatrolScreen(
      vision,
      "patrol-team-creator-open",
      signal
    );
    if (
      !hasTextInRegion(
        vision,
        screen.observations,
        "队伍目标",
        controls.creatorTitleRegion
      ) ||
      !hasTextInRegion(
        vision,
        screen.observations,
        "创建队伍",
        controls.createButtonRegion
      )
    ) {
      throw new Error(
        "PATROL_TEAM_CREATOR_DID_NOT_OPEN: 未确认队伍目标创建页，禁止选择目标"
      );
    }
  }

  await ui.tap(controls.campAffairsPoint, signal);
  await sleep(settleMs, signal);
  screen = await capturePatrolScreen(
    vision,
    "patrol-camp-affairs-selected",
    signal
  );
  if (
    !hasTextInRegion(
      vision,
      screen.observations,
      "营地巡逻任务",
      controls.patrolTargetRegion
    )
  ) {
    throw new Error(
      "PATROL_TARGET_NOT_VISIBLE: 点击营地事务分类后未识别到“营地巡逻任务”"
    );
  }

  await ui.tap(controls.patrolTargetPoint, signal);
  await sleep(settleMs, signal);
  screen = await capturePatrolScreen(
    vision,
    "patrol-target-selected",
    signal
  );
  if (
    !hasTextInRegion(
      vision,
      screen.observations,
      "营地巡逻任务",
      controls.patrolTargetRegion
    ) ||
    !hasTextInRegion(
      vision,
      screen.observations,
      "创建队伍",
      controls.createButtonRegion
    )
  ) {
    throw new Error(
      "PATROL_TARGET_SELECTION_UNVERIFIED: 未确认巡逻目标和创建按钮，禁止创建"
    );
  }

  await report(
    "info",
    "patrol_create_submit",
    "已确认“营地事务>营地巡逻任务”，点击创建队伍"
  );
  await ui.tap(controls.createButtonPoint, signal);
  await sleep(settleMs, signal);
  screen = await capturePatrolScreen(
    vision,
    "patrol-team-created",
    signal
  );
  if (
    hasTextInRegion(
      vision,
      screen.observations,
      "加入队伍语音频道",
      controls.createdBodyRegion
    )
  ) {
    await adb.key(111, signal);
    await sleep(settleMs, signal);
    screen = await capturePatrolScreen(
      vision,
      "patrol-team-created-after-voice-dismiss",
      signal
    );
  }
  if (!patrolTeamCreated(vision, screen.observations, controls)) {
    throw new Error(
      "PATROL_TEAM_CREATE_UNVERIFIED: 创建后未确认“营地事务>营地巡逻任务”和队伍成员页"
    );
  }
  await report(
    "info",
    "patrol_team_created_verified",
    "已确认巡逻队创建成功，目标为“营地事务>营地巡逻任务”"
  );
}

export async function sharePatrolTeam(context, signal) {
  const { config, ui, vision, report } = context;
  const controls = config.patrolTeamUi?.share;
  if (!controls) {
    throw new Error("PATROL_SHARE_UI_NOT_CONFIGURED");
  }
  const sleep = context.sleep || delay;
  const settleMs = Math.max(150, Number(controls.stepSettleMs) || 500);
  let screen = await capturePatrolScreen(
    vision,
    "patrol-share-team-page",
    signal
  );
  const teamPageVisible = (
    controls.teamPageTexts || [
      "营地巡逻任务",
      "保卫古籍",
      "招募",
      "离开队伍"
    ]
  ).some((text) =>
    hasTextInRegion(
      vision,
      screen.observations,
      text,
      controls.teamPageRegion
    )
  );
  if (!teamPageVisible) {
    throw new Error(
      "PATROL_SHARE_TEAM_PAGE_UNVERIFIED: 未确认队伍页面，禁止点击游戏世界"
    );
  }

  const recruitAttempts = Math.max(
    1,
    Math.min(2, Number(controls.recruitAttempts) || 2)
  );
  let channelMenuVisible = false;
  for (let attempt = 1; attempt <= recruitAttempts; attempt += 1) {
    await report(
      "info",
      attempt === 1
        ? "patrol_share_recruit"
        : "patrol_share_recruit_focus_retry",
      attempt === 1
        ? "已确认队伍页面，点击“招募”"
        : "第一次点击可能只取得 MuMu 鼠标焦点；重新点击“招募”"
    );
    await ui.tap(controls.recruitPoint, signal);
    await sleep(settleMs, signal);
    screen = await capturePatrolScreen(
      vision,
      `patrol-share-channel-menu-${attempt}`,
      signal
    );
    channelMenuVisible = hasTextInRegion(
      vision,
      screen.observations,
      "营地频道",
      controls.channelMenuRegion
    );
    if (channelMenuVisible) break;
  }
  if (!channelMenuVisible) {
    throw new Error(
      "PATROL_SHARE_CHANNEL_MENU_UNVERIFIED: 点击招募后未识别到“营地频道”，未执行盲点"
    );
  }

  const channelAttempts = Math.max(
    1,
    Math.min(2, Number(controls.channelAttempts) || 2)
  );
  for (let attempt = 1; attempt <= channelAttempts; attempt += 1) {
    await report(
      "info",
      "patrol_share_camp_channel",
      `已确认分享频道列表，点击“营地频道”${attempt > 1 ? "（重试）" : ""}`
    );
    await ui.tap(controls.campChannelPoint, signal);
    await sleep(settleMs, signal);
    screen = await capturePatrolScreen(
      vision,
      `patrol-share-result-${attempt}`,
      signal
    );
    const success = (controls.successTexts || [
      "成功分享至营地频道",
      "分享成功"
    ]).some((text) =>
      hasTextInRegion(
        vision,
        screen.observations,
        text,
        controls.successRegion
      )
    );
    if (success) {
      await report(
        "info",
        "patrol_share_success",
        "已确认“成功分享至营地频道”"
      );
      return;
    }
    const menuStillOpen = hasTextInRegion(
      vision,
      screen.observations,
      "营地频道",
      controls.channelMenuRegion
    );
    if (!menuStillOpen) break;
  }
  throw new Error(
    "PATROL_SHARE_UNVERIFIED: 未识别到“成功分享至营地频道”，不会虚报分享成功"
  );
}

async function capturePatrolScreen(vision, label, signal) {
  const frame = await vision.capture(label, signal);
  let observations = frame.observations;
  if (typeof vision.captureAccurateTransient === "function") {
    const accurate = await vision
      .captureAccurateTransient(`${label}-accurate`, signal)
      .catch(() => null);
    if (accurate?.observations?.length) {
      observations = [...observations, ...accurate.observations];
    }
  }
  return { frame, observations };
}

function patrolTeamCreated(vision, observations, controls) {
  const target = hasTextInRegion(
    vision,
    observations,
    "营地巡逻任务",
    controls.createdTargetRegion
  );
  const body =
    hasTextInRegion(
      vision,
      observations,
      "等待队员加入",
      controls.createdBodyRegion
    ) ||
    hasTextInRegion(
      vision,
      observations,
      "招募",
      controls.createdBodyRegion
    ) ||
    hasTextInRegion(
      vision,
      observations,
      "离开队伍",
      controls.createdBodyRegion
    );
  return Boolean(target && body);
}

function hasTextInRegion(vision, observations, text, region) {
  const bounded = observations.filter((item) => {
    const x = item.x + item.width / 2;
    const y = item.y + item.height / 2;
    return (
      x >= region.left &&
      x <= region.right &&
      y >= region.top &&
      y <= region.bottom
    );
  });
  return Boolean(
    vision.find(bounded, text, "exact") ||
      vision.find(bounded, text, "includes")
  );
}

async function patrolTeamIsFull(context, frame, signal) {
  const { vision, report } = context;
  const fourMembers =
    vision.find(frame.observations, "4/4") ||
    vision.find(frame.observations, "队伍人数4");
  if (fourMembers) return true;
  if (vision.find(frame.observations, "等待队员加入")) return false;
  if (vision.find(frame.observations, "2D模式")) return true;
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
