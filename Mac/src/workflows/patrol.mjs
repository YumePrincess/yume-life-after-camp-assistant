import { delay } from "../process.mjs";
import { clockMinutes, reached, zonedClock } from "../clock.mjs";

export async function runPatrol(context, command, bundle, signal) {
  const { ui, vision, report } = context;
  const patrol = bundle.automationConfig.tasks.patrol;
  const timezone = bundle.automationConfig.timezone;
  const campName = String(bundle.campConfig?.campName || "").trim();

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
    const removedOutsideMember = full
      ? await removeFirstPatrolMemberOutsideCamp(
          context,
          screen.frame,
          signal,
          campName,
          screen.observations
        )
      : false;
    consecutiveFullTeamFrames = full
      ? removedOutsideMember
        ? 0
        : consecutiveFullTeamFrames + 1
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
  await ui.executeFlow("closePatrolTeamPanelBeforeAccept", {}, signal);
  await report(
    "info",
    "patrol_notice_board_reused",
    "队伍等待期间角色没有移动；收起队伍后直接使用初始公告版位置，不再执行任何传送"
  );
  await ui.executeFlow("openPatrol", {}, signal);
  await startHardPatrolWithRetry(context, signal);
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
  // From this point on the patrol run is in its terminal cleanup phase. Any
  // OCR/input error while closing the team panel or returning to the center
  // must not be treated as a reason to start a fresh scheduled attempt.
  context.suppressScheduledRetry = true;
  context.suppressScheduledRetryReason = "patrol_deadline_cleanup";
  await report("info", "patrol_done", "已到巡逻任务结束时间");
  await closePatrolPanelBeforeExit(context, signal);
}

export async function startHardPatrolWithRetry(context, signal) {
  const { config, ui, vision, report } = context;
  const controls = config.patrolTeamUi?.hardPatrol || {};
  const maxAttempts = Math.max(
    1,
    Math.min(8, Number(controls.acceptAttempts) || 8)
  );
  const retryTexts = controls.retryTexts || [
    "简单巡逻任务",
    "困难巡逻任务",
    "简单巡逻路线",
    "困难巡逻路线"
  ];
  const retryRegion = controls.retryRegion || {
    left: 850,
    top: 150,
    right: 1920,
    bottom: 950
  };
  const successTexts = controls.successTexts || ["已经拥有巡逻路线"];
  const successRegion = controls.successRegion || {
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1200
  };
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await ui.executeFlow("startHardPatrol", {}, signal);
      return;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (!String(error?.message || "").includes("已经拥有巡逻路线")) {
        throw error;
      }
      lastError = error;
      const screen = await capturePatrolScreen(
        vision,
        `patrol-hard-accept-retry-check-${attempt}`,
        signal
      );
      const successMatch = findAnyTextInRegion(
        vision,
        screen.observations,
        successTexts,
        successRegion
      );
      if (successMatch) {
        await report(
          "info",
          "patrol_hard_accept_confirmed_after_timeout",
          `接取等待到期后确认已成功接取：识别到“${successMatch.text}”；不再重试，继续退出巡逻页面`
        );
        return;
      }
      const retryMatch = findAnyTextInRegion(
        vision,
        screen.observations,
        retryTexts,
        retryRegion
      );
      if (!retryMatch || attempt >= maxAttempts) break;
      await report(
        "warning",
        "patrol_hard_accept_retry",
        `第 ${attempt} 次接取后仍显示巡逻路线选择页（检测到“${retryMatch.text}”）；重新执行接取-确定，第 ${attempt + 1}/${maxAttempts} 次，直到确认“已经拥有巡逻路线”`
      );
      continue;
    }
  }
  if (lastError) {
    await report(
      "warning",
      "patrol_hard_accept_state_unverified",
      `接取等待到期后既未确认“${successTexts.join("、")}”，也未识别到未接取关键词；为避免重复接取，停止并报告状态未确认`
    );
  }
  throw new Error(
    `PATROL_HARD_ACCEPT_UNVERIFIED: ${maxAttempts} 次接取-确定后未确认巡逻接取状态${lastError?.message ? `（${lastError.message}）` : ""}`
  );
}

export async function closePatrolPanelBeforeExit(context, signal) {
  const { config, ui, vision, report } = context;
  let screen = await capturePatrolScreen(
    vision,
    "patrol-deadline-team-panel-check",
    signal
  );
  if (!patrolTeamPanelVisible(vision, screen.observations, config)) {
    await report(
      "info",
      "patrol_deadline_panel_already_closed",
      "巡逻结束时未检测到队伍面板，直接进入中心出入口收尾传送"
    );
    return;
  }
  await report(
    "info",
    "patrol_deadline_close_team",
    "巡逻结束时间已到；只点击一次已校准的队伍页返回箭头，等待并确认 HUD 后再传送中心出入口"
  );
  try {
    // Reuse the same one-click, five-second settle, chat-collapse and HUD
    // verification flow used by the live patrol handoff. The generic
    // closeTeamPanel flow can mistake stale "离开队伍" OCR for a failed close
    // and prevent the already-successful center return from running.
    await ui.executeFlow("closePatrolTeamPanelBeforeAccept", {}, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    await report(
      "warning",
      "patrol_deadline_panel_close_unverified_continue",
      "巡逻结束收尾关闭队伍面板未能完成最终文字确认；不再重复点击，继续执行中心出入口传送，且本次收尾错误不会触发任务重试",
      { reason: error.message }
    );
    return;
  }
  await report(
    "info",
    "patrol_deadline_team_closed",
    "已确认队伍面板关闭；将由任务收尾流程传送到中心出入口并停止游戏与模拟器"
  );
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
  const campAffairsWaitMs = Math.max(
    5_000,
    Number(controls.campAffairsWaitMs) || 5_000
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
      2,
      Math.min(
        7,
        Number(controls.flagClickAttempts) || 2
      )
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
          ? `已确认${flagReady ? "旗帜快捷键提示" : `底部 ${channelReadyCount} 个频道 HUD`}锚点；首次 ADB 点击前由统一点击器发送一次 KEYCODE_GRAVE (${controls.flagButton.x},${controls.flagButton.y})`
          : `旗帜点击后仍未出现队伍菜单；保持当前鼠标状态重试 ADB 点击 (${controls.flagButton.x},${controls.flagButton.y})`
      );
      await tapPatrolMouse(ui, controls.flagButton, signal);
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
      createMenuMatch = await findPatrolTextWithAccurateRegion(
        vision,
        screen,
        screen.observations,
        "创建队伍",
        controls.teamMenuRegion,
        `patrol-team-menu-open-${attempt}-create-entry`,
        signal
      );
      menuOpen = Boolean(createMenuMatch);
      creatorOpen = patrolCreatorOpen(
        vision,
        screen.observations,
        controls
      );
      if (!creatorOpen) {
        await patrolAiDiagnose(
          vision,
          report,
          "patrol-creator",
          "队伍创建流程：确认是否已打开标题为“队伍目标”的创建页面，并且右下角可见“创建队伍”按钮。只有这两个要素都清晰可见时返回 target_text_visible。",
          screen.observations,
          signal
        );
      }
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
      createMenuMatch = await findPatrolTextWithAccurateRegion(
        vision,
        screen,
        screen.observations,
        "创建队伍",
        controls.teamMenuRegion,
        `patrol-team-menu-key-fallback-${attempt + 1}-create-entry`,
        signal
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
      createMenuMatch = await findPatrolTextWithAccurateRegion(
        vision,
        screen,
        screen.observations,
        "创建队伍",
        controls.teamMenuRegion,
        `patrol-team-creator-entry-${attempt}-create-entry`,
        signal
      );
      if (!createMenuMatch) {
        throw new Error(
          `PATROL_CREATE_MENU_TEXT_DISAPPEARED: 第 ${attempt}/${createMenuClickAttempts} 次点击前已无法再次确认“创建队伍”，禁止点击游戏世界`
        );
      }
      // 左侧菜单的 OCR 文本框会覆盖旗帜图标，文本中心并不等于可点击行中心。
      // 保持与营地频道相同的 ADB 鼠标点击，不能改为触屏点击。
      const createMenuPoint = controls.createMenuPoint || { x: 220, y: 180 };
      await report(
        attempt === 1 ? "info" : "warning",
        "patrol_create_menu_click",
        `第 ${attempt}/${createMenuClickAttempts} 次：已在左侧区域精确识别“创建队伍”；使用统一 ADB 鼠标点击器 (${Math.round(createMenuPoint.x)},${Math.round(createMenuPoint.y)})`
      );
      await tapPatrolMouse(ui, createMenuPoint, signal);
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
      if (!creatorOpen) {
        const title = await findPatrolTextWithAccurateRegion(
          vision,
          screen,
          screen.observations,
          "队伍目标",
          controls.creatorTitleRegion,
          `patrol-team-creator-open-${attempt}-title`,
          signal
        );
        const submit = await findPatrolTextWithAccurateRegion(
          vision,
          screen,
          screen.observations,
          "创建队伍",
          controls.createButtonRegion,
          `patrol-team-creator-open-${attempt}-submit`,
          signal
        );
        creatorOpen = Boolean(title && submit);
      }
      if (!creatorOpen && attempt < createMenuClickAttempts) {
        await report(
          "warning",
          "patrol_create_menu_click_unverified",
          `第 ${attempt} 次点击左侧入口后仍未确认创建页面；下一次保持当前鼠标状态重试 ADB 点击`
        );
      }
    }
    if (!creatorOpen) {
      throw new Error(
        "PATROL_TEAM_CREATOR_DID_NOT_OPEN: 未确认队伍目标创建页，禁止选择目标"
      );
    }
  }

  await tapPatrolMouse(ui, controls.campAffairsPoint, signal);
  await report(
    "info",
    "patrol_camp_affairs_selected_wait",
    "已点击最底部“营地事务”分类卡，等待 5 秒让“营地巡逻任务”列表稳定后再进行 OCR"
  );
  await sleep(campAffairsWaitMs, signal);
  let patrolTargetMatch = null;
  const patrolTargetReadAttempts = Math.max(
    1,
    Math.min(5, Number(controls.patrolTargetReadAttempts) || 3)
  );
  for (let attempt = 1; attempt <= patrolTargetReadAttempts; attempt += 1) {
    screen = await capturePatrolScreen(
      vision,
      attempt === 1
        ? "patrol-camp-affairs-selected"
        : `patrol-camp-affairs-selected-reread-${attempt}`,
      signal
    );
    patrolTargetMatch = findAnyTextInRegion(
      vision,
      screen.observations,
      controls.patrolTargetTexts || ["营地巡逻任务", "营地巡逻"],
      controls.patrolTargetRegion
    );
    if (patrolTargetMatch) break;
    if (attempt < patrolTargetReadAttempts) {
      await report(
        "warning",
        "patrol_target_ocr_reread",
        `“营地事务”已选中但第 ${attempt}/${patrolTargetReadAttempts} 次 OCR 尚未读到“营地巡逻任务”；保持当前页面原地重读，不重复点击分类卡`
      );
      await sleep(1_000, signal);
    }
  }
  if (!patrolTargetMatch) {
    const categoryMatch = await scrollToCampAffairsCategory(
      { adb, vision, ui, report, sleep, controls },
      signal
    );
    if (categoryMatch) {
      await tapPatrolMouse(ui, observationCenter(categoryMatch), signal);
      await report(
        "info",
        "patrol_camp_affairs_scroll_selected",
        `已滑动左侧目标列表并按文字中心选中“${categoryMatch.text}”，等待列表稳定后重读巡逻目标`
      );
      await sleep(campAffairsWaitMs, signal);
      for (let attempt = 1; attempt <= patrolTargetReadAttempts; attempt += 1) {
        screen = await capturePatrolScreen(
          vision,
          `patrol-camp-affairs-scroll-reread-${attempt}`,
          signal
        );
        patrolTargetMatch = findAnyTextInRegion(
          vision,
          screen.observations,
          controls.patrolTargetTexts || ["营地巡逻任务", "营地巡逻"],
          controls.patrolTargetRegion
        );
        if (patrolTargetMatch) break;
        if (attempt < patrolTargetReadAttempts) {
          await sleep(1_000, signal);
        }
      }
    }
  }
  if (!patrolTargetMatch) {
    await patrolAiDiagnose(
      vision,
      report,
      "patrol-target",
      "队伍目标创建页：确认左侧已选营地事务，中央是否清晰显示“营地巡逻任务”。仅在文字确实可见时返回 target_text_visible。",
      screen.observations,
      signal
    );
    throw new Error(
      "PATROL_TARGET_NOT_VISIBLE: 点击营地事务分类后未识别到“营地巡逻”"
    );
  }

  await report(
    "info",
    "patrol_target_selected_wait",
    `已确认“${patrolTargetMatch.text}”已随“营地事务”自动选中，等待 5 秒使创建按钮稳定后再继续`
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
    "已确认“营地事务>营地巡逻任务”，点击创建页面右下角的最终“创建队伍”按钮"
  );
  await tapPatrolMouse(ui, controls.createButtonPoint, signal);
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
  return Boolean(title && submit);
}

async function scrollToCampAffairsCategory(context, signal) {
  const { adb, vision, report, sleep, controls } = context;
  const fallback = controls.campAffairsFallback;
  if (!fallback || typeof adb?.mouseSwipe !== "function") return null;

  const texts = fallback.texts || ["营地事务", "营地事物"];
  const maxSwipes = Math.max(1, Math.min(3, Number(fallback.maxSwipes) || 1));
  const settleMs = Math.max(1_000, Number(fallback.settleAfterSwipeMs) || 3_000);

  for (let attempt = 1; attempt <= maxSwipes; attempt += 1) {
    await report(
      "warning",
      "patrol_camp_affairs_scroll_fallback",
      `中央巡逻目标 OCR 未命中；第 ${attempt}/${maxSwipes} 次复用贡献/斩杀列表的 ADB 鼠标上滑方式查找“营地事务”`
    );
    await adb.mouseSwipe(
      fallback.from,
      fallback.to,
      Math.max(150, Number(fallback.durationMs) || 500),
      signal
    );
    await sleep(settleMs, signal);
    const screen = await capturePatrolScreen(
      vision,
      `patrol-camp-affairs-scroll-${attempt}`,
      signal
    );
    const match = findAnyTextInRegion(
      vision,
      screen.observations,
      texts,
      fallback.region
    );
    if (match) return match;
  }
  await report(
    "warning",
    "patrol_camp_affairs_scroll_unverified",
    "复用列表上滑后仍未识别到“营地事务”；不会盲点分类卡"
  );
  return null;
}

async function patrolAiDiagnose(
  vision,
  report,
  label,
  taskHint,
  observations,
  signal
) {
  if (
    !vision?.advisor?.enabled ||
    typeof vision.adviseCurrent !== "function"
  ) {
    return false;
  }
  const advice = await vision
    .adviseCurrent(
      `patrol-${label}-advisor`,
      {
        expectedState: "target_text_visible",
        taskHint,
        ocrTexts: (observations || []).map((item) => item.text).slice(0, 80)
      },
      signal
    )
    .catch(() => null);
  const minimum = Math.max(
    0.95,
    Number(vision.advisor?.config?.minimumActionConfidence) || 0.95
  );
  const accepted =
    advice?.state === "target_text_visible" &&
    Number(advice?.confidence) >= minimum;
  await report(
    accepted ? "info" : "warning",
    "patrol_ai_creation_diagnostic",
    accepted
      ? `AI 已以 ${(Number(advice.confidence) * 100).toFixed(0)}% 高置信确认 ${label}；此结果仅作诊断，不会越过局部 OCR 校验`
      : `AI 未高置信确认 ${label}；此结果仅作诊断，不会触发任何盲点`,
    advice || undefined
  );
}

async function findPatrolTextWithAccurateRegion(
  vision,
  screen,
  observations,
  text,
  region,
  label,
  signal
) {
  const existing = findTextInRegion(vision, observations, text, region);
  if (existing) return existing;
  if (typeof vision?.ocrRegion !== "function" || !screen?.frame?.path) {
    return null;
  }
  const regional = await vision
    .ocrRegion(
      screen.frame.path,
      region,
      label,
      signal,
      "accurate",
      0.1,
      2
    )
    .catch(() => []);
  return findTextInRegion(vision, regional, text, region);
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
  // “招募”打开的频道列表有入场动画。必须完整等待三秒后再 OCR，
  // 否则会把尚未稳定的列表当成可点击状态。
  const recruitMenuWaitMs = Math.max(
    3_000,
    Number(controls.recruitMenuWaitMs) || 3_000
  );
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
    Math.min(15, Number(controls.recruitAttempts) || 15)
  );
  const campChannelTextRegion =
    controls.campChannelTextRegion || controls.channelMenuRegion;
  const recruitTextRegion = controls.recruitTextRegion || {
    left: 220,
    top: 1_040,
    right: 480,
    bottom: 1_180
  };
  const recruitPoint = controls.recruitPoint || { x: 343, y: 1128 };
  const recruitOverlayTexts = controls.recruitOverlayTexts || [
    "邀请",
    "推荐组队",
    "最近组队",
    "巡猎车队",
    "萌芽师徒"
  ];
  const recruitOverlayRegion = controls.recruitOverlayRegion || {
    left: 250,
    top: 150,
    right: 1350,
    bottom: 820
  };
  const recruitOverlayDismissPoint = resolveRecruitOverlayDismissPoint(
    controls.recruitOverlayDismissPoint || { x: 1800, y: 900 },
    recruitOverlayRegion
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
        : `第 ${attempt - 1} 次点击后仍未识别到“营地频道”；执行第 ${attempt}/${recruitAttempts} 次重新 OCR 并点击“招募”`
    );
    // “更换队伍”和“招募”同在左侧区域。每一次点击前都重新截图，只接受
    // 底部招募行内的文字；不再根据旧画面或固定坐标盲点。
    screen = await capturePatrolScreen(
      vision,
      `patrol-share-recruit-verify-${attempt}`,
      signal
    );
    const recruitMatch = findTextInRegion(
      vision,
      screen.observations,
      "招募",
      recruitTextRegion
    );
    if (!recruitMatch) {
      await report(
        "warning",
        "patrol_share_recruit_unverified",
        `第 ${attempt}/${recruitAttempts} 次点击前未在底部招募行 OCR 确认“招募”；不会点击“更换队伍”或任何固定坐标`
      );
      await sleep(settleMs, signal);
      continue;
    }
    await report(
      "info",
      "patrol_share_recruit_verified",
      `OCR 已在底部招募行确认“招募”，点击固定招募按钮中心 (${Math.round(recruitPoint.x)},${Math.round(recruitPoint.y)})`,
      {
        point: recruitPoint,
        recognizedTextBounds: {
          x: recruitMatch.x,
          y: recruitMatch.y,
          width: recruitMatch.width,
          height: recruitMatch.height
        }
      }
    );
    // “招募”是队伍 HUD 的真实鼠标按钮，沿用统一的 ADB
    // KEYCODE_GRAVE + 鼠标点击状态；不再调用宿主机输入或低层右键事件。
    await tapPatrolHudMouse(ui, adb, recruitPoint, signal, sleep);
    await report(
      "info",
      "patrol_share_channel_wait",
      "已点击“招募”，等待 3 秒让频道列表稳定后再 OCR 确认“营地频道”"
    );
    await sleep(recruitMenuWaitMs, signal);
    screen = await capturePatrolScreen(
      vision,
      `patrol-share-channel-menu-${attempt}`,
      signal
    );
    const inviteOverlayMatch = findAnyTextInRegion(
      vision,
      screen.observations,
      recruitOverlayTexts,
      recruitOverlayRegion
    );
    if (inviteOverlayMatch) {
      await report(
        "warning",
        "patrol_share_invite_overlay_detected",
        `点击“招募”误打开邀请卡片（识别到“${inviteOverlayMatch.text}”）；点击卡片边框外空白点 (${Math.round(recruitOverlayDismissPoint.x)},${Math.round(recruitOverlayDismissPoint.y)}) 关闭后重试招募（第 ${attempt}/${recruitAttempts} 次）`,
        {
          dismissPoint: recruitOverlayDismissPoint,
          overlayRegion: recruitOverlayRegion
        }
      );
      await tapPatrolMouse(ui, recruitOverlayDismissPoint, signal);
      await sleep(settleMs, signal);
      continue;
    }
    channelMenuVisible = hasTextInRegion(
      vision,
      screen.observations,
      "营地频道",
      campChannelTextRegion
    );
    if (channelMenuVisible) {
      await report(
        "info",
        "patrol_share_camp_channel_verified",
        "OCR 已确认校准行中的“营地频道”，将点击固定的营地频道行中心，不使用 OCR 文字框坐标"
      );
      break;
    }
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
      campChannelTextRegion
    );
    if (!channelMatch) {
      await report(
        "warning",
        "patrol_share_channel_text_lost",
        `第 ${attempt}/${channelAttempts} 次分享前未再次识别到“营地频道”，返回招募阶段重新打开频道列表`
      );
      break;
    }
    // “可分享目标”是模态弹窗。频道菜单的位置会随队伍卡片布局而偏移，
    // 所以只用 OCR 定位到的“营地频道”文字中心点击。
    const campChannelPoint = observationCenter(channelMatch);
    await report(
      "info",
      "patrol_share_camp_channel_click",
      `已在 OCR 确认后使用 ADB 鼠标左键点击“营地频道”文字中心 (${Math.round(campChannelPoint.x)},${Math.round(campChannelPoint.y)})`,
      {
        point: campChannelPoint,
        recognizedTextBounds: {
          x: channelMatch.x,
          y: channelMatch.y,
          width: channelMatch.width,
          height: channelMatch.height
        }
      }
    );
    await tapPatrolMouse(ui, campChannelPoint, signal);
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
      campChannelTextRegion
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

async function tapPatrolMouse(ui, point, signal) {
  return ui.tap(point, signal);
}

async function tapPatrolHudMouse(ui, _adb, point, signal, _sleep = delay) {
  return tapPatrolMouse(ui, point, signal);
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

export async function removeFirstPatrolMemberOutsideCamp(
  context,
  frame,
  signal,
  campName,
  initialObservations = null
) {
  const { config, ui, vision, report } = context;
  const expectedCamp = normalizePatrolText(campName);
  if (!expectedCamp) {
    await report(
      "warning",
      "patrol_member_location_check_skipped",
      "后台基础设置未提供营地名称；为避免误移出队员，本次不执行所在地核验"
    );
    return false;
  }
  const controls = config?.patrolTeamUi || {};
  const slotRegions = controls.teamMemberSlotRegions || [
    { left: 560, top: 290, right: 955, bottom: 960 },
    { left: 960, top: 290, right: 1355, bottom: 960 },
    { left: 1360, top: 290, right: 1750, bottom: 960 }
  ];
  const locationRegions = controls.teamMemberLocationRegions || slotRegions.map(
    (region) => ({
      left: region.left,
      // 只取昵称下一行的所在地；不能把上方昵称带入，否则会把玩家名误报为地图名。
      top: Math.max(region.top, region.bottom - 120),
      right: region.right,
      bottom: region.bottom - 35
    })
  );
  const observations = initialObservations || frame.observations || [];
  for (let index = 0; index < locationRegions.length; index += 1) {
    const locationRegion = locationRegions[index];
    let locationObservations = observationsInRegion(observations, locationRegion);
    if (typeof vision.ocrRegion === "function" && frame.path) {
      const regional = await vision
        .ocrRegion(
          frame.path,
          locationRegion,
          `patrol-team-location-slot-${index + 2}`,
          signal,
          "accurate",
          0.45,
          1.5
        )
        .catch(() => []);
      if (regional.length) locationObservations = regional;
    }
    const locationTokens = locationObservations
      .map((item) => normalizePatrolText(item?.text))
      .filter(Boolean);
    // 地点字段在游戏中只使用中文。拉丁字母串（例如 COSGH/LSGH）是
    // 低置信度 OCR 噪声，不能因为“像文字”就进入移出队员判定。
    const chineseLocationTokens = locationObservations
      .map((item) => ({
        text: normalizePatrolText(item?.text),
        confidence: Number(item?.confidence)
      }))
      .filter(
        (item) =>
          isChineseOnlyPatrolLocation(item.text) &&
          (!Number.isFinite(item.confidence) || item.confidence >= 0.45)
      )
      .map((item) => item.text);
    if (chineseLocationTokens.some((token) => token.includes(expectedCamp))) {
      continue;
    }
    // OCR 未读取到可信的中文所在地时绝不凭空移出队员；只在能读出
    // 另一处中文地点时处理。
    const readableLocation = chineseLocationTokens.find((token) => token.length >= 1);
    if (!readableLocation) {
      await report(
        "warning",
        "patrol_member_location_unverified",
        `第 ${index + 2} 号队员未读到营地名称“${campName}”，但所在地文字不完整；不执行移出`,
        { slot: index + 2, locationTokens }
      );
      continue;
    }
    const memberPoint = centerOfRegion(slotRegions[index]);
    await report(
      "warning",
      "patrol_member_outside_camp",
      `第 ${index + 2} 号队员所在地为“${readableLocation}”，不是营地“${campName}”；点击队员卡片并准备移出`,
      { slot: index + 2, campName, locationTokens, memberPoint }
    );
    await tapPatrolMouse(ui, memberPoint, signal);
    const sleep = context.sleep || delay;
    await sleep(3_000, signal);
    const memberMenu = await capturePatrolScreen(
      vision,
      `patrol-member-remove-menu-slot-${index + 2}`,
      signal
    );
    await patrolAiDiagnose(
      vision,
      report,
      "member-remove-menu",
      "队员操作卡片：确认画面为成员操作菜单，且底部可见唯一红色“移出队伍”按钮。仅作画面诊断，绝不替代 OCR 定位或决定点击。",
      memberMenu.observations,
      signal
    );
    const removeMatch = findTextInRegion(
      vision,
      memberMenu.observations,
      "移出队伍",
      controls.removeTeamButtonRegion || {
        left: 450,
        top: 400,
        right: 1450,
        bottom: 1180
      }
    );
    if (!removeMatch) {
      throw new Error(
        `PATROL_MEMBER_REMOVE_UNVERIFIED: 第 ${index + 2} 号队员所在地不在营地，但未 OCR 确认“移出队伍”红色按钮；未执行移出`
      );
    }
    const removePoint = observationCenter(removeMatch);
    await report(
      "warning",
      "patrol_member_remove_confirmed",
      `已 OCR 确认第 ${index + 2} 号队员菜单底部“移出队伍”，点击其文字中心`,
      { slot: index + 2, removePoint }
    );
    await tapPatrolMouse(ui, removePoint, signal);
    await sleep(500, signal);
    const removeConfirmDialog = await capturePatrolScreen(
      vision,
      `patrol-member-remove-confirm-slot-${index + 2}`,
      signal
    );
    await patrolAiDiagnose(
      vision,
      report,
      "member-remove-confirm",
      "确认是否出现“是否把玩家从队伍移除”的固定确认弹窗，右侧有“确认(F)”按钮。仅作诊断，必须由 OCR 找到“确认”后才可点击。",
      removeConfirmDialog.observations,
      signal
    );
    const confirmMatch = findTextInRegion(
      vision,
      removeConfirmDialog.observations,
      "确认",
      controls.removeTeamConfirmRegion || {
        left: 850,
        top: 500,
        right: 1350,
        bottom: 800
      }
    );
    if (!confirmMatch) {
      throw new Error(
        `PATROL_MEMBER_REMOVE_CONFIRM_UNVERIFIED: 已点击第 ${index + 2} 号队员的“移出队伍”，但未 OCR 确认最终“确认(F)”按钮；不会猜测坐标`
      );
    }
    const confirmPoint = observationCenter(confirmMatch);
    await report(
      "warning",
      "patrol_member_remove_final_confirmed",
      `已 OCR 确认最终移出弹窗“确认(F)”，点击文字中心完成移出`,
      { slot: index + 2, confirmPoint }
    );
    await tapPatrolMouse(ui, confirmPoint, signal);
    await sleep(800, signal);
    return true;
  }
  await report(
    "info",
    "patrol_member_locations_verified",
    `已确认三个队员所在地均为营地“${campName}”`
  );
  return false;
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

function normalizePatrolText(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[|｜]/g, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

function isChineseOnlyPatrolLocation(value) {
  return /^[\p{Script=Han}]+$/u.test(String(value || ""));
}

function centerOfRegion(region) {
  return {
    x: Math.round((region.left + region.right) / 2),
    y: Math.round((region.top + region.bottom) / 2)
  };
}

function resolveRecruitOverlayDismissPoint(point, region) {
  const candidate = {
    x: Number(point?.x),
    y: Number(point?.y)
  };
  if (
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    isPointOutsideRegion(candidate, region)
  ) {
    return candidate;
  }
  const candidates = [
    { x: region.right + 100, y: region.bottom + 100 },
    { x: region.right + 100, y: region.top - 100 },
    { x: region.left - 100, y: region.bottom + 100 },
    { x: region.left - 100, y: region.top - 100 }
  ];
  const safe = candidates.find(
    (item) =>
      item.x >= 20 &&
      item.x <= 1900 &&
      item.y >= 20 &&
      item.y <= 1180 &&
      isPointOutsideRegion(item, region)
  );
  return safe || { x: 1800, y: 900 };
}

function isPointOutsideRegion(point, region) {
  return (
    point.x < region.left ||
    point.x > region.right ||
    point.y < region.top ||
    point.y > region.bottom
  );
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
