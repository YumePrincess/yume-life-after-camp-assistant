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

  let consecutiveFullTeamFrames = 0;
  while (true) {
    if (reached(timezone, patrol.deadline)) {
      throw new Error("巡逻截止前队伍人数仍未达到 4 人");
    }
    let screen = await capturePatrolScreen(
      vision,
      "patrol-team-size",
      signal
    );
    if (!patrolTeamPanelVisible(vision, screen.observations, context.config)) {
      await report(
        "info",
        "patrol_team_panel_reopen",
        "当前未识别到队伍卡片页，正在重新打开队伍界面"
      );
      await ui.executeFlow("openTeamPanel", {}, signal);
      screen = await capturePatrolScreen(
        vision,
        "patrol-team-size-after-open",
        signal
      );
    }
    const full = await patrolTeamIsFull(
      context,
      screen.frame,
      signal,
      screen.observations
    );
    consecutiveFullTeamFrames = full
      ? consecutiveFullTeamFrames + 1
      : 0;
    if (
      consecutiveFullTeamFrames >= 2 &&
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
  await report(
    "info",
    "patrol_notice_board_reused",
    "队伍等待期间角色没有移动；收起队伍后直接使用初始公告版位置，不再执行任何传送"
  );
  await ui.executeFlow("openPatrol", {}, signal);
  await ui.executeFlow("startHardPatrol", {}, signal);
  await ui.executeFlow("exitPatrolPages", {}, signal);
  await ui.executeFlow("openTeamPanel", {}, signal);
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
  const createMenuWaitMs = Math.max(
    5_000,
    Number(controls.createMenuWaitMs) || 5_000
  );
  const patrolTargetWaitMs = Math.max(
    5_000,
    Number(controls.patrolTargetWaitMs) || 5_000
  );
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

  let createMenuMatch = findTextInRegion(
    vision,
    screen.observations,
    "创建队伍",
    controls.teamMenuRegion
  );
  let menuOpen = Boolean(createMenuMatch);
  let creatorOpen = patrolCreatorOpen(
    vision,
    screen.observations,
    controls
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
      await tapPatrolHud(ui, controls.flagButton, signal);
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
      createMenuMatch = findTextInRegion(
        vision,
        screen.observations,
        "创建队伍",
        controls.teamMenuRegion
      );
      menuOpen = Boolean(createMenuMatch);
      creatorOpen = patrolCreatorOpen(
        vision,
        screen.observations,
        controls
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
      1,
      Math.min(6, Number(controls.comboFallbackAttempts) || 6)
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
      createMenuMatch = findTextInRegion(
        vision,
        screen.observations,
        "创建队伍",
        controls.teamMenuRegion
      );
      menuOpen = Boolean(createMenuMatch);
      creatorOpen = patrolCreatorOpen(
        vision,
        screen.observations,
        controls
      );
    }
    if (!menuOpen && !creatorOpen) {
      throw new Error(
        `PATROL_TEAM_MENU_DID_NOT_OPEN: 旗帜点击及 ${comboAttempts} 次逐次 Ctrl+Q 备用后仍未识别到“创建队伍”，禁止继续点击`
      );
    }
  }

  if (!creatorOpen) {
    const createMenuClickAttempts = Math.max(
      1,
      Math.min(6, Number(controls.createMenuClickAttempts) || 6)
    );
    for (
      let attempt = 1;
      attempt <= createMenuClickAttempts && !creatorOpen;
      attempt += 1
    ) {
      createMenuMatch = findTextInRegion(
        vision,
        screen.observations,
        "创建队伍",
        controls.teamMenuRegion
      );
      if (!createMenuMatch) {
        throw new Error(
          `PATROL_CREATE_MENU_TEXT_DISAPPEARED: 第 ${attempt}/${createMenuClickAttempts} 次点击前已无法再次确认“创建队伍”，禁止点击游戏世界`
        );
      }
      const createMenuPoint = observationCenter(createMenuMatch);
      await report(
        attempt === 1 ? "info" : "warning",
        "patrol_create_menu_click",
        `第 ${attempt}/${createMenuClickAttempts} 次：已确认左侧“创建队伍”，先通过容器 BTN_RIGHT 释放鼠标锁定，再用 ADB 触屏点击文字中心 (${Math.round(createMenuPoint.x)},${Math.round(createMenuPoint.y)})`
      );
      if (typeof adb.releaseGameMouseCapture === "function") {
        await adb.releaseGameMouseCapture(signal);
        await sleep(
          Math.max(100, Number(controls.mouseReleaseSettleMs) || 250),
          signal
        );
      } else if (typeof adb.focusGameInput === "function") {
        await adb.focusGameInput(createMenuPoint.x, createMenuPoint.y, signal);
      }
      if (typeof adb.touchTap === "function") {
        await adb.touchTap(createMenuPoint.x, createMenuPoint.y, signal);
      } else {
        await ui.tap(createMenuPoint, signal);
      }
      await sleep(createMenuWaitMs, signal);
      screen = await capturePatrolScreen(
        vision,
        `patrol-team-creator-open-${attempt}`,
        signal
      );
      creatorOpen = patrolCreatorOpen(
        vision,
        screen.observations,
        controls
      );
      if (!creatorOpen && attempt < createMenuClickAttempts) {
        await report(
          "warning",
          "patrol_create_menu_click_unverified",
          `第 ${attempt} 次点击未确认创建页；仅在“创建队伍”仍可见时继续下一轮右键释放与点击`
        );
      }
    }
    if (!patrolCreatorOpen(vision, screen.observations, controls)) {
      throw new Error(
        "PATROL_TEAM_CREATOR_DID_NOT_OPEN: 未确认队伍目标创建页，禁止选择目标"
      );
    }
  }

  await tapPatrolHud(ui, controls.campAffairsPoint, signal);
  await sleep(settleMs, signal);
  screen = await capturePatrolScreen(
    vision,
    "patrol-camp-affairs-selected",
    signal
  );
  const patrolTargetMatch = findAnyTextInRegion(
    vision,
    screen.observations,
    controls.patrolTargetTexts || ["营地巡逻任务", "营地巡逻"],
    controls.patrolTargetRegion
  );
  if (!patrolTargetMatch) {
    throw new Error(
      "PATROL_TARGET_NOT_VISIBLE: 点击营地事务分类后未识别到“营地巡逻”"
    );
  }

  await tapPatrolHud(ui, observationCenter(patrolTargetMatch), signal);
  await report(
    "info",
    "patrol_target_selected_wait",
    `已选择“${patrolTargetMatch.text}”，等待 5 秒使创建按钮稳定后再继续`
  );
  await sleep(patrolTargetWaitMs, signal);
  screen = await capturePatrolScreen(
    vision,
    "patrol-target-selected",
    signal
  );
  if (
    !findAnyTextInRegion(
      vision,
      screen.observations,
      controls.patrolTargetTexts || ["营地巡逻任务", "营地巡逻"],
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
  await tapPatrolHud(ui, controls.createButtonPoint, signal);
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

function patrolCreatorOpen(vision, observations, controls) {
  const title = findAnyTextInRegion(
    vision,
    observations,
    controls.creatorTitleTexts || ["队伍目标", "选择目标", "创建队伍"],
    controls.creatorTitleRegion
  );
  const submit = hasTextInRegion(
    vision,
    observations,
    "创建队伍",
    controls.createButtonRegion
  );
  return Boolean(title || submit);
}

function findAnyTextInRegion(vision, observations, texts, region) {
  return texts
    .map((text) => findTextInRegion(vision, observations, text, region))
    .find(Boolean) || null;
}

export async function sharePatrolTeam(context, signal) {
  const { config, ui, adb, vision, report } = context;
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
    Math.min(6, Number(controls.recruitAttempts) || 6)
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
        : `第 ${attempt - 1} 次点击后仍未识别到“营地频道”；执行第 ${attempt}/${recruitAttempts} 次右键释放、重新识别并点击“招募”`
    );
    const recruitMatch = findTextInRegion(
      vision,
      screen.observations,
      "招募",
      controls.teamPageRegion
    );
    const recruitPoint = recruitMatch
      ? observationCenter(recruitMatch)
      : controls.recruitPoint;
    if (typeof ui.hudTap === "function") {
      await ui.hudTap(recruitPoint, signal);
    } else if (typeof adb?.touchTap === "function") {
      await adb.releaseGameMouseCapture?.(signal);
      await adb.touchTap(recruitPoint.x, recruitPoint.y, signal);
    } else {
      await ui.tap(recruitPoint, signal);
    }
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
    Math.min(6, Number(controls.channelAttempts) || 6)
  );
  for (let attempt = 1; attempt <= channelAttempts; attempt += 1) {
    await report(
      "info",
      "patrol_share_camp_channel",
      `已确认分享频道列表，点击“营地频道”${attempt > 1 ? "（重试）" : ""}`
    );
    const channelMatch = findTextInRegion(
      vision,
      screen.observations,
      "营地频道",
      controls.channelMenuRegion
    );
    if (!channelMatch) {
      await report(
        "warning",
        "patrol_share_channel_text_lost",
        `第 ${attempt}/${channelAttempts} 次分享前未再次识别到“营地频道”，返回招募阶段重新打开频道列表`
      );
      break;
    }
    const channelPoint = observationCenter(channelMatch);
    if (typeof ui.hudTap === "function") {
      await ui.hudTap(channelPoint, signal);
    } else if (typeof adb?.touchTap === "function") {
      await adb.releaseGameMouseCapture?.(signal);
      await adb.touchTap(channelPoint.x, channelPoint.y, signal);
    } else {
      await ui.tap(channelPoint, signal);
    }
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
  return Boolean(findTextInRegion(vision, observations, text, region));
}

function findTextInRegion(vision, observations, text, region) {
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
  return (
    vision.find(bounded, text, "exact") ||
    vision.find(bounded, text, "includes")
  );
}

function observationCenter(observation) {
  return {
    x: observation.x + observation.width / 2,
    y: observation.y + observation.height / 2
  };
}

async function tapPatrolHud(ui, point, signal) {
  if (typeof ui.hudTap === "function") {
    return ui.hudTap(point, signal);
  }
  return ui.tap(point, signal);
}

export async function patrolTeamIsFull(
  context,
  frame,
  signal,
  initialObservations = null
) {
  const { vision, report } = context;
  const controls = context.config?.patrolTeamUi || {};
  const slotRegions = controls.teamMemberSlotRegions || [
    { left: 560, top: 290, right: 955, bottom: 960 },
    { left: 960, top: 290, right: 1355, bottom: 960 },
    { left: 1360, top: 290, right: 1750, bottom: 960 }
  ];
  let observations = initialObservations || frame.observations || [];
  const slotObservations = await Promise.all(
    slotRegions.map(async (region, index) => {
      if (typeof vision.ocrRegion !== "function" || !frame.path) {
        return observationsInRegion(observations, region);
      }
      const regional = await vision
        .ocrRegion(
          frame.path,
          region,
          `patrol-team-member-slot-${index + 2}`,
          signal,
          "accurate",
          0.28,
          1.5
        )
        .catch(() => []);
      return regional.length
        ? regional
        : observationsInRegion(observations, region);
    })
  );
  const waitingIndexes = [];
  const unverifiedIndexes = [];
  for (let index = 0; index < slotObservations.length; index += 1) {
    const items = slotObservations[index];
    if (slotShowsWaiting(items)) {
      waitingIndexes.push(index + 2);
      continue;
    }
    if (!slotShowsMember(items)) {
      unverifiedIndexes.push(index + 2);
    }
  }
  if (waitingIndexes.length > 0) {
    await report(
      "info",
      "patrol_team_waiting",
      `第 ${waitingIndexes.join("、")} 号卡位仍显示“等待队员加入”，继续等待满员`,
      { waitingSlots: waitingIndexes.length, waitingIndexes }
    );
    return false;
  }
  if (unverifiedIndexes.length > 0) {
    await report(
      "info",
      "patrol_team_full_unverified",
      `第 ${unverifiedIndexes.join("、")} 号卡位既未识别到等待文字，也没有足够的成员昵称/等级/数值证据；本轮不判定满员`,
      { unverifiedIndexes }
    );
    return false;
  }
  await report(
    "info",
    "patrol_team_full_verified",
    "已逐卡确认第 2、3、4 号队员位均有人，且“等待队员加入”为 0"
  );
  return true;
}

function patrolTeamPanelVisible(vision, observations, config) {
  const controls = config?.patrolTeamUi || {};
  const region = controls.createdBodyRegion || {
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1180
  };
  return ["调整", "离开队伍", "招募", "等待队员加入"].some((text) =>
    hasTextInRegion(vision, observations, text, region)
  );
}

function observationsInRegion(observations, region) {
  return (observations || []).filter((item) => {
    const x = item.x + item.width / 2;
    const y = item.y + item.height / 2;
    return (
      x >= region.left &&
      x <= region.right &&
      y >= region.top &&
      y <= region.bottom
    );
  });
}

function normalizedSlotText(item) {
  return String(item?.text || "")
    .replace(/\s+/g, "")
    .replace(/[|｜]/g, "");
}

function slotShowsWaiting(observations) {
  const text = observations.map(normalizedSlotText).join("");
  return (
    text.includes("等待队员加入") ||
    (text.includes("等待") && text.includes("队员") && text.includes("加入"))
  );
}

function slotShowsMember(observations) {
  const tokens = observations
    .map(normalizedSlotText)
    .filter((text) => text && text !== "+");
  if (tokens.some((text) => text === "愿" || text.endsWith("愿"))) {
    return true;
  }
  const numericTokens = tokens.filter((text) => /\d/.test(text));
  const nameLikeTokens = tokens.filter(
    (text) =>
      /[\p{L}\p{Script=Han}]/u.test(text) &&
      !text.includes("等待") &&
      !text.includes("队员") &&
      !text.includes("加入")
  );
  return numericTokens.length >= 1 && nameLikeTokens.length >= 1;
}

function millisecondsUntil(timezone, value) {
  const now = zonedClock(timezone);
  const seconds =
    (clockMinutes(value) - now.minute) * 60 - now.second;
  return Math.max(250, seconds * 1000);
}
