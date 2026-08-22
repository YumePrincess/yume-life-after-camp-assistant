import { delay } from "../process.mjs";
import { reached, zonedClock } from "../clock.mjs";
import { updateWorkflowProgress } from "./progress.mjs";

export async function runPatrol(context, command, bundle, signal) {
  try {
    return await runPatrolWorkflow(context, command, bundle, signal);
  } catch (error) {
    const deadlineExceeded =
      Number.isFinite(context.patrolDeadlineAt) &&
      Date.now() >= context.patrolDeadlineAt;
    const shouldCleanup =
      !signal?.aborted &&
      !context.suppressScheduledRetry &&
      !context.patrolKeepExistingTeam &&
      context.patrolTeamPhase &&
      context.patrolTeamPhase !== "precreate";
    if (
      shouldCleanup
    ) {
      await cleanupPatrolTeamOnFailure(context, signal, error).catch(
        async (cleanupError) => {
          await context.report(
            "warning",
            "patrol_failure_team_cleanup_failed",
            "巡逻任务失败后的离队清理未完成；保留原始失败原因，不覆盖任务错误",
            { reason: cleanupError.message }
          );
        }
      );
    }
    if (deadlineExceeded) {
      context.suppressScheduledRetry = true;
      context.suppressScheduledRetryReason = "patrol_deadline_exceeded";
      await context.report(
        "warning",
        "patrol_deadline_retry_suppressed",
        "巡逻任务已超过后台设置的截止时间；本次失败不再发起定时重试"
      );
    }
    throw error;
  }
}

async function runPatrolWorkflow(context, command, bundle, signal) {
  const { ui, vision, report } = context;
  context.patrolTeamPhase = "precreate";
  const patrol = bundle.automationConfig.tasks.patrol;
  const timezone = bundle.automationConfig.timezone;
  const campName = String(bundle.campConfig?.campName || "").trim();
  const patrolDeadlineAt = dailyDeadlineAt(timezone, patrol.deadline);
  context.patrolDeadlineAt = patrolDeadlineAt;

  assertPatrolBeforeDeadline(patrolDeadlineAt);

  await updateWorkflowProgress(context, 0.04, "patrol_prepare");
  await report(
    "info",
    "patrol_notice_board_first",
    "巡逻任务登录完成后直接传送公告版，再创建营地巡逻队伍"
  );
  await updateWorkflowProgress(context, 0.08, "patrol_notice_board");
  await ui.executeFlow("teleportNoticeBoard", {}, signal);
  await updateWorkflowProgress(context, 0.13, "patrol_team_create");
  context.patrolTeamPhase = "creating";
  const teamMode = await createPatrolTeam(context, signal);
  if (teamMode === "existing-valid-route") {
    // A restart can land on a team that already owns a live patrol route.
    // Reusing it is intentional: leaving it would destroy the route and
    // create a second team for the same scheduled task.
    context.patrolExistingValidRoute = true;
    context.patrolKeepExistingTeam = true;
    context.patrolTeamPhase = "existing-valid-route";
    await updateWorkflowProgress(context, 0.46, "patrol_existing_route");
    await ui.executeFlow("openTeamPanel", {}, signal);
    await ensureExistingPatrolTargetForSharing(context, signal);
    await updateWorkflowProgress(context, 0.52, "patrol_existing_route_share");
    await sharePatrolTeam(context, signal);
    await report(
      "info",
      "patrol_existing_route_reused",
      "已确认现有队伍持有有效营地巡逻路线；不退出队伍、不创建新队伍，直接分享巡逻队"
    );
    await continuePatrolSharesUntilDeadline(
      context,
      signal,
      patrolDeadlineAt,
      patrol,
      { progressStart: 0.54 }
    );
    return;
  }
  context.patrolTeamPhase = "created";
  // Team creation can leave the page in 3D mode. The flow only taps the
  // existing 3D-mode control when that label is actually present; an already
  // 2D team page is left unchanged.
  await ui.executeFlow("ensurePatrolTeamTwoD", {}, signal);
  await ui.keyIfAnyText(["加入队伍语音频道"], 111, signal);
  await updateWorkflowProgress(context, 0.18, "patrol_team_share");
  await sharePatrolTeam(context, signal);
  await updateWorkflowProgress(context, 0.22, "patrol_team_wait");
  await report("info", "patrol_team", "巡逻队伍已创建并分别分享到营地频道和场景频道");

  let consecutiveFullTeamFrames = 0;
  while (true) {
    if (Date.now() >= patrolDeadlineAt) {
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
    await updateWorkflowProgress(
      context,
      full ? 0.38 : 0.22,
      full ? "patrol_team_full_check" : "patrol_team_waiting"
    );
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
  await updateWorkflowProgress(context, 0.42, "patrol_team_close");
  await ui.executeFlow("closePatrolTeamPanelBeforeAccept", {}, signal);
  await report(
    "info",
    "patrol_notice_board_reused",
    "队伍等待期间角色没有移动；收起队伍后直接使用初始公告版位置，不再执行任何传送"
  );
  await updateWorkflowProgress(context, 0.47, "patrol_open_route");
  await ui.executeFlow("openPatrol", {}, signal);
  await startHardPatrolWithRetry(context, signal);
  await updateWorkflowProgress(context, 0.60, "patrol_route_accepted");
  await ui.executeFlow("exitPatrolPages", {}, signal);
  await updateWorkflowProgress(context, 0.66, "patrol_team_reopen");
  await ui.executeFlow("openTeamPanel", {}, signal);
  await updateWorkflowProgress(context, 0.70, "patrol_switch_target");
  await ui.executeFlow("switchToBookDefense", {}, signal);
  await updateWorkflowProgress(context, 0.74, "patrol_final_share");
  await sharePatrolTeam(context, signal);
  await ui.executeFlow("openTeamPanel", {}, signal);
  const readyAt = new Date().toISOString();
  await report("info", "patrol_ready", "困难巡逻已确认，队伍已切换为保卫古籍并分享", {
    readyAt
  });
  await updateWorkflowProgress(context, 0.76, "patrol_ready");
  await continuePatrolSharesUntilDeadline(
    context,
    signal,
    patrolDeadlineAt,
    patrol,
    { progressStart: 0.76 }
  );
}

async function continuePatrolSharesUntilDeadline(
  context,
  signal,
  patrolDeadlineAt,
  patrol,
  { progressStart = 0.76 } = {}
) {
  const shareIntervalMs = Math.max(
    1_000,
    (Number(patrol?.shareIntervalMinutes) || 10) * 60_000
  );
  const deadlineWindowMs = Math.max(1, patrolDeadlineAt - Date.now());
  let nextShareAt = Date.now() + shareIntervalMs;

  while (Date.now() < patrolDeadlineAt) {
    const remainingMs = Math.max(0, patrolDeadlineAt - Date.now());
    const elapsedFraction = Math.min(
      1,
      Math.max(0, (deadlineWindowMs - remainingMs) / deadlineWindowMs)
    );
    await updateWorkflowProgress(
      context,
      progressStart + elapsedFraction * Math.max(0.01, 0.96 - progressStart),
      "patrol_waiting_deadline"
    );
    if (Date.now() >= nextShareAt) {
      await sharePatrolTeam(context, signal);
      await report("info", "patrol_share", "已再次分享到营地频道和场景频道");
      nextShareAt = Date.now() + shareIntervalMs;
    }
    const deadlineDelay = Math.max(250, patrolDeadlineAt - Date.now());
    const shareDelay = Math.max(0, nextShareAt - Date.now());
    await delay(Math.max(250, Math.min(deadlineDelay, shareDelay)), signal);
  }
  // From this point on the patrol run is in its terminal cleanup phase. Any
  // OCR/input error while closing the team panel or returning to the center
  // must not be treated as a reason to start a fresh scheduled attempt.
  context.suppressScheduledRetry = true;
  context.suppressScheduledRetryReason = "patrol_deadline_cleanup";
  await updateWorkflowProgress(context, 0.97, "patrol_cleanup");
  await report("info", "patrol_done", "已到巡逻任务结束时间");
  await closePatrolPanelBeforeExit(context, signal);
}

export async function ensureExistingPatrolTargetForSharing(context, signal) {
  const { config, ui, vision, report } = context;
  const controls = config?.patrolTeamUi || {};
  const sleep = context.sleep || delay;
  const objectiveRegion = controls.existingTeamObjectiveRegion || {
    left: 0,
    top: 0,
    right: 900,
    bottom: 120
  };
  const screen = await capturePatrolScreen(
    vision,
    "patrol-existing-route-objective",
    signal
  );
  const patrolObjective = await findAnyPatrolTextWithAccurateRegion(
    vision,
    screen,
    screen.observations,
    controls.existingTeamPatrolObjectiveTexts || [
      "营地事务>营地巡逻任务",
      "营地巡逻任务",
      "营地巡逻"
    ],
    objectiveRegion,
    "patrol-existing-route-objective-patrol",
    signal
  );
  if (patrolObjective) {
    await report(
      "info",
      "patrol_existing_route_patrol_objective",
      `已 OCR 确认队伍顶部目标为“${patrolObjective.text}”；按保卫古籍流程修改队伍目标`
    );
    await ui.executeFlow("switchToBookDefense", {}, signal);
    await sleep(
      Math.max(500, Number(controls.existingTeamPanelSettleMs) || 1_200),
      signal
    );
    const afterSwitch = await capturePatrolScreen(
      vision,
      "patrol-existing-route-book-defense-confirm",
      signal
    );
    const bookDefenseObjective = await findAnyPatrolTextWithAccurateRegion(
      vision,
      afterSwitch,
      afterSwitch.observations,
      controls.existingTeamBookDefenseObjectiveTexts || [
        "营地事务>保卫古籍",
        "保卫古籍"
      ],
      objectiveRegion,
      "patrol-existing-route-objective-book-defense",
      signal
    );
    if (!bookDefenseObjective) {
      throw new Error(
        "PATROL_EXISTING_ROUTE_BOOK_DEFENSE_UNVERIFIED: 已执行修改队伍目标，但顶部未确认保卫古籍"
      );
    }
    await report(
      "info",
      "patrol_existing_route_book_defense_confirmed",
      `已确认队伍顶部目标已修改为“${bookDefenseObjective.text}”，继续分享巡逻队`
    );
    return "switched";
  }

  const bookDefenseObjective = await findAnyPatrolTextWithAccurateRegion(
    vision,
    screen,
    screen.observations,
    controls.existingTeamBookDefenseObjectiveTexts || [
      "营地事务>保卫古籍",
      "保卫古籍"
    ],
    objectiveRegion,
    "patrol-existing-route-objective-book-defense",
    signal
  );
  if (bookDefenseObjective) {
    await report(
      "info",
      "patrol_existing_route_book_defense_already_set",
      `已 OCR 确认队伍顶部目标为“${bookDefenseObjective.text}”；不重复修改，继续分享巡逻队`
    );
    return "already-book-defense";
  }

  await patrolAiDiagnose(
    vision,
    report,
    "existing-route-objective",
    "确认队伍面板顶部目标是“营地事务>营地巡逻任务”还是“保卫古籍”。仅作诊断，不提供坐标，也不改变任务目标。",
    screen.observations,
    signal
  );
  await report(
    "warning",
    "patrol_existing_route_objective_unverified",
    "队伍面板顶部任务目标未被 OCR 确认；不盲点修改目标，沿用当前目标继续分享"
  );
  return "unverified";
}

export async function cleanupPatrolTeamOnFailure(context, signal, failure) {
  if (context.patrolFailureCleanupDone || signal?.aborted) return false;
  context.patrolFailureCleanupDone = true;
  const { ui, vision, report } = context;
  const controls = context.config?.patrolTeamUi || {};
  const sleep = context.sleep || delay;
  let screen = await capturePatrolScreen(
    vision,
    "patrol-failure-team-panel-check",
    signal
  );
  let panelVisible = patrolTeamPanelVisible(
    vision,
    screen.observations,
    context.config
  );
  if (!panelVisible && context.patrolTeamPhase !== "precreate") {
    await report(
      "warning",
      "patrol_failure_team_reopen",
      "巡逻任务失败后未看到队伍页面；尝试重新进入队伍页面以执行“离开队伍”清理",
      { reason: failure?.message || "unknown" }
    );
    try {
      await ui.executeFlow("openTeamPanel", {}, signal);
      await sleep(1_500, signal);
      screen = await capturePatrolScreen(
        vision,
        "patrol-failure-team-panel-after-reopen",
        signal
      );
      panelVisible = patrolTeamPanelVisible(
        vision,
        screen.observations,
        context.config
      );
    } catch (error) {
      await report(
        "warning",
        "patrol_failure_team_reopen_unverified",
        "巡逻失败后的队伍页面重新打开未确认；不盲点离队按钮",
        { reason: error.message }
      );
    }
  }
  const leaveMatch = findTextInRegion(
    vision,
    screen.observations,
    "离开队伍",
    controls.leaveTeamTextRegion || {
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1200
    }
  );
  if (!leaveMatch) {
    await report(
      "warning",
      "patrol_failure_team_leave_unverified",
      panelVisible
        ? "巡逻任务失败后已在队伍页面，但未 OCR 确认红色“离开队伍”按钮；不盲点离队"
        : "巡逻任务失败后未 OCR 确认队伍页面及“离开队伍”按钮；跳过离队清理",
      { reason: failure?.message || "unknown" }
    );
    return false;
  }
  const leavePoint = observationCenter(leaveMatch);
  await report(
    "warning",
    "patrol_failure_team_leave",
    "巡逻任务失败；已 OCR 确认队伍页面的“离开队伍”按钮，正在点击清理队伍状态",
    { leavePoint }
  );
  await tapPatrolMouse(ui, leavePoint, signal);
  await sleep(1_500, signal);
  const after = await capturePatrolScreen(
    vision,
    "patrol-failure-team-after-leave",
    signal
  );
  const stillVisible = findTextInRegion(
    vision,
    after.observations,
    "离开队伍",
    controls.leaveTeamTextRegion || {
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1200
    }
  );
  await report(
    stillVisible ? "warning" : "info",
    stillVisible
      ? "patrol_failure_team_leave_unverified"
      : "patrol_failure_team_left",
    stillVisible
      ? "点击“离开队伍”后仍识别到该按钮，离队状态未确认"
      : "巡逻失败后的队伍清理完成，已确认“离开队伍”按钮消失",
    { leavePoint }
  );
  return !stillVisible;
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
  const initialExisting = await resolveExistingPatrolTeam(
    context,
    screen,
    signal
  );
  if (initialExisting.mode === "existing-valid-route") {
    await report(
      "info",
      "patrol_existing_route_detected",
      "已确认当前队伍卡片右侧存在“巡逻路线进度”和“我的任务进度”；复用现有巡逻路线"
    );
    return "existing-valid-route";
  }
  screen = initialExisting.screen || screen;
  if (initialExisting.mode === "existing-invalid-left") {
    screen = await recoverPatrolCreateEntryAfterExistingTeamLeave(
      context,
      screen,
      signal
    );
  } else {
    screen = await closePatrolTaskGuideOverlayIfVisible(
      context,
      screen,
      signal,
      "巡逻旗帜点击前"
    );
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
    await ensurePatrolFlagClickColor(context, screen, signal);
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
      if (attempt >= 3 && typeof ui.recheckGameMouseForRetry === "function") {
        await ui.recheckGameMouseForRetry(
          signal,
          `巡逻旗帜同一步连续点击失败 ${attempt - 1} 次，重试第 ${attempt} 次`
        );
      }
      await report(
        "info",
        attempt === 1
          ? "patrol_flag_click"
          : "patrol_flag_mouse_focus_retry",
        attempt === 1
          ? `已确认${flagReady ? "旗帜快捷键提示" : `底部 ${channelReadyCount} 个频道 HUD`}锚点；沿用 HUD 后状态直接执行 ADB 触屏点击 (${controls.flagButton.x},${controls.flagButton.y})`
          : `旗帜点击后仍未出现队伍菜单；第 ${attempt} 次点击前仅因前两次失败才重检游戏鼠标状态 (${controls.flagButton.x},${controls.flagButton.y})`
      );
      await tapPatrolMouse(ui, controls.flagButton, signal, { gameMouse: true });
      await sleep(settleMs, signal);
      screen = await capturePatrolScreen(
        vision,
        attempt === 1
          ? "patrol-team-menu-open"
          : `patrol-team-menu-open-${attempt}`,
        signal
      );
      const screenAfterOverlayClose = await closePatrolTaskGuideOverlayIfVisible(
        context,
        screen,
        signal,
        "旗帜点击后"
      );
      if (screenAfterOverlayClose !== screen) {
        screen = screenAfterOverlayClose;
        await report(
          "warning",
          "patrol_flag_overlay_blocked",
          "旗帜点击后出现任务导航遮挡；已先关闭右侧安全空白处的遮挡，不再在遮挡上重复点击旗帜"
        );
      }
      const existing = await resolveExistingPatrolTeam(
        context,
        screen,
        signal
      );
      if (existing.mode === "existing-valid-route") {
        await report(
          "info",
          "patrol_existing_route_detected",
          "点击旗帜后确认现有队伍持有有效营地巡逻路线；不进入创建队伍流程"
        );
        return "existing-valid-route";
      }
      screen = existing.screen || screen;
      if (existing.mode === "existing-invalid-left") {
        screen = await recoverPatrolCreateEntryAfterExistingTeamLeave(
          context,
          screen,
          signal
        );
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
    if (inspectExistingPatrolTeamState(vision, screen.observations, controls).validRoute) {
      await report(
        "info",
        "patrol_existing_route_detected",
        "旗帜入口重试后确认现有队伍仍持有有效营地巡逻路线；不进入创建队伍流程"
      );
      return "existing-valid-route";
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
      screen = await closePatrolTaskGuideOverlayIfVisible(
        context,
        screen,
        signal,
        "Ctrl+Q 入口点击后"
      );
      const existing = await resolveExistingPatrolTeam(
        context,
        screen,
        signal
      );
      if (existing.mode === "existing-valid-route") {
        await report(
          "info",
          "patrol_existing_route_detected",
          "Ctrl+Q 后确认现有队伍持有有效营地巡逻路线；不进入创建队伍流程"
        );
        return "existing-valid-route";
      }
      screen = existing.screen || screen;
      if (existing.mode === "existing-invalid-left") {
        screen = await recoverPatrolCreateEntryAfterExistingTeamLeave(
          context,
          screen,
          signal
        );
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
      if (attempt >= 3 && typeof ui.recheckGameMouseForRetry === "function") {
        await ui.recheckGameMouseForRetry(
          signal,
          `巡逻创建队伍入口同一步连续点击失败 ${attempt - 1} 次，重试第 ${attempt} 次`
        );
      }
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
      // 保持与营地频道相同的图标检测和 ADB 触屏点击。
      const createMenuPoint = controls.createMenuPoint || { x: 220, y: 180 };
      await report(
        attempt === 1 ? "info" : "warning",
        "patrol_create_menu_click",
        `第 ${attempt}/${createMenuClickAttempts} 次：已在左侧区域精确识别“创建队伍”；沿用 HUD 后状态执行 ADB 触屏点击${attempt >= 3 ? "（前两次失败后已重检游戏鼠标）" : ""} (${Math.round(createMenuPoint.x)},${Math.round(createMenuPoint.y)})`
      );
      await tapPatrolMouse(ui, createMenuPoint, signal, { gameMouse: true });
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
          `第 ${attempt} 次点击左侧入口后仍未确认创建页面；下一次重新检查图标后重试 ADB 触屏点击`
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
  screen = await capturePatrolScreen(
    vision,
    "patrol-camp-affairs-selected",
    signal
  );
  let selection = await readPatrolCreationSelection(
    vision,
    screen,
    controls,
    "patrol-camp-affairs-selected",
    signal
  );
  let patrolTargetMatch = selection.patrolTargetMatch;
  const patrolTargetReadAttempts = Math.max(
    1,
    Math.min(5, Number(controls.patrolTargetReadAttempts) || 3)
  );
  for (let attempt = 1; attempt <= patrolTargetReadAttempts; attempt += 1) {
    if (selection.valid) break;
    if (attempt < patrolTargetReadAttempts) {
      await report(
        "warning",
        "patrol_target_ocr_reread",
        `第 ${attempt}/${patrolTargetReadAttempts} 次 OCR 未同时确认左侧“营地事务”和右侧“营地巡逻任务”；保持当前页面原地重读`
      );
      await sleep(1_000, signal);
      screen = await capturePatrolScreen(
        vision,
        `patrol-camp-affairs-selected-reread-${attempt + 1}`,
        signal
      );
      selection = await readPatrolCreationSelection(
        vision,
        screen,
        controls,
        `patrol-camp-affairs-selected-reread-${attempt + 1}`,
        signal
      );
      patrolTargetMatch = selection.patrolTargetMatch;
    }
  }
  if (!selection.valid) {
    if (selection.campAffairsMatch) {
      await report(
        "warning",
        "patrol_camp_affairs_wrong_target",
        `已 OCR 看到左侧“${selection.campAffairsMatch.text}”，但右侧不是“营地巡逻任务”；改点该分类后重新读取右侧任务`
      );
      await tapPatrolMouse(
        ui,
        observationCenter(selection.campAffairsMatch),
        signal
      );
      await sleep(campAffairsWaitMs, signal);
      screen = await capturePatrolScreen(
        vision,
        "patrol-camp-affairs-corrected",
        signal
      );
      selection = await readPatrolCreationSelection(
        vision,
        screen,
        controls,
        "patrol-camp-affairs-corrected",
        signal
      );
      patrolTargetMatch = selection.patrolTargetMatch;
    }
  }
  if (!selection.valid) {
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
        selection = await readPatrolCreationSelection(
          vision,
          screen,
          controls,
          `patrol-camp-affairs-scroll-reread-${attempt}`,
          signal
        );
        patrolTargetMatch = selection.patrolTargetMatch;
        if (selection.valid) break;
        if (attempt < patrolTargetReadAttempts) {
          await sleep(1_000, signal);
        }
      }
    }
  }
  if (!selection.valid) {
    await patrolAiDiagnose(
      vision,
      report,
      "patrol-target",
      "队伍目标创建页：确认左侧选中“营地事务”，中央右侧清晰显示“营地巡逻任务”。如果左侧底部有滚动列表，确认是否只是分类未滚动到位。仅作诊断。",
      screen.observations,
      signal
    );
    throw new Error(
      "PATROL_TARGET_SELECTION_NOT_VISIBLE: 未同时确认左侧“营地事务”和右侧“营地巡逻任务”"
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
  selection = await readPatrolCreationSelection(
    vision,
    screen,
    controls,
    "patrol-target-selected",
    signal
  );
  if (
    !selection.valid ||
    !hasTextInRegion(
      vision,
      screen.observations,
      "创建队伍",
      controls.createButtonRegion
    )
  ) {
    throw new Error(
      "PATROL_TARGET_SELECTION_UNVERIFIED: 未同时确认左侧营地事务、右侧营地巡逻任务和创建按钮，禁止创建"
    );
  }

  await report(
    "info",
    "patrol_create_submit",
    "已确认“营地事务>营地巡逻任务”，点击创建页面右下角的最终“创建队伍”按钮"
  );
  await tapPatrolMouse(ui, controls.createButtonPoint, signal, { gameMouse: true });
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
  return "created";
}

async function resolveExistingPatrolTeam(context, screen, signal) {
  const { config, ui, vision, report } = context;
  const controls = config?.patrolTeamUi || {};
  let current = screen;
  let state = await inspectExistingPatrolTeamStateWithColor(
    context,
    current,
    signal
  );
  if (state.validRoute) {
    return { mode: "existing-valid-route", screen: current };
  }
  if (!state.hasTeam) {
    return { mode: "none", screen: current };
  }

  if (!state.panel) {
    await report(
      "info",
      "patrol_existing_team_open",
      "旗帜入口未出现“创建队伍”，但检测到已有队伍卡片；先打开队伍面板再确认巡逻路线"
    );
    await ui.executeFlow("openTeamPanel", {}, signal);
    await (context.sleep || delay)(
      Math.max(500, Number(controls.existingTeamPanelSettleMs) || 1_200),
      signal
    );
    current = await capturePatrolScreen(
      vision,
      "patrol-existing-team-panel",
      signal
    );
    state = await inspectExistingPatrolTeamStateWithColor(
      context,
      current,
      signal
    );
    if (state.validRoute) {
      return { mode: "existing-valid-route", screen: current };
    }
  }

  await report(
    "warning",
    "patrol_existing_team_without_route",
    "已确认存在队伍，但未识别到“巡逻路线进度+我的任务进度”有效路线卡；准备退出队伍并重新创建"
  );
  await leaveExistingPatrolTeam(context, current, signal);
  current = await capturePatrolScreen(
    vision,
    "patrol-existing-team-after-leave",
    signal
  );
  return { mode: "existing-invalid-left", screen: current };
}

async function inspectExistingPatrolTeamStateWithColor(context, screen, signal) {
  const { config, vision } = context;
  const controls = config?.patrolTeamUi || {};
  const state = inspectExistingPatrolTeamState(
    vision,
    screen.observations,
    controls
  );
  const color = await patrolTeamCardColorState(context, screen, signal);
  if (color.teamCardSelected) {
    return {
      ...state,
      hasTeam: true,
      cardEvidence: true,
      colorEvidence: true
    };
  }
  return { ...state, colorEvidence: color };
}

async function recoverPatrolCreateEntryAfterExistingTeamLeave(
  context,
  initialScreen,
  signal
) {
  return closePatrolTaskGuideOverlayIfVisible(
    context,
    initialScreen,
    signal,
    "离开无效队伍后"
  );
}

async function closePatrolTaskGuideOverlayIfVisible(
  context,
  initialScreen,
  signal,
  reason
) {
  const { config, ui, vision, report } = context;
  const sleep = context.sleep || delay;
  const taskGuideFlow = config?.flows?.closeTaskGuideOverlay;
  const taskGuideAction = Array.isArray(taskGuideFlow)
    ? taskGuideFlow.find((action) => action?.op === "closeTaskGuideOverlay")
    : null;
  if (!taskGuideAction) return initialScreen;
  const taskGuideMarkers = taskGuideOverlayMarkerCount(
    vision,
    initialScreen.observations,
    taskGuideAction
  );
  if (
    taskGuideMarkers <
    Math.max(2, Number(taskGuideAction.minimumTexts) || 3)
  ) {
    return initialScreen;
  }
  if (typeof ui?.executeFlow !== "function") {
    throw new Error(
      "PATROL_TASK_GUIDE_OVERLAY_BLOCKING: 检测到任务导航遮挡，但当前 UI 执行器不支持安全关闭"
    );
  }
  await report(
    "info",
    "patrol_task_guide_overlay_close",
    `${reason}检测到左半屏任务导航遮挡（${taskGuideMarkers} 个特征字），先点击右半屏安全空白位置关闭遮挡`
  );
  await ui.executeFlow("closeTaskGuideOverlay", {}, signal);
  await sleep(500, signal);
  const recovered = await capturePatrolScreen(
    vision,
    "patrol-task-guide-overlay-closed",
    signal
  );
  const remainingMarkers = taskGuideOverlayMarkerCount(
    vision,
    recovered.observations,
    taskGuideAction
  );
  if (
    remainingMarkers >=
    Math.max(2, Number(taskGuideAction.minimumTexts) || 3)
  ) {
    throw new Error(
      "PATROL_TASK_GUIDE_OVERLAY_NOT_CLOSED: 关闭任务导航遮挡后仍识别到左半屏遮挡，禁止继续点击旗帜"
    );
  }
  return recovered;
}

function patrolPostLeaveEntryVisible(vision, observations, controls, config) {
  const createMenu = hasTextInRegion(
    vision,
    observations,
    "创建队伍",
    controls.teamMenuRegion
  );
  const creator = patrolCreatorOpen(vision, observations, controls);
  const flagReady = (controls.flagReadyTexts || ["CtrlQ", "Ctrl Q"]).some(
    (text) => hasTextInRegion(vision, observations, text, controls.flagReadyRegion)
  );
  const channelConfig = config?.postLoginPromotions;
  const channelReadyCount = (channelConfig?.channelReadyTexts || []).filter(
    (text) =>
      hasTextInRegion(
        vision,
        observations,
        text,
        channelConfig.channelReadyRegion
      )
  ).length;
  const channelReady =
    channelReadyCount >=
    Math.max(2, Number(channelConfig?.channelReadyMinimumTexts) || 2);
  return createMenu || creator || flagReady || channelReady;
}

function taskGuideOverlayMarkerCount(vision, observations, action) {
  const texts = action?.texts || ["任务", "当前", "导航", "追踪"];
  const region = action?.region || {
    left: 0,
    top: 0,
    right: 960,
    bottom: 1200
  };
  return texts.filter((text) => hasTextInRegion(vision, observations, text, region)).length;
}

async function patrolTeamCardColorState(context, screen, signal) {
  const controls = context.config?.patrolTeamUi || {};
  const color = controls.teamCardColor;
  if (!color || color.enabled === false) {
    return { enabled: false, state: "unconfigured" };
  }
  if (!screen?.frame?.path || typeof context.vision?.probe !== "function") {
    return { enabled: true, state: "unavailable" };
  }
  const taskPoints = color.taskIconPoints || [{ x: 48, y: 150 }];
  const taskBackgroundPoints = color.taskIconBackgroundPoints || [
    { x: 16, y: 150 },
    { x: 80, y: 150 }
  ];
  const flagPoints = color.teamFlagIconPoints || [{ x: 48, y: 327 }];
  const flagBackgroundPoints = color.teamFlagBackgroundPoints || [
    { x: 16, y: 327 },
    { x: 80, y: 327 }
  ];
  const taskOffset = taskPoints.length;
  const flagOffset = taskOffset + taskBackgroundPoints.length;
  const points = [
    ...taskPoints,
    ...taskBackgroundPoints,
    ...flagPoints,
    ...flagBackgroundPoints
  ];
  let probes;
  try {
    probes = await context.vision.probe(
      screen.frame.path,
      points,
      Math.max(3, Number(color.probeRadius) || 8),
      signal
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    await context.report(
      "warning",
      "patrol_team_card_color_probe_failed",
      "队伍卡片色块探测失败；本轮禁止根据不完整色块结果点击旗帜",
      { reason: error?.message || String(error) }
    );
    return { enabled: true, state: "unavailable" };
  }
  const taskForeground = probes?.slice(0, taskOffset) || [];
  const taskBackground = probes?.slice(taskOffset, flagOffset) || [];
  const flagForeground = probes?.slice(flagOffset, flagOffset + flagPoints.length) || [];
  const flagBackground = probes?.slice(flagOffset + flagPoints.length) || [];
  const taskSelected = patrolWarmIconGroup(
    taskForeground,
    taskBackground,
    color
  );
  const flagSelected = patrolWarmIconGroup(
    flagForeground,
    flagBackground,
    color
  );
  const state =
    flagSelected && !taskSelected
      ? "team-card"
      : taskSelected && !flagSelected
        ? "task-card"
        : "ambiguous";
  return {
    enabled: true,
    state,
    taskSelected,
    flagSelected,
    taskCardSelected: state === "task-card",
    teamCardSelected: state === "team-card"
  };
}

function patrolWarmIconGroup(foreground, background, config) {
  const redBlueDelta = Number.isFinite(Number(config.redBlueDelta))
    ? Number(config.redBlueDelta)
    : 0.2;
  const greenBlueDelta = Number.isFinite(Number(config.greenBlueDelta))
    ? Number(config.greenBlueDelta)
    : 0.12;
  const minimumSaturation = Number.isFinite(Number(config.minimumSaturation))
    ? Number(config.minimumSaturation)
    : 0.45;
  const minimumLuminance = Number.isFinite(Number(config.minimumLuminance))
    ? Number(config.minimumLuminance)
    : 0.42;
  const warm = (probe) => {
    const red = Number(probe?.meanRed);
    const green = Number(probe?.meanGreen);
    const blue = Number(probe?.meanBlue);
    const saturation = Number(probe?.meanSaturation);
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    return {
      red,
      green,
      blue,
      saturation,
      luminance,
      valid:
        [red, green, blue, saturation].every(Number.isFinite) &&
        red - blue >= redBlueDelta &&
        green - blue >= greenBlueDelta &&
        saturation >= minimumSaturation &&
        luminance >= minimumLuminance
    };
  };
  // Use every finite background sample as the local baseline.  The building
  // behind the notice board may itself be warm-colored, but it is still a
  // valid baseline even when it does not meet the foreground icon's yellow
  // saturation threshold.
  const backgroundSamples = background
    .map(warm)
    .filter((sample) => Number.isFinite(sample.luminance));
  if (!backgroundSamples.length) return false;
  const backgroundLuminance = Math.max(...backgroundSamples.map((sample) => sample.luminance));
  const backgroundRed = Math.max(...backgroundSamples.map((sample) => sample.red));
  const backgroundGreen = Math.max(...backgroundSamples.map((sample) => sample.green));
  const minimumLuminanceDelta = Number(config.minimumForegroundBackgroundLuminanceDelta) || 0.12;
  const minimumChannelDelta = Number(config.minimumForegroundBackgroundChannelDelta) || 0.08;
  const warmSamples = foreground.map(warm).filter(
    (sample) =>
      sample.valid &&
      (sample.luminance - backgroundLuminance >= minimumLuminanceDelta ||
        (sample.red - backgroundRed >= minimumChannelDelta &&
          sample.green - backgroundGreen >= minimumChannelDelta))
  );
  return warmSamples.length >= Math.max(1, Number(config.minimumWarmPoints) || 1);
}

async function ensurePatrolFlagClickColor(context, screen, signal) {
  const color = await patrolTeamCardColorState(context, screen, signal);
  if (!color.enabled) return;
  if (color.teamCardSelected) {
    throw new Error(
      "PATROL_FLAG_CLICK_FORBIDDEN_TEAM_CARD: 色块已确认旗帜队伍卡片处于选中状态，禁止再次点击旗帜"
    );
  }
  if (!color.taskCardSelected) {
    throw new Error(
      `PATROL_FLAG_COLOR_UNVERIFIED: 未确认默认任务图标黄色且旗帜图标未选中（state=${color.state}），禁止点击旗帜`
    );
  }
  await context.report(
    "info",
    "patrol_flag_color_ready",
    "已通过左侧任务图标/旗帜图标的局部色块对比确认当前仍是默认任务卡片；允许点击旗帜一次"
  );
}

function inspectExistingPatrolTeamState(vision, observations, controls) {
  const routeRegion = controls.existingTeamRouteRegion || {
    left: 0,
    top: 0,
    right: 760,
    bottom: 460
  };
  const cardRegion = controls.existingTeamCardRegion || {
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1180
  };
  const routeProgress = findAnyTextInRegion(
    vision,
    observations,
    controls.existingTeamRouteProgressTexts || [
      "巡逻路线进度",
      "巡逻路线",
      "巡逻路線進度",
      "巡逻路線"
    ],
    routeRegion
  );
  const taskProgress = findAnyTextInRegion(
    vision,
    observations,
    controls.existingTeamTaskProgressTexts || [
      "我的任务进度",
      "任务进度",
      "我的任務進度",
      "任務進度"
    ],
    routeRegion
  );
  const hasTaskFraction = observations.some((item) => {
    const text = String(item?.text || "").replace(/\s+/g, "");
    return /(?:^|[^\d])\d+\/4(?:$|[^\d])/.test(text);
  });
  const teamCard = findAnyTextInRegion(
    vision,
    observations,
    controls.existingTeamCardTexts || [
      "营地巡逻任务",
      "保卫古籍",
      "自动匹配",
      "暂无队员加入",
      "调整",
      "离开队伍"
    ],
    cardRegion
  );
  const teamStatus = findAnyTextInRegion(
    vision,
    observations,
    controls.existingTeamStatusTexts || [
      "自动匹配",
      "暂无队员加入",
      "等待队员加入"
    ],
    cardRegion
  );
  const waitingOrMatchStatus = findAnyTextInRegion(
    vision,
    observations,
    controls.existingTeamMemberStatusTexts || [
      "自动匹配",
      "暂无队员加入",
      "等待队员加入"
    ],
    cardRegion
  );
  const adjustVisible = hasTextInRegion(
    vision,
    observations,
    "调整",
    cardRegion
  );
  const leaveVisible = hasTextInRegion(
    vision,
    observations,
    "离开队伍",
    cardRegion
  );
  const hasCardFraction = observationsInRegion(observations, cardRegion).some(
    (item) => /\d+\s*\/\s*\d+/.test(String(item?.text || ""))
  );
  const memberEvidence = patrolTeamMemberCardEvidence(
    observations,
    controls
  );
  // A route fraction or a generic word such as “调整” can come from an
  // unrelated task/guide overlay. Require a team-specific status, both team
  // panel controls, or a name+location pair inside a calibrated member card
  // before treating the screen as an existing team.
  const panel = Boolean(adjustVisible && leaveVisible);
  const cardEvidence = Boolean(waitingOrMatchStatus || panel || memberEvidence);
  return {
    validRoute: Boolean(
      cardEvidence && routeProgress && (taskProgress || hasTaskFraction)
    ),
    hasTeam: cardEvidence,
    routeProgress,
    taskProgress,
    teamCard,
    teamStatus,
    hasCardFraction,
    panel,
    memberEvidence,
    cardEvidence
  };
}

function patrolTeamMemberCardEvidence(observations, controls) {
  const slotRegions = controls.teamMemberSlotRegions || [];
  const locationRegions = controls.teamMemberLocationRegions || [];
  if (!slotRegions.length || !locationRegions.length) return false;
  return slotRegions.some((slotRegion, index) => {
    const locationRegion = locationRegions[index];
    if (!locationRegion) return false;
    const memberTexts = observationsInRegion(observations, slotRegion).filter(
      (item) => isLikelyPatrolMemberText(item?.text, controls)
    );
    const locationTexts = observationsInRegion(
      observations,
      locationRegion
    ).filter((item) => isLikelyPatrolMemberText(item?.text, controls));
    return memberTexts.length > 0 && locationTexts.length > 0;
  });
}

function isLikelyPatrolMemberText(value, controls) {
  const text = String(value || "").replace(/\s+/g, "").trim();
  if (!text || text.length > 24 || /^\d+(?:\/\d+)?$/.test(text)) return false;
  const excluded = new Set(
    controls.existingTeamMemberEvidenceExcludedTexts || [
      "营地巡逻任务",
      "保卫古籍",
      "巡逻路线进度",
      "我的任务进度",
      "自动匹配",
      "暂无队员加入",
      "等待队员加入",
      "调整",
      "离开队伍",
      "综合",
      "世界",
      "场景",
      "营地",
      "任务",
      "当前",
      "导航",
      "追踪"
    ]
  );
  if (excluded.has(text)) return false;
  if (/^(?:Ctrl\s*Tab|Tab|Enter|Space|Alt|F|J|G|C|B|Z)$/i.test(text)) {
    return false;
  }
  return /[\p{L}\p{Script=Han}]/u.test(text);
}

async function leaveExistingPatrolTeam(context, initialScreen, signal) {
  const { config, ui, vision, report } = context;
  const controls = config?.patrolTeamUi || {};
  const sleep = context.sleep || delay;
  const leaveRegion = controls.leaveTeamTextRegion || {
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1200
  };
  const confirmRegion = controls.leaveTeamConfirmRegion || {
    left: 760,
    top: 420,
    right: 1380,
    bottom: 850
  };
  const maxAttempts = Math.max(
    1,
    Math.min(5, Number(controls.leaveTeamAttempts) || 3)
  );
  let screen = initialScreen;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const leaveMatch = await findPatrolTextWithAccurateRegion(
      vision,
      screen,
      screen.observations,
      "离开队伍",
      leaveRegion,
      `patrol-existing-team-leave-${attempt}`,
      signal
    );
    if (!leaveMatch) {
      throw new Error(
        "PATROL_EXISTING_TEAM_LEAVE_UNVERIFIED: 未 OCR 确认已有队伍面板中的“离开队伍”按钮"
      );
    }
    const leavePoint = observationCenter(leaveMatch);
    await report(
      attempt === 1 ? "warning" : "info",
      "patrol_existing_team_leave_click",
      `第 ${attempt}/${maxAttempts} 次：已 OCR 确认“离开队伍”，点击文字中心退出已有队伍`,
      { leavePoint }
    );
    await tapPatrolMouse(ui, leavePoint, signal);
    await sleep(
      Math.max(500, Number(controls.leaveTeamSettleMs) || 1_500),
      signal
    );
    screen = await capturePatrolScreen(
      vision,
      `patrol-existing-team-after-leave-click-${attempt}`,
      signal
    );
    const confirmMatch = findAnyTextInRegion(
      vision,
      screen.observations,
      controls.leaveTeamConfirmTexts || ["确认(F)", "确定(F)", "确认"],
      confirmRegion
    );
    if (confirmMatch) {
      const confirmPoint = observationCenter(confirmMatch);
      await report(
        "warning",
        "patrol_existing_team_leave_confirm",
        "已识别退出队伍确认弹窗，点击 OCR 确认按钮完成离队",
        { confirmPoint }
      );
      await tapPatrolMouse(ui, confirmPoint, signal);
      await sleep(
        Math.max(500, Number(controls.leaveTeamSettleMs) || 1_500),
        signal
      );
      screen = await capturePatrolScreen(
        vision,
        `patrol-existing-team-after-leave-confirm-${attempt}`,
        signal
      );
    }
    screen = await closePatrolTaskGuideOverlayIfVisible(
      context,
      screen,
      signal,
      "离队校验画面"
    );
    const stillVisible = findTextInRegion(
      vision,
      screen.observations,
      "离开队伍",
      leaveRegion
    );
    const postLeaveEntryVisible = patrolPostLeaveEntryVisible(
      vision,
      screen.observations,
      controls,
      config
    );
    if (!stillVisible || postLeaveEntryVisible) {
      await report(
        "info",
        postLeaveEntryVisible && stillVisible
          ? "patrol_existing_team_left_stale_text_recovered"
          : "patrol_existing_team_left",
        postLeaveEntryVisible && stillVisible
          ? "离队后仍有残留“离开队伍”OCR，但已确认 HUD/创建入口恢复；按离队成功处理并继续全新巡逻队创建流程"
          : "已确认原有队伍退出成功，继续执行全新巡逻队创建流程"
      );
      return;
    }
    if (attempt < maxAttempts) {
      await report(
        "warning",
        "patrol_existing_team_leave_retry",
        `第 ${attempt} 次点击后“离开队伍”仍存在；重新 OCR 确认后重试离队（${attempt + 1}/${maxAttempts}）`
      );
      await sleep(500, signal);
    }
  }
  throw new Error(
    `PATROL_EXISTING_TEAM_LEAVE_FAILED: 连续 ${maxAttempts} 次 OCR 点击后仍未确认退出已有队伍`
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

async function readPatrolCreationSelection(
  vision,
  screen,
  controls,
  label,
  signal
) {
  const categoryRegion = controls.campAffairsTextRegion || {
    left: 330,
    top: 220,
    right: 640,
    bottom: 1_000
  };
  const targetRegion = controls.patrolTargetRegion || {
    left: 650,
    top: 300,
    right: 1_180,
    bottom: 560
  };
  const campAffairsMatch = await findAnyPatrolTextWithAccurateRegion(
    vision,
    screen,
    screen.observations,
    controls.campAffairsTexts || ["营地事务", "营地事物"],
    categoryRegion,
    `${label}-camp-affairs`,
    signal
  );
  const patrolTargetMatch = await findAnyPatrolTextWithAccurateRegion(
    vision,
    screen,
    screen.observations,
    controls.patrolTargetTexts || ["营地巡逻任务", "营地巡逻"],
    targetRegion,
    `${label}-patrol-target`,
    signal
  );
  return {
    campAffairsMatch,
    patrolTargetMatch,
    valid: Boolean(campAffairsMatch && patrolTargetMatch)
  };
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

async function findAnyPatrolTextWithAccurateRegion(
  vision,
  screen,
  observations,
  texts,
  region,
  label,
  signal
) {
  for (const text of texts || []) {
    const match = await findPatrolTextWithAccurateRegion(
      vision,
      screen,
      observations,
      text,
      region,
      `${label}-${text}`,
      signal
    );
    if (match) return match;
  }
  return null;
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

  const shareAttempts = Math.max(
    1,
    Math.min(
      10,
      Number(controls.channelAttempts) ||
        Number(controls.recruitAttempts) ||
        10
    )
  );

  const common = {
    controls,
    ui,
    adb,
    vision,
    report,
    sleep,
    settleMs,
    recruitMenuWaitMs,
    shareAttempts
  };
  const channelTargets = [
    {
      key: "camp",
      text: "营地频道",
      texts: controls.campChannelTexts || ["营地频道"],
      textRegion: controls.campChannelTextRegion || controls.channelMenuRegion,
      successTexts: controls.successTexts || ["成功分享至营地频道", "分享成功"]
    },
    {
      key: "scene",
      text: "场景频道",
      texts: controls.sceneChannelTexts || ["场景频道", "场景"],
      textRegion:
        controls.sceneChannelTextRegion ||
        controls.campChannelTextRegion ||
        controls.channelMenuRegion,
      successTexts: controls.sceneSuccessTexts || ["成功分享至场景频道", "分享成功"]
    }
  ];
  for (const target of channelTargets) {
    const result = await sharePatrolChannel(
      context,
      signal,
      common,
      target
    );
    if (result.skipped) {
      await report(
        "info",
        "patrol_share_skipped_no_target",
        `连续 ${result.noTargetMenuAttempts} 次点击“招募”均未弹出分享目标选项；当前队伍可能已满员，本次${target.text}分享跳过，不计为任务失败`
      );
      return;
    }
    await report(
      "info",
      "patrol_share_success",
      `已确认“成功分享至${target.text}”`
    );
    await sleep(settleMs, signal);
  }
}

async function sharePatrolChannel(context, signal, common, target) {
  const {
    controls,
    ui,
    adb,
    vision,
    report,
    sleep,
    settleMs,
    recruitMenuWaitMs,
    shareAttempts
  } = common;
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
  const fullTeamTexts = controls.fullTeamTexts || [
    "队伍已满员，无法再加入",
    "队伍已满员"
  ];
  const fullTeamRegion = controls.fullTeamRegion || {
    left: 400,
    top: 120,
    right: 1_400,
    bottom: 360
  };
  let channelMenuVisible = false;
  let noTargetMenuAttempts = 0;
  for (let attempt = 1; attempt <= shareAttempts; attempt += 1) {
    await report(
      "info",
      attempt === 1
        ? "patrol_share_recruit"
        : "patrol_share_recruit_focus_retry",
      attempt === 1
        ? `已确认队伍页面，点击“招募”准备分享${target.text}`
        : `第 ${attempt - 1} 次点击后仍未识别到“${target.text}”；执行第 ${attempt}/${shareAttempts} 次重新 OCR 并点击“招募”`
    );
    const screen = await capturePatrolScreen(
      vision,
      `patrol-share-${target.key}-recruit-verify-${attempt}`,
      signal
    );
    const recruit = await findRecruitControlForShare(
      context,
      screen,
      {
        attempt,
        target,
        recruitTextRegion,
        recruitOverlayTexts,
        recruitOverlayRegion,
        recruitOverlayDismissPoint
      },
      signal
    );
    if (recruit.dismissed) {
      await sleep(settleMs, signal);
      continue;
    }
    if (!recruit.match) {
      await report(
        "warning",
        "patrol_share_recruit_unverified",
        `第 ${attempt}/${shareAttempts} 次点击前仍未确认“招募”；已完成高精度复读和遮挡诊断，不点击“更换队伍”或任何盲点`
      );
      await sleep(settleMs, signal);
      continue;
    }
    const recruitMatch = recruit.match;
    const recruitClickPoint = recruit.recovered
      ? observationCenter(recruitMatch)
      : recruitPoint;
    await report(
      "info",
      "patrol_share_recruit_verified",
      recruit.recovered
        ? `高精度 OCR 已补读“招募”按钮位置，点击文字中心 (${Math.round(recruitClickPoint.x)},${Math.round(recruitClickPoint.y)})`
        : `OCR 已在底部招募行确认“招募”，点击固定招募按钮中心 (${Math.round(recruitClickPoint.x)},${Math.round(recruitClickPoint.y)})`,
      { point: recruitClickPoint, recovered: recruit.recovered }
    );
    await tapPatrolHudMouse(ui, adb, recruitClickPoint, signal, sleep);
    // The full-team toast is deterministic but short-lived. Sample once
    // immediately after the recruit tap before waiting for the channel menu;
    // the later menu capture remains the normal-path/backup check.
    const immediateFullTeamScreen = await capturePatrolScreen(
      vision,
      `patrol-share-${target.key}-full-team-immediate-${attempt}`,
      signal
    );
    const immediateFullTeamMatch = findAnyTextInRegion(
      vision,
      immediateFullTeamScreen.observations,
      fullTeamTexts,
      fullTeamRegion
    );
    if (immediateFullTeamMatch) {
      await report(
        "info",
        "patrol_share_full_team_confirmed",
        `点击“招募”后立即识别到“${immediateFullTeamMatch.text}”；确认队伍已满员，本次${target.text}分享跳过，不计为任务失败`
      );
      return { skipped: true, noTargetMenuAttempts: 1 };
    }
    await report(
      "info",
      "patrol_share_channel_wait",
      `已点击“招募”，等待 3 秒让分享${target.text}列表稳定后再 OCR`
    );
    await sleep(recruitMenuWaitMs, signal);
    const menuScreen = await capturePatrolScreen(
      vision,
      `patrol-share-${target.key}-channel-menu-${attempt}`,
      signal
    );
    const fullTeamMatch = findAnyTextInRegion(
      vision,
      menuScreen.observations,
      fullTeamTexts,
      fullTeamRegion
    );
    if (fullTeamMatch) {
      await report(
        "info",
        "patrol_share_full_team_hint",
        `点击“招募”后检测到短暂提示“${fullTeamMatch.text}”；仅作为满员辅助证据，仍继续检查分享目标选项`
      );
    }
    const inviteOverlayMatch = findAnyTextInRegion(
      vision,
      menuScreen.observations,
      recruitOverlayTexts,
      recruitOverlayRegion
    );
    if (inviteOverlayMatch) {
      noTargetMenuAttempts += 1;
      await report(
        "warning",
        "patrol_share_invite_overlay_detected",
        `点击“招募”误打开邀请卡片（识别到“${inviteOverlayMatch.text}”）；点击卡片边框外空白点 (${Math.round(recruitOverlayDismissPoint.x)},${Math.round(recruitOverlayDismissPoint.y)}) 关闭后重试招募（第 ${attempt}/${shareAttempts} 次）`,
        { dismissPoint: recruitOverlayDismissPoint, overlayRegion: recruitOverlayRegion }
      );
      await tapPatrolMouse(ui, recruitOverlayDismissPoint, signal);
      if (noTargetMenuAttempts >= 5) {
        return { skipped: true, noTargetMenuAttempts };
      }
      await sleep(settleMs, signal);
      continue;
    }
    const channelMatch = findAnyTextInRegion(
      vision,
      menuScreen.observations,
      target.texts,
      target.textRegion
    );
    if (!channelMatch) {
      noTargetMenuAttempts += 1;
      await report(
        "warning",
        "patrol_share_channel_menu_unverified",
        `第 ${attempt}/${shareAttempts} 轮点击“招募”后未识别到“${target.text}”；等待 3 秒后重新点击“招募”再识别`
      );
      if (fullTeamMatch) {
        await report(
          "info",
          "patrol_share_full_team_confirmed",
          `“${fullTeamMatch.text}”与未出现分享目标选项同时成立，判定队伍已满员；本次${target.text}分享跳过，不计为任务失败`
        );
        return { skipped: true, noTargetMenuAttempts };
      }
      if (noTargetMenuAttempts >= 5) {
        return { skipped: true, noTargetMenuAttempts };
      }
      continue;
    }
    channelMenuVisible = true;
    noTargetMenuAttempts = 0;
    await report(
      "info",
      `patrol_share_${target.key}_channel_verified`,
      `第 ${attempt}/${shareAttempts} 轮已 OCR 确认“${target.text}”，将点击文字中心`
    );
    const channelPoint = observationCenter(channelMatch);
    await report(
      "info",
      `patrol_share_${target.key}_channel_click`,
      `已在 OCR 确认后使用 ADB 鼠标左键点击“${target.text}”文字中心 (${Math.round(channelPoint.x)},${Math.round(channelPoint.y)})`,
      { point: channelPoint }
    );
    await tapPatrolMouse(ui, channelPoint, signal);
    await sleep(settleMs, signal);
    const resultScreen = await capturePatrolScreen(
      vision,
      `patrol-share-${target.key}-result-${attempt}`,
      signal
    );
    const success = target.successTexts.some((text) =>
      hasTextInRegion(
        vision,
        resultScreen.observations,
        text,
        controls.successRegion
      )
    );
    if (success) return { skipped: false, success: true };
    await report(
      "warning",
      "patrol_share_result_unverified_retry",
      `第 ${attempt}/${shareAttempts} 轮点击“${target.text}”后未确认分享成功；返回队伍页重新点击“招募”`
    );
  }
  if (!channelMenuVisible) {
    throw new Error(
      `PATROL_SHARE_CHANNEL_MENU_UNVERIFIED: 点击招募后连续 ${shareAttempts} 轮未识别到“${target.text}”，未执行盲点`
    );
  }
  throw new Error(
    `PATROL_SHARE_UNVERIFIED: ${shareAttempts} 轮点击“${target.text}”后未识别到分享成功，不会虚报分享成功`
  );
}

async function findRecruitControlForShare(
  context,
  screen,
  {
    attempt,
    target,
    recruitTextRegion,
    recruitOverlayTexts,
    recruitOverlayRegion,
    recruitOverlayDismissPoint
  },
  signal
) {
  const { config, ui, vision, report } = context;
  const controls = config?.patrolTeamUi?.share || {};
  const fastMatch = findTextInRegion(
    vision,
    screen.observations,
    "招募",
    recruitTextRegion
  );
  if (fastMatch) return { match: fastMatch, recovered: false, dismissed: false };

  const recoveryRegion = controls.recruitRecoveryRegion || {
    left: 0,
    top: 900,
    right: 850,
    bottom: 1200
  };
  const accurateMatch = await findAnyPatrolTextWithAccurateRegion(
    vision,
    screen,
    screen.observations,
    ["招募"],
    recoveryRegion,
    `patrol-share-${target.key}-recruit-recovery-${attempt}`,
    signal
  );
  if (accurateMatch) {
    await report(
      "info",
      "patrol_share_recruit_accurate_recovered",
      `普通 OCR 漏读“招募”后，高精度 OCR 已在扩大区域补读按钮位置；第 ${attempt} 次使用补读位置点击`,
      { match: accurateMatch, recoveryRegion }
    );
    return { match: accurateMatch, recovered: true, dismissed: false };
  }

  const visibleOverlay = findAnyTextInRegion(
    vision,
    screen.observations,
    recruitOverlayTexts,
    recruitOverlayRegion
  );
  if (visibleOverlay) {
    await report(
      "warning",
      "patrol_share_recruit_overlay_cleared",
      `招募按钮未读到且检测到邀请弹窗（“${visibleOverlay.text}”）；点击已校准的弹窗外空白点解除遮挡后重试`,
      { dismissPoint: recruitOverlayDismissPoint, overlayRegion: recruitOverlayRegion }
    );
    await tapPatrolMouse(ui, recruitOverlayDismissPoint, signal);
    return { match: null, recovered: false, dismissed: true };
  }

  const aiRecoveryAttempts = Math.max(
    1,
    Math.min(3, Number(controls.recruitAiAttempts) || 2)
  );
  if (!vision?.advisor?.enabled || attempt > aiRecoveryAttempts) {
    return { match: null, recovered: false, dismissed: false };
  }

  const minimum = Math.max(
    0.95,
    Number(vision.advisor?.config?.minimumActionConfidence) || 0.95
  );
  const overlayAdvice =
    typeof vision.adviseOverlayControlCurrent === "function"
      ? await vision
          .adviseOverlayControlCurrent(
            `patrol-share-${target.key}-recruit-overlay-${attempt}`,
            { ocrTexts: screen.observations.map((item) => item.text) },
            signal
          )
          .catch(() => null)
      : null;
  const controlPoints = controls.recruitOverlayControlPoints || {};
  const overlayPoint = overlayAdvice
    ? controlPoints[overlayAdvice.control]
    : null;
  if (
    overlayAdvice &&
    overlayAdvice.control !== "none" &&
    Number(overlayAdvice.confidence) >= minimum &&
    overlayPoint
  ) {
    await report(
      "warning",
      "patrol_share_recruit_ai_overlay_cleared",
      `AI 以 ${(Number(overlayAdvice.confidence) * 100).toFixed(0)}% 置信判断有${overlayAdvice.control}遮挡；使用已校准清除点解除干扰后重试招募`,
      { ...overlayAdvice, point: overlayPoint }
    );
    await tapPatrolMouse(ui, overlayPoint, signal);
    return { match: null, recovered: false, dismissed: true };
  }

  const pageAdvice =
    typeof vision.adviseCurrent === "function"
      ? await vision
          .adviseCurrent(
            `patrol-share-${target.key}-recruit-button-${attempt}`,
            {
              expectedState: "target_text_visible",
              taskHint:
                "确认队伍面板底部左侧是否存在可点击的“招募”按钮；若按钮被邀请卡片、聊天面板或其他弹窗遮挡，返回对应界面状态。此结果只用于决定是否清除已知遮挡，不提供坐标。",
              ocrTexts: screen.observations.map((item) => item.text)
            },
            signal
          )
          .catch(() => null)
      : null;
  await report(
    pageAdvice?.state === "target_text_visible" &&
      Number(pageAdvice.confidence) >= minimum
      ? "info"
      : "warning",
    "patrol_share_recruit_ai_diagnostic",
    pageAdvice
      ? `AI 招募按钮诊断：${pageAdvice.state}，置信度 ${(Number(pageAdvice.confidence) * 100).toFixed(0)}%；仍需 OCR 确认按钮位置，不直接盲点`
      : "招募按钮 AI 诊断不可用；继续按高精度 OCR 重试，不执行盲点",
    pageAdvice || undefined
  );
  if (
    pageAdvice?.state === "panel" &&
    Number(pageAdvice.confidence) >= minimum &&
    recruitOverlayDismissPoint
  ) {
    await report(
      "warning",
      "patrol_share_recruit_ai_panel_cleared",
      "AI 高置信判断当前有功能弹窗遮挡；点击已校准的弹窗外空白点解除干扰后重试招募",
      { point: recruitOverlayDismissPoint, advice: pageAdvice }
    );
    await tapPatrolMouse(ui, recruitOverlayDismissPoint, signal);
    return { match: null, recovered: false, dismissed: true };
  }
  return { match: null, recovered: false, dismissed: false };
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

async function tapPatrolMouse(ui, point, signal, options = {}) {
  if (options.gameMouse && typeof ui.gameMouseTap === "function") {
    return ui.gameMouseTap(point, signal);
  }
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

function assertPatrolBeforeDeadline(deadlineAt) {
  if (Date.now() >= deadlineAt) {
    throw new Error("巡逻任务已超过后台设置的截止时间");
  }
}

export function dailyDeadlineAt(timezone, value, now = new Date()) {
  const local = zonedClock(timezone, now);
  const [year, month, day] = local.date.split("-").map(Number);
  const [hour, minute] = String(value).split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0);
  const reference = zonedClock(timezone, new Date(wallClock));
  const [referenceYear, referenceMonth, referenceDay] = reference.date
    .split("-")
    .map(Number);
  const referenceWallClock = Date.UTC(
    referenceYear,
    referenceMonth - 1,
    referenceDay,
    Math.floor(reference.minute / 60),
    reference.minute % 60,
    reference.second
  );
  return wallClock - (referenceWallClock - wallClock);
}
