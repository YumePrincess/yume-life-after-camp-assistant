import {
  normalizeActivity,
  normalizeContribution,
  normalizeMembers,
  normalizeProfiles,
  normalizeStaffGrid,
  isStaffSeatPlaceholder,
  parseTable
} from "../table-parser.mjs";
import {
  isMemberAvatarArtifact,
  isMemberIdentityBadge,
  isMemberProfessionArtifact,
  isPlausibleMemberName
} from "../member-name.mjs";
import { delay } from "../process.mjs";
import {
  progressForRange,
  progressRangeSlice,
  updateWorkflowProgress
} from "./progress.mjs";

// Table paging is deliberately accelerated in one place so member, contribution
// and inactivity scans keep the same calibrated row endpoints while changing
// only the time spent moving and settling between pages.
export const TABLE_PAGE_SPEED_FACTOR = 0.6;
export const TABLE_MOTION_MIN_INTERVAL_MS = 48;
export const ALIGNED_TABLE_PAGE_STEP_REDUCTION_PX = 1;

function scaledTableSwipeDurationMs(value, fallback = 1_000) {
  const configured = Number(value);
  return Math.max(
    100,
    Math.round(
      (Number.isFinite(configured) && configured > 0 ? configured : fallback) *
        TABLE_PAGE_SPEED_FACTOR
    )
  );
}

function scaledTableSettleMs(value, fallback, minimum = 0) {
  const configured = Number(value);
  const base = Number.isFinite(configured) && configured >= 0
    ? configured
    : fallback;
  return Math.max(
    minimum,
    Math.round(base * TABLE_PAGE_SPEED_FACTOR)
  );
}

export async function runMemberSync(context, command, _bundle, signal) {
  await updateWorkflowProgress(context, 0.04, "member_sync_prepare");
  const contribution = await captureContribution(context, signal, {
    progressRange: { start: 0.06, end: 0.28, step: "contribution_scan" }
  });
  await updateWorkflowProgress(context, 0.31, "contribution_complete");
  const activity = await captureActivity(context, false, signal, {
    progressRange: { start: 0.33, end: 0.48, step: "activity_scan" }
  });
  await updateWorkflowProgress(context, 0.51, "activity_complete");
  await context.ui.executeFlow("closeContribution", {}, signal);
  await updateWorkflowProgress(context, 0.54, "member_panel_prepare");
  const { details, staff, expectedMembers, memberScanSummary } = await captureProfilesAndStaff(context, signal, {
    progressRange: { start: 0.56, end: 0.82, step: "member_profile_scan" }
  });
  await updateWorkflowProgress(context, 0.86, "member_profile_complete");
  const members = normalizeMembers(
    alignContributionRowsToRoster(contribution, details),
    details,
    activity
  );
  if (!members.length) throw new Error("No member rows recognized; snapshot was not uploaded");
  const normalizedFinalTailMissingAllowed =
    memberScanSummary.missingAllowed === true &&
    members.length === expectedMembers - 1;
  if (members.length !== expectedMembers && !normalizedFinalTailMissingAllowed) {
    throw new Error(
      `MEMBER_SYNC_COUNT_MISMATCH: normalized ${members.length}, page header reports ${expectedMembers}; member snapshot was not uploaded`
    );
  }
  const uploadedMemberSummary = {
    ...memberScanSummary,
    expectedCount: expectedMembers,
    recognizedCount: members.length,
    missingCount: Math.max(0, expectedMembers - members.length),
    missingAllowed: normalizedFinalTailMissingAllowed
  };
  await updateWorkflowProgress(context, 0.91, "member_snapshot");
  await context.api.snapshot(
    command.runId,
    "members",
    members,
    new Date().toISOString(),
    signal,
    { memberSummary: uploadedMemberSummary }
  );
  const staffResult = await context.api.snapshot(
    command.runId,
    "staff",
    staff,
    new Date().toISOString(),
    signal
  );
  const staffCount = checkedStaffCount(staff, staffResult);
  await updateWorkflowProgress(context, 0.97, "member_sync_complete");
  await context.report(
    "info",
    "member_sync_done",
    uploadedMemberSummary.missingAllowed
      ? `已用最新名单替换当前列表：${members.length}/${expectedMembers} 名成员（末页固定底部行重叠，允许缺失 1 人）、${staffCount} 项公职`
      : `已用最新完整名单替换当前列表：${members.length} 名成员、${staffCount} 项公职`,
    {
      expectedCount: expectedMembers,
      recognizedCount: members.length,
      missingCount: uploadedMemberSummary.missingCount,
      missingAllowed: uploadedMemberSummary.missingAllowed
    }
  );
}

export async function runContributionSync(context, command, _bundle, signal) {
  const memberRoster = Array.isArray(context.memberRoster)
    ? context.memberRoster.filter((member) => member?.name)
    : [];
  if (!memberRoster.length) {
    throw new Error(
      "CONTRIBUTION_MASTER_LIST_MISSING: 未读取到更新成员资料任务保存的成员主名单，请先执行“更新成员资料”"
    );
  }
  const expectedMemberCount = memberRoster.length;
  const scanStats = { scannedNames: [] };
  await updateWorkflowProgress(context, 0.04, "contribution_prepare");
  const capturedRows = await captureContribution(context, signal, {
    expectedCount: expectedMemberCount,
    scanStats,
    progressRange: { start: 0.08, end: 0.72, step: "contribution_scan" }
  });
  // Keep unresolved OCR candidates for the Workers reconciliation pass. The
  // server owns the same authoritative roster and can use the numeric
  // contribution as a second signal when two decorated players share one
  // text core; dropping the row here would hide that evidence.
  const alignedRows = alignContributionRowsToRoster(capturedRows, memberRoster, {
    preserveUnmatched: true
  });
  const rows = normalizeContribution(alignedRows);
  const locallyFiltered = Math.max(0, capturedRows.length - rows.length);
  await updateWorkflowProgress(context, 0.78, "contribution_validate");
  await updateWorkflowProgress(context, 0.86, "contribution_snapshot");
  const result = await context.api.snapshot(
    command.runId,
    "contribution",
    rows,
    new Date().toISOString(),
    signal
  );
  const matched = Number(result?.count) || 0;
  const ignored = Math.max(0, Number(result?.ignored) || rows.length - matched);
  if (matched === 0) {
    throw new Error(
      "CONTRIBUTION_MASTER_LIST_UNMATCHED: 贡献数据未能匹配成员资料主名单，已保留上一份贡献数据"
    );
  }
  const countMismatch = matched !== expectedMemberCount;
  await updateWorkflowProgress(context, 0.97, "contribution_complete");
  await context.report(
    ignored || locallyFiltered || countMismatch ? "warning" : "info",
    "contribution_done",
    `贡献页完整扫描后按玩家名称去重得到 ${capturedRows.length} 行，按成员资料主名单 ${expectedMemberCount} 名成员匹配后更新 ${matched} 名，忽略 ${ignored + locallyFiltered} 行；不会新增成员，人数不一致交由 Workers 端处理`,
    {
      recognized: capturedRows.length,
      normalized: rows.length,
      locallyFiltered,
      expectedMemberCount,
      matched,
      ignored: ignored + locallyFiltered,
      ambiguous: Number(result?.ambiguous) || 0,
      countMismatch,
      scannedNames: scanStats.scannedNames,
      scannedNameCount: scanStats.scannedNames.length
    }
  );
}

export async function runInactivitySync(context, command, bundle, signal) {
  const minimumInactiveDays = Math.max(
    1,
    Number(bundle?.campConfig?.inactivityWarningDays) || 1
  );
  const memberRoster = Array.isArray(context.memberRoster)
    ? context.memberRoster.filter((member) => member?.name)
    : [];
  const expectedMemberCount = memberRoster.length || null;
  await updateWorkflowProgress(context, 0.04, "activity_prepare");
  const scanStats = { scannedNames: [] };
  const scanOptions = {
    minimumInactiveDays,
    scanStats,
    expectedCount: expectedMemberCount
  };
  const rows = normalizeActivity(
    await captureActivity(context, true, signal, {
      ...scanOptions,
      progressRange: { start: 0.08, end: 0.72, step: "activity_scan" }
    })
  );
  await updateWorkflowProgress(context, 0.78, "activity_validate");
  if (!rows.length && !scanOptions.thresholdBoundaryReached) {
    throw new Error(
      "INACTIVITY_SCAN_UNREADABLE: 未识别到成员行或阈值边界，已保留原有斩杀预警数据"
    );
  }
  const result = await context.api.snapshot(
    command.runId,
    "activity",
    rows,
    new Date().toISOString(),
    signal
  );
  const matched = Number(result?.count) || 0;
  const ignored = Math.max(0, Number(result?.ignored) || rows.length - matched);
  const ambiguous = Number(result?.ambiguous) || 0;
  if (rows.length > 0 && matched === 0) {
    throw new Error(
      "INACTIVITY_SCAN_UNREADABLE: 斩杀预警扫描结果在自身去重后为空，已保留上一份有效预警"
    );
  }
  await updateWorkflowProgress(context, 0.97, "activity_complete");
  await context.report(
    ignored ? "warning" : "info",
    "activity_done",
    `斩杀页识别 ${rows.length} 行，经成员资料主名单规范化后更新 ${matched} 条离线达到 ${minimumInactiveDays} 天的独立预警，忽略 ${ignored} 条重复或无法安全匹配的数据；不会修改成员资料`,
    {
      recognized: rows.length,
      matched,
      ignored,
      ambiguous,
      scannedNames: scanStats.scannedNames,
      scannedNameCount: scanStats.scannedNames.length
    }
  );
}

export async function runMemberProfileSync(context, command, _bundle, signal) {
  await updateWorkflowProgress(context, 0.04, "member_profile_prepare");
  const { details, staff, expectedMembers, memberScanSummary } = await captureProfilesAndStaff(
    context,
    signal,
    { progressRange: { start: 0.10, end: 0.78, step: "member_profile_scan" } }
  );
  await updateWorkflowProgress(context, 0.84, "member_profile_validate");
  const profiles = normalizeProfiles(details);
  if (!profiles.length) throw new Error("No profile rows recognized");
  const acceptedFinalTailMissing =
    memberScanSummary.missingAllowed === true &&
    profiles.length === expectedMembers - 1;
  if (profiles.length !== expectedMembers && !acceptedFinalTailMissing) {
    throw new Error(
      `MEMBER_PROFILE_COUNT_MISMATCH: normalized ${profiles.length}, page header reports ${expectedMembers}; profile snapshot was not uploaded`
    );
  }
  await context.api.snapshot(
    command.runId,
    "profiles",
    profiles,
    new Date().toISOString(),
    signal,
    {
      memberSummary: {
        ...memberScanSummary,
        expectedCount: expectedMembers,
        recognizedCount: profiles.length,
        missingCount: Math.max(0, expectedMembers - profiles.length)
      }
    }
  );
  await updateWorkflowProgress(context, 0.91, "member_profile_staff");
  const staffResult = await context.api.snapshot(
    command.runId,
    "staff",
    staff,
    new Date().toISOString(),
    signal
  );
  const staffCount = checkedStaffCount(staff, staffResult);
  await updateWorkflowProgress(context, 0.97, "member_profile_complete");
  await context.report(
    "info",
    "profiles_done",
    acceptedFinalTailMissing
      ? `已更新 ${profiles.length}/${expectedMembers} 名成员资料和 ${staffCount} 项最新公职；末页固定底部行重叠，允许缺失 1 人；贡献数值由“更新贡献”任务单独更新`
      : `已更新 ${profiles.length} 名成员资料和 ${staffCount} 项最新公职；贡献数值由“更新贡献”任务单独更新`,
    {
      expectedCount: expectedMembers,
      recognizedCount: profiles.length,
      missingCount: Math.max(0, expectedMembers - profiles.length),
      missingAllowed: acceptedFinalTailMissing
    }
  );
}

export async function captureContribution(context, signal, options = {}) {
  const rosterExpectedCount = Array.isArray(context.memberRoster)
    ? context.memberRoster.filter((member) => member?.name).length || null
    : null;
  const expectedCount = Number.isFinite(Number(options.expectedCount))
    ? Math.max(1, Number(options.expectedCount))
    : rosterExpectedCount;
  await updateWorkflowProgress(
    context,
    options.progressRange?.start,
    "contribution_teleport"
  );
  await context.ui.executeFlow("teleportCityHall", {}, signal);
  await updateWorkflowProgress(context, progressForRange(
    options.progressRange?.start,
    options.progressRange?.end,
    1,
    4
  ), "contribution_sand_table");
  await context.ui.executeFlow("navigateToSandTable", {}, signal);
  await updateWorkflowProgress(context, progressForRange(
    options.progressRange?.start,
    options.progressRange?.end,
    2,
    4
  ), "contribution_open");
  await context.ui.executeFlow("openContribution", {}, signal);
  await updateWorkflowProgress(context, progressForRange(
    options.progressRange?.start,
    options.progressRange?.end,
    3,
    4
  ), "contribution_settle");
  await settleTableBeforeFirstScan(context, "contribution", signal);
  const scanProgressRange = progressRangeSlice(options.progressRange, 0.75);
  let rows = await capturePagedTable(
    context,
    "member-contribution",
    context.config.tables.contribution,
    signal,
    {
      ...options,
      expectedCount,
      progressRange: scanProgressRange
    }
  );
  const deduplicatedRows = dedupeContributionRows(rows);
  if (
    expectedCount !== null &&
    deduplicatedRows.length !== expectedCount
  ) {
    await context.report(
      "warning",
      "contribution_count_mismatch_no_retry",
      `贡献表完整扫描后按玩家名称去重得到 ${deduplicatedRows.length}/${expectedCount} 名成员；人数不一致不在 Agent 端重试，交由 Workers 端处理`,
      {
        recognized: deduplicatedRows.length,
        expectedCount,
        direction:
          deduplicatedRows.length < expectedCount ? "under" : "over"
      }
    );
  }
  return deduplicatedRows;
}

export function assertContributionComplete(rows, definition, rawRows = rows) {
  const minimumRows = contributionMinimum(definition);
  if (rows.length < minimumRows && rawRows.length < minimumRows) {
    throw new Error(
      `CONTRIBUTION_INCOMPLETE: recognized ${rawRows.length} raw rows, ${rows.length} usable rows; ${minimumRows} required unique member rows`
    );
  }
}

function contributionMinimum(definition) {
  return Math.max(1, Number(definition?.minimumCompleteRows) || 1);
}

export function dedupeContributionRows(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    const key = contributionNameKey(row?.name);
    if (!key) continue;
    const previous = byName.get(key);
    byName.set(
      key,
      previous ? mergeContributionRecord(previous, row) : { ...row }
    );
  }
  return [...byName.values()];
}

async function captureActivity(
  context,
  startFromWorld,
  signal,
  options = {}
) {
  if (startFromWorld) {
    await updateWorkflowProgress(context, options.progressRange?.start, "activity_teleport");
    await context.ui.executeFlow("teleportCityHall", {}, signal);
    await updateWorkflowProgress(context, progressForRange(
      options.progressRange?.start,
      options.progressRange?.end,
      1,
      3
    ), "activity_sand_table");
    await context.ui.executeFlow("navigateToSandTable", {}, signal);
  }
  await updateWorkflowProgress(context, progressForRange(
    options.progressRange?.start,
    options.progressRange?.end,
    startFromWorld ? 2 : 1,
    startFromWorld ? 3 : 2
  ), "activity_open");
  await context.ui.executeFlow(
    startFromWorld ? "openActivity" : "openActivityFromMember",
    {},
    signal
  );
  await settleTableBeforeFirstScan(context, "activity", signal);
  await ensureActivityDescending(context, signal);
  const scanProgressRange = progressRangeSlice(
    options.progressRange,
    startFromWorld ? 2 / 3 : 1 / 2
  );
  return capturePagedTable(
    context,
    "member-activity",
    context.config.tables.activity,
    signal,
    { ...options, progressRange: scanProgressRange }
  );
}

async function settleTableBeforeFirstScan(context, tableName, signal) {
  const table = context.config.tables?.[tableName.startsWith("contribution") ? "contribution" : "activity"];
  const configured = Number(table?.pagination?.initialSettleMs);
  const settleMs = Math.max(3_000, Number.isFinite(configured) ? configured : 3_000);
  await context.report(
    "info",
    "table_initial_settle",
    `${tableName} 页面切换完成，固定等待 ${Math.round(settleMs / 1000)} 秒后扫描首个页面`,
    { table: tableName, settleMs }
  );
  await (context.sleep || delay)(settleMs, signal);
}

async function ensureActivityDescending(context, signal) {
  const definition = context.config.tables.activity;
  const before = await captureTableFrame(
    context,
    "activity-sort-before",
    definition,
    signal
  );
  const beforeRows = await readActivityFrame(
    context,
    before,
    definition,
    "activity-sort-before",
    signal
  );
  const values = beforeRows
    .map((row) => row.inactiveDays)
    .filter((value) => Number.isFinite(value));
  const descending =
    values.some((value) => value > 0) &&
    values.every((value, index) => index === 0 || values[index - 1] >= value);
  if (!descending) {
    await context.ui.tap(
      definition.sortPoint || { x: 1630, y: 230 },
      signal
    );
    await context.report(
      "info",
      "activity_sort_settle",
      "在线情况已切换排序，固定等待 3 秒后再读取首个页面"
    );
    await (context.sleep || delay)(3_000, signal);
  }
  const after = await captureTableFrame(
    context,
    "activity-sort-after",
    definition,
    signal
  );
  const afterValues = (await readActivityFrame(
    context,
    after,
    definition,
    "activity-sort-after",
    signal
  ))
    .map((row) => row.inactiveDays)
    .filter((value) => Number.isFinite(value));
  if (
    afterValues.length > 1 &&
    !afterValues.every(
      (value, index) => index === 0 || afterValues[index - 1] >= value
    )
  ) {
    throw new Error("在线情况未成功切换为最久离线优先");
  }
}

async function captureTableFrame(context, label, definition, signal) {
  if (typeof context.vision.captureTable === "function") {
    return context.vision.captureTable(label, definition, signal);
  }
  return context.vision.capture(label, signal);
}

async function readActivityFrame(
  context,
  frame,
  definition,
  label,
  signal
) {
  let rows = parseTable(frame.observations, definition);
  if (
    !normalizeActivity(rows).length &&
    frame.path &&
    typeof context.vision.extractTableRows === "function"
  ) {
    rows = await context.vision.extractTableRows(
      frame.path,
      definition,
      label,
      signal
    );
  }
  return normalizeActivity(rows);
}

export async function captureProfilesAndStaff(context, signal, options = {}) {
  await updateWorkflowProgress(context, options.progressRange?.start, "member_panel_open");
  await context.ui.executeFlow("openCampPanel", {}, signal);
  await updateWorkflowProgress(context, progressForRange(
    options.progressRange?.start,
    options.progressRange?.end,
    1,
    3
  ), "member_panel_open");
  await context.ui.executeFlow("openMemberPanel", {}, signal);
  await updateWorkflowProgress(context, progressForRange(
    options.progressRange?.start,
    options.progressRange?.end,
    2,
    3
  ), "member_header_read");
  const memberCountBreakdown =
    typeof context.vision.readMemberExpectedBreakdown === "function"
      ? await context.vision.readMemberExpectedBreakdown(signal)
      : {
          formalCurrent: null,
          formalTotal: await context.vision.readMemberExpectedTotal(signal),
          sailingCurrent: null,
          sailingTotal: 0
        };
  // Both header denominators are member populations for pagination. The
  // current/online numerators and the adjacent info glyph are never counted;
  // 9/100 plus 0/1 therefore predicts 101 members and 21 pages.
  const expectedMembers = memberCountBreakdown.total ??
    memberCountBreakdown.formalTotal + memberCountBreakdown.sailingTotal;
  await context.report(
    "info",
    "member_header_count",
    `顶部人数识别：正式市民 ${memberCountBreakdown.formalCurrent ?? "?"}/${memberCountBreakdown.formalTotal}，启航市民 ${memberCountBreakdown.sailingCurrent ?? "?"}/${memberCountBreakdown.sailingTotal}，合计 ${expectedMembers} 名（当前在线人数不计入总数）`,
    {
      formalCurrent: memberCountBreakdown.formalCurrent,
      formalTotal: memberCountBreakdown.formalTotal,
      sailingCurrent: memberCountBreakdown.sailingCurrent,
      sailingTotal: memberCountBreakdown.sailingTotal,
      total: expectedMembers,
      headerCombinedTotal:
        Number.isFinite(Number(memberCountBreakdown.formalTotal)) &&
        Number.isFinite(Number(memberCountBreakdown.sailingTotal))
          ? Number(memberCountBreakdown.formalTotal) +
            Number(memberCountBreakdown.sailingTotal)
          : null
    }
  );
  const scanProgressRange = progressRangeSlice(options.progressRange, 0.1);
  let scanState = {};
  const scanMemberDetails = (state) =>
    capturePagedTable(
      context,
      "member-details",
      context.config.tables.members,
      signal,
      {
        expectedCount: expectedMembers,
        progressRange: scanProgressRange,
        scanState: state
      }
  );
  let details = await scanMemberDetails(scanState);
  const finalTailMissingAllowed =
    scanState.finalPageMissingAllowed === true &&
    Number(scanState.finalPageMissingCount) === 1 &&
    details.length === expectedMembers - 1;
  if (
    details.length < expectedMembers &&
    !scanState.stoppedOnIncompletePage &&
    !finalTailMissingAllowed
  ) {
    await context.report(
      "warning",
      "member_details_count_retry",
      `成员资料首次扫描识别 ${details.length}/${expectedMembers} 名，先通过顶部“首页”返回列表起点，再进入“成员”页完整重扫一次，避免末页 OCR 漏行`
    );
    await context.ui.executeFlow("resetMemberPanelForRescan", {}, signal);
    scanState = {};
    details = await scanMemberDetails(scanState);
  }
  const acceptedFinalTailMissing =
    scanState.finalPageMissingAllowed === true &&
    Number(scanState.finalPageMissingCount) === 1 &&
    details.length === expectedMembers - 1;
  if (details.length !== expectedMembers && !acceptedFinalTailMissing) {
    throw new Error(
      `MEMBER_PROFILE_COUNT_MISMATCH: recognized ${details.length}, page header reports ${expectedMembers}`
    );
  }
  if (acceptedFinalTailMissing) {
    await context.report(
      "warning",
      "member_profile_tail_missing_allowed",
      `成员资料列表顶部总数为 ${expectedMembers}，实际整理 ${details.length} 名；末页最后一行与固定底部行重叠，允许缺失 1 人并按实际列表上报`,
      {
        expectedCount: expectedMembers,
        recognizedCount: details.length,
        missingCount: 1,
        finalPage: scanState.finalPage,
        positionLocked: true
      }
    );
  }
  await context.ui.executeFlow("openStaffPanel", {}, signal);
  const staffFrame = await context.vision.captureAccurate(
    "camp-staff",
    signal
  );
  let staff = normalizeStaffGrid(
    staffFrame.observations,
    context.config.tables.staffGrid
  );
  if (
    typeof context.vision.extractStaffRows === "function" &&
    staffFrame.path
  ) {
    const advisedStaff = await context.vision
      .extractStaffRows(staffFrame.path, signal)
      .catch(async (error) => {
        await context.report(
          "warning",
          "staff_ai_ocr_failed",
          "公职页面模型识别失败，保留 Apple OCR 结果",
          { reason: error.message }
        );
        return [];
      });
    if (advisedStaff.length >= staff.length && advisedStaff.length > 0) {
      staff = advisedStaff;
    }
  }
  staff = dedupeStaffAssignments(
    staff.map((row) => ({
      ...row,
      roleName: stripStaffColorCodes(row.roleName),
      ...(row.campTitle
        ? { campTitle: stripStaffColorCodes(row.campTitle) }
        : {})
    }))
  );
  if (!staff.length) throw new Error("No staff rows recognized; snapshot was not uploaded");
  if (staff.length > 11) {
    throw new Error(
      `STAFF_COUNT_INVALID: recognized ${staff.length}, maximum is mayor 1 + staff 10`
    );
  }
  return {
    details,
    staff,
    expectedMembers,
    finalTailMissingAllowed: acceptedFinalTailMissing,
    memberScanSummary: buildMemberScanSummary(
      expectedMembers,
      details.length,
      scanState
    )
  };
}

function buildMemberScanSummary(expectedCount, recognizedCount, scanState = {}) {
  const expected = Math.max(0, Number(expectedCount) || 0);
  const recognized = Math.max(0, Number(recognizedCount) || 0);
  return {
    expectedCount: expected,
    recognizedCount: recognized,
    missingCount: Math.max(0, expected - recognized),
    missingAllowed:
      scanState.finalPageMissingAllowed === true &&
      Number(scanState.finalPageMissingCount) === 1,
    finalPage: Number.isInteger(Number(scanState.finalPage))
      ? Number(scanState.finalPage)
      : null,
    pages: Number.isInteger(Number(scanState.pages))
      ? Number(scanState.pages)
      : null,
    positionLocked: scanState.finalPagePositionLocked === true
  };
}

export function dedupeStaffAssignments(rows) {
  const roleKeys = new Set();
  const roleNames = new Set();
  const memberNames = new Set();
  const unique = [];
  for (const row of rows) {
    const roleKey = comparableStaffText(row?.roleKey);
    const roleName = comparableStaffText(row?.roleName);
    const memberName = comparableStaffText(row?.memberName, true);
    if (
      !roleKey ||
      !roleName ||
      isStaffSeatPlaceholder(roleName) ||
      !memberName ||
      roleKeys.has(roleKey) ||
      roleNames.has(roleName) ||
      memberNames.has(memberName)
    ) {
      continue;
    }
    roleKeys.add(roleKey);
    roleNames.add(roleName);
    memberNames.add(memberName);
    unique.push(row);
  }
  return unique;
}

const STAFF_COLOR_CODE_PATTERN = /#\s*[BDGKOPRUWY]/gi;
const STAFF_COLOR_CODE_CAPTURE_PATTERN = /#\s*[BDGKOPRUWY]\s*(.*)$/i;

export function stripStaffColorCodes(value) {
  return String(value || "")
    .replace(STAFF_COLOR_CODE_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsSailingTitleLeak(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text === "启航") return true;
  if (!STAFF_COLOR_CODE_CAPTURE_PATTERN.test(text)) return false;
  const codedTitle = stripStaffColorCodes(text);
  return Boolean(codedTitle) && codedTitle !== "启航";
}

function comparableStaffText(value, removeSymbols = false) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, "");
  return removeSymbols
    ? normalized.replace(/[^\p{L}\p{N}]/gu, "")
    : normalized;
}

function checkedStaffCount(scannedStaff, result) {
  const matched = Number(result?.count) || 0;
  if (scannedStaff.length > 0 && matched === 0) {
    throw new Error(
      "STAFF_SNAPSHOT_UNREADABLE: 公职识别结果在自身去重后为空，已保留上一份有效公职数据"
    );
  }
  return matched;
}

export async function capturePagedTable(
  context,
  label,
  definition,
  signal,
  options = {}
) {
  const { vision, adb, ui, report } = context;
  const byName = new Map();
  const contributionRows = [];
  const contributionNames = new Set();
  const memberDetailsMode = label === "member-details";
  const contributionTableMode = label.startsWith("member-contribution");
  const activityTableMode = label.startsWith("member-activity");
  const alignedPagedTableMode = contributionTableMode || activityTableMode;
  const localVisionEnabled =
    context.config?.localVisionModel?.enabled === true ||
    context.vision?.advisor?.enabled === true;
  const localVisionPageRead =
    localVisionEnabled &&
    typeof vision.extractTableRows === "function" &&
    (memberDetailsMode || contributionTableMode || activityTableMode);
  if (alignedPagedTableMode) {
    definition = withAlignedPagedTableCalibration(
      definition,
      contributionTableMode ? "contribution" : "activity"
    );
  }
  let stagnantPages = 0;
  let previousFingerprint = "";
  let previousRows = [];
  const pageNameAliases = new Map();
  let scannedPages = 0;
  let tailFullPagePending = false;
  let tailFullPageReason = null;
  let tailCorrectionAttempts = 0;
  const memberPageRetries = new Map();
  let stoppedOnIncompletePage = false;
  let incompletePage = null;
  let incompletePageNames = [];
  let finalTailMissingCount = 0;
  let finalTailExpectedRows = null;
  let finalTailRecognizedRows = null;
  let finalTailMissingAllowed = false;
  let memberPageHadExactCollision = false;
  const hasFullPageDefinition =
    memberDetailsMode && Boolean(definition.pagination?.fullPageRegion);
  const expectedCount = Number.isFinite(Number(options.expectedCount))
    ? Math.max(1, Number(options.expectedCount))
    : null;
  const memberRowsPerPage = Math.max(
    1,
    Number(definition.pagination.rowsPerPage) ||
      Number(definition.pagination.minimumRowsPerPage) ||
      1
  );
  // Member pages are allowed at most six in-place reads.  Keep this cap in
  // code as well as in config.example.json so an older external Runtime
  // config containing the former value 3 cannot silently reintroduce the
  // premature page-18 stop.
  const maxMemberPageRetries = 6;
  const expectedPageCount =
    (memberDetailsMode || alignedPagedTableMode) && expectedCount !== null
      ? Math.max(1, Math.ceil(expectedCount / memberRowsPerPage))
      : null;
  const configuredMaxPages = Math.max(
    1,
    Number(definition.pagination.maxPages) || 24
  );
  // The member header is authoritative for the number of five-row pages.
  // Keep an independent hard ceiling for stale external configs: 120 members
  // is the largest supported roster, so the scan cannot exceed 24 pages.
  const memberPageHardLimit = memberDetailsMode
    ? Math.min(24, configuredMaxPages)
    : configuredMaxPages;
  const maxMemberPageCount =
    expectedPageCount === null
      ? null
      : Math.min(expectedPageCount, memberPageHardLimit);
  const expectedTailOverlapCount =
    (memberDetailsMode || alignedPagedTableMode) && expectedCount !== null
      ? expectedMemberTailOverlapCount(expectedCount, memberRowsPerPage)
      : null;
  let alignedPageHeightPx = Math.max(
    0,
    Number(definition.pagination.pageHeightPx) || 0
  );
  let alignedTableFirstRowKind = null;
  const scanState = options.scanState;
  for (let page = 0; page < definition.pagination.maxPages; ) {
    memberPageHadExactCollision = false;
    scannedPages = page + 1;
    const scheduledLastPage =
      (memberDetailsMode || alignedPagedTableMode) &&
      expectedPageCount !== null &&
      page + 1 === expectedPageCount;
    const fullPageRead =
      hasFullPageDefinition &&
      (tailFullPagePending || scheduledLastPage);
    // The page immediately before the calculated tail has a different stable
    // viewport: five complete rows are at the top, followed by a clipped next
    // row and the fixed bottom assistant row. Do not apply the normal first-row
    // color-band correction here; its down gesture moves the list backwards
    // and replaces the fifth new member with the previous page's last row.
    const penultimateFixedGeometry =
      memberDetailsMode &&
      hasFullPageDefinition &&
      expectedPageCount !== null &&
      page + 2 === expectedPageCount;
    const currentTailReason =
      tailFullPageReason ||
      (scheduledLastPage
        ? "scheduled-last"
        : null);
    const pageDefinition = fullPageRead
      ? memberFullPageDefinition(definition)
      : definition;
    if (fullPageRead) {
      await report(
        "info",
        "member_details_tail_fixed_geometry",
        `第 ${page + 1} 页为预测末页，扫描区域已下移到顶部半行下方，锁定其下方 ${memberRowsPerPage} 个成员槽位读取；末页仅保留计算的 ${Math.max(1, memberRowsPerPage - (expectedTailOverlapCount || 0))} 行新成员`,
        {
          page: page + 1,
          expectedCount,
          expectedPageCount,
          fixedTopPartialRows: 1,
          scanRegion: pageDefinition.region,
          scanRegionTopOffsetPx:
            Number(pageDefinition.region?.top) -
            Number(definition.pagination?.fullPageRegion?.top),
          fixedRowsBelowPartial: memberRowsPerPage,
          expectedTailOverlapCount,
          expectedTailNewCount: Math.max(
            1,
            memberRowsPerPage - (expectedTailOverlapCount || 0)
          ),
          finalPage: scheduledLastPage,
          positionLocked: true
        }
      );
    } else if (penultimateFixedGeometry) {
      await report(
        "info",
        "member_details_penultimate_fixed_geometry",
        `第 ${page + 1} 页为预测末页前一页，锁定当前位置读取顶部 ${memberRowsPerPage} 个完整成员槽位，忽略底部半行和固定底部行，不执行行校准滑动`,
        {
          page: page + 1,
          expectedCount,
          expectedPageCount,
          fixedTopRows: memberRowsPerPage,
          ignoredBottomPartialRows: 1,
          fixedBottomRows: 1,
          finalPage: false,
          positionLocked: true
        }
      );
    }
    tailFullPagePending = false;
    tailFullPageReason = null;
    const pageStartedAt = Date.now();
    let frame;
    let rows = [];
    let tailOverlapKeys = new Set();
    let observedTailOverlapKeys = new Set();
    let tailOverlapRowIndexes = new Set();
    let alignedTailOverlapRowIndexes = new Set();
    let preparedFrame = null;
    let stopAfterIncompletePage = false;
    if (
      memberDetailsMode &&
      page > 0 &&
      !fullPageRead &&
      !penultimateFixedGeometry
    ) {
      preparedFrame = await alignMemberDetailsPage(
        context,
        `${label}-${page + 1}`,
        pageDefinition,
        page,
        signal
      );
    } else if (alignedPagedTableMode && page > 0) {
      preparedFrame = await alignPagedTablePage(
        context,
        `${label}-${page + 1}`,
        pageDefinition,
        page,
        signal,
        alignedTableFirstRowKind
      );
    }
    const rowsPerPage = Math.max(
      1,
      Number(definition.pagination.rowsPerPage) ||
        (alignedPagedTableMode ? 11 : 1)
    );
    const minimumRowsPerPage = Math.max(
      1,
      Number(definition.pagination.minimumRowsPerPage) || rowsPerPage
    );
    for (let readAttempt = 1; readAttempt <= 3; readAttempt += 1) {
      const attemptLabel =
        readAttempt === 1
          ? `${label}-${page + 1}`
          : `${label}-${page + 1}-retry-${readAttempt}`;
      const attemptFrame =
        preparedFrame ||
        (await captureTableFrame(
          context,
          attemptLabel,
          pageDefinition,
          signal
        ));
      preparedFrame = null;
      // The fast native parser is only available for definitions carrying
      // calibrated regions/columns. Test doubles and plugin-defined tables
      // may intentionally provide capture observations without that layout;
      // let those tables use the existing extractor fallback instead of
      // throwing while reading an undefined region.
      const canParseNative =
        Array.isArray(attemptFrame.observations) &&
        pageDefinition.region &&
        Array.isArray(pageDefinition.columns);
      let attemptRows = canParseNative
        ? parseTable(attemptFrame.observations, pageDefinition).filter((row) => {
            const name = String(row.name || "").trim();
            if (
              name &&
              pageDefinition.headerPattern.some((value) => name.includes(value))
            ) {
              return false;
            }
            // Keep a contribution row whose name OCR was lost as long as its
            // numeric columns prove that a real row is present.  Dropping it
            // here made the later recovery pass impossible and shifted every
            // following name by one row.
            if (!name && contributionTableMode) {
              return [
                "weeklyContribution",
                "technologyPointsUsed",
                "materialContribution"
              ].some((field) => /\d/.test(String(row[field] || "")));
            }
            return Boolean(name);
          })
        : [];
      if (memberDetailsMode) {
        // The member OCR crop deliberately starts at the identity-column
        // boundary, but keep this guard here as well for older/plugin vision
        // providers that may still return a token from the avatar area.  It
        // must run before the visible-row slice; otherwise an avatar token
        // can consume one of the five slots and hide the real member below it.
        attemptRows = filterMemberDetailRows(attemptRows);
          if (!fullPageRead) {
            const visibleRows = Number(definition.pagination.rowsPerPage) || 5;
            attemptRows = attemptRows.slice(0, Math.max(1, visibleRows));
        }
      }
      const contributionNeedsRecovery =
        label.startsWith("member-contribution") &&
        attemptRows.length > 0 &&
        attemptRows.some(
          (row) =>
            !String(row.name || "").trim() ||
            [
              "weeklyContribution",
              "technologyPointsUsed",
              "materialContribution"
            ].some((field) => !/\d/.test(String(row[field] || "")))
        );
      const sailingTitleLeak =
        memberDetailsMode &&
        attemptRows.some((row) => containsSailingTitleLeak(row?.name));
      const shouldRequestMemberAdvisor =
        memberDetailsMode &&
        (attemptRows.length < minimumRowsPerPage || sailingTitleLeak);
      const activityNeedsRecovery =
        activityTableMode &&
        attemptRows.length > 0 &&
        (attemptRows.length < minimumRowsPerPage ||
          attemptRows.some(
            (row) =>
              !Number.isFinite(
                normalizeActivity([row])[0]?.inactiveDays
              )
          ));
      if (
        (!attemptRows.length ||
          (definition.extractionMode === "hybrid" &&
            attemptRows.length < minimumRowsPerPage) ||
          contributionNeedsRecovery ||
          shouldRequestMemberAdvisor ||
          activityNeedsRecovery ||
          localVisionPageRead) &&
        typeof vision.extractTableRows === "function"
      ) {
        if (shouldRequestMemberAdvisor) {
          const advisorConfigured =
            context.config?.localVisionModel?.enabled === true &&
            context.config?.localVisionModel?.transport === "http";
          await report(
            advisorConfigured ? "info" : "warning",
            "member_details_ai_recovery_attempt",
            advisorConfigured
              ? sailingTitleLeak
                ? `第 ${page + 1} 页疑似将带颜色码的“启航”职位识别为名字，正在调用 Qwen 本地视觉辅助模型重读当前页；当前已读到：${attemptRows.map((row) => row.name).filter(Boolean).join("、") || "无"}`
                : `第 ${page + 1} 页识别不足，正在调用 Qwen 本地视觉辅助模型重读当前页；当前已读到：${attemptRows.map((row) => row.name).filter(Boolean).join("、") || "无"}`
              : `第 ${page + 1} 页识别不足，Qwen 本地视觉辅助模型当前不可用，继续使用 OCR 重读；当前已读到：${attemptRows.map((row) => row.name).filter(Boolean).join("、") || "无"}`,
            {
              page: page + 1,
              forceMemberAdvisor: true,
              advisorConfigured,
              sailingTitleLeak,
              recognizedNames: attemptRows.map((row) => row.name).filter(Boolean)
            }
          );
        }
        if (localVisionPageRead) {
          await report(
            "info",
            "local_model_table_reread",
            `第 ${page + 1} 页调用 Qwen 本地视觉辅助模型重读${memberDetailsMode ? "成员资料" : contributionTableMode ? "贡献" : "斩杀预警"}表；当前 OCR 成员：${attemptRows.map((row) => String(row.name || "").trim()).filter(Boolean).join("、") || "无"}`,
            {
              page: page + 1,
              table: label,
              recognizedNames: attemptRows
                .map((row) => String(row.name || "").trim())
                .filter(Boolean),
              fixedRowRead: true
            }
          );
        }
        const nativeRowsBeforeAdvisor = attemptRows;
        const rereadOptions = localVisionPageRead
          ? {
              forceLocalVision: true,
              ...(memberDetailsMode
                ? { forceMemberAdvisor: true }
                : contributionTableMode
                  ? { forceContributionVision: true }
                  : { forceActivityVision: true })
            }
          : shouldRequestMemberAdvisor
            ? { forceMemberAdvisor: true }
            : activityNeedsRecovery
              ? { forceActivityRecovery: true }
              : contributionNeedsRecovery
                ? { forceContributionRecovery: true }
                : undefined;
        const recoveredRows = await vision.extractTableRows(
          attemptFrame.path,
          pageDefinition,
          attemptLabel,
          signal,
          rereadOptions
        ).catch(async (error) => {
          await report(
            "warning",
            `${label}_ai_ocr_failed`,
            `第 ${page + 1} 页 AI 表格识别失败，保留当前界面并继续重试`,
            { reason: error.message }
          );
          return [];
        });
        attemptRows = memberDetailsMode
          ? (() => {
              // Keep the advisor's raw row sequence until the page-level
              // cleanup below.  Deduplicating here hides the collision signal
              // needed to recover a valid tail row, and can move that
              // recovery to a later page, changing the roster order.
              const recoveredMemberRows = filterMemberDetailRows(recoveredRows);
              const visibleRows = fullPageRead
                ? Number(pageDefinition.pagination.fullPageRows) || 7
                : Number(definition.pagination.rowsPerPage) || 5;
              const nativeMemberRows = filterMemberDetailRows(
                nativeRowsBeforeAdvisor
              );
              // A page-level model response with fewer rows is incomplete,
              // not a license to erase the native rows. Vision normally
              // merges by fixed row before returning, but retain this guard
              // for timeouts, older adapters and test/plugin providers.
              if (
                localVisionPageRead &&
                recoveredMemberRows.length < nativeMemberRows.length
              ) {
                return nativeMemberRows.slice(0, Math.max(1, visibleRows));
              }
              return recoveredMemberRows.slice(0, Math.max(1, visibleRows));
            })()
          : label.startsWith("member-activity")
            ? mergeActivityRecoveryRows(recoveredRows, attemptRows)
            : mergeContributionRows(attemptRows, recoveredRows);
        if (memberDetailsMode) {
          attemptRows = filterMemberDetailRows(attemptRows);
          if (!fullPageRead) {
            const visibleRows = Number(definition.pagination.rowsPerPage) || 5;
            attemptRows = attemptRows.slice(0, Math.max(1, visibleRows));
          }
        }
      }
      if (alignedPagedTableMode) {
        attemptRows = attemptRows.slice(0, rowsPerPage);
      }
      if (
        !frame ||
        attemptRows.length > rows.length ||
        (memberDetailsMode && shouldRequestMemberAdvisor && attemptRows.length >= rows.length)
      ) {
        frame = attemptFrame;
        rows = attemptRows;
      }
      if (rows.length >= minimumRowsPerPage || readAttempt === 3) break;
      await report(
        "warning",
        `${label}_empty_page_retry`,
        `第 ${page + 1} 页仅识别 ${rows.length}/${minimumRowsPerPage} 行，保持当前位置原地重读；当前已读到：${rows.map((row) => row.name).filter(Boolean).join("、") || "无"}`,
        {
          page: page + 1,
          recognizedRows: rows.length,
          recognizedNames: rows.map((row) => row.name).filter(Boolean)
        }
      );
      await ui.afterAction(signal);
    }
    rows = rows.filter(
      (row) =>
        row.name &&
        !pageDefinition.headerPattern.some((value) => row.name.includes(value))
    );
    // The activity list is sorted by offline duration. The first row newer
    // than the configured threshold is a useful end marker, but it is not a
    // reliable reason to discard the rest of the current page: one OCR pass
    // can miss a warning row immediately before that marker. Re-read the
    // same boundary page at a larger OCR scale and merge the candidates
    // before applying the early-stop filter. This is scoped to activity
    // pages; contribution and the five-row member-details scanner keep their
    // existing paging behavior.
    if (
      label.startsWith("member-activity") &&
      page > 0 &&
      Number.isFinite(Number(options.minimumInactiveDays)) &&
      frame?.path &&
      typeof vision.extractTableRows === "function"
    ) {
      const initialSelection = selectActivityWarningRows(
        rows,
        Number(options.minimumInactiveDays)
      );
      if (initialSelection.reachedBoundary) {
        let mergedRows = rows;
        let previousWarningCount = initialSelection.rows.length;
        for (let recoveryAttempt = 1; recoveryAttempt <= 2; recoveryAttempt += 1) {
          const recoveredRows = await vision.extractTableRows(
            frame.path,
            pageDefinition,
            `${label}-${page + 1}-boundary-recovery-${recoveryAttempt}`,
            signal,
            { forceActivityRecovery: true }
          ).catch(async (error) => {
            await report(
              "warning",
              "activity_boundary_recovery_failed",
              `第 ${page + 1} 页阈值边界重读失败，保留当前页已识别结果并继续判断结束位置`,
              { page: page + 1, recoveryAttempt, reason: error.message }
            );
            return [];
          });
          mergedRows = mergeActivityRecoveryRows(mergedRows, recoveredRows)
            .slice(0, rowsPerPage);
          const recoveredSelection = selectActivityWarningRows(
            mergedRows,
            Number(options.minimumInactiveDays)
          );
          if (recoveredSelection.rows.length > previousWarningCount) {
            await report(
              "info",
              "activity_boundary_recovered",
              `第 ${page + 1} 页检测到阈值边界，重读恢复 ${recoveredSelection.rows.length - previousWarningCount} 名离线达到 ${options.minimumInactiveDays} 天的成员`,
              {
                page: page + 1,
                recoveryAttempt,
                beforeWarningRows: previousWarningCount,
                afterWarningRows: recoveredSelection.rows.length,
                recoveredNames: recoveredSelection.rows.map((row) => row.name)
              }
            );
            rows = mergedRows;
            break;
          }
          previousWarningCount = recoveredSelection.rows.length;
          if (!recoveredSelection.reachedBoundary) break;
        }
      }
    }
    if (
      alignedPagedTableMode &&
      scheduledLastPage &&
      page > 0 &&
      expectedTailOverlapCount !== null
    ) {
      const expectedTailNewCount = Math.max(
        1,
        rowsPerPage - expectedTailOverlapCount
      );
      const maxRowsToDiscard = Math.max(
        0,
        rows.length - expectedTailNewCount
      );
      const discardCount = Math.min(
        expectedTailOverlapCount,
        maxRowsToDiscard
      );
      alignedTailOverlapRowIndexes = new Set(
        Array.from({ length: discardCount }, (_, index) => index)
      );
      const tailRowsBeforeTrim = rows.slice();
      rows = rows.filter(
        (_, index) => !alignedTailOverlapRowIndexes.has(index)
      );
      await report(
        "info",
        `${label}_tail_overlap_excluded`,
        `第 ${page + 1} 页按成员资料任务总数 ${expectedCount} 计算为末页，读取后排除顶部 ${expectedTailOverlapCount} 条预期重复行，保留 ${rows.length} 条末页成员`,
        {
          page: page + 1,
          expectedCount,
          expectedPageCount,
          expectedTailOverlapCount,
          expectedTailNewCount,
          predictedOverlapNames: tailRowsBeforeTrim
            .slice(0, discardCount)
            .map((row) => row.name)
            .filter(Boolean),
          overlapCount: discardCount,
          retainedNames: rows.map((row) => row.name).filter(Boolean)
        }
      );
    }
    if (
      alignedPagedTableMode &&
      page === 0 &&
      alignedPageHeightPx <= 0 &&
      definition.pagination.measurePageHeightFromRows !== false
    ) {
      const measurement = measureAlignedTableHeight(
        frame,
        pageDefinition,
        rowsPerPage
      );
      if (measurement) {
        const pageHeightExtraPx = Math.max(
          0,
          Number(definition.pagination.pageHeightExtraPx) || 0
        );
        alignedPageHeightPx = Math.max(
          1,
          measurement.totalHeightPx +
            pageHeightExtraPx -
            ALIGNED_TABLE_PAGE_STEP_REDUCTION_PX
        );
        await report(
          "info",
          "table_page_height_calibrated",
          `第 1 页读取 ${rowsPerPage} 行整体高度 ${measurement.totalHeightPx}px，增加 ${pageHeightExtraPx}px 后按 ${alignedPageHeightPx}px 翻页`,
          {
            page: 1,
            rows: rowsPerPage,
            totalHeightPx: measurement.totalHeightPx,
            extraHeightPx: pageHeightExtraPx,
            swipeHeightPx: alignedPageHeightPx,
            firstRowCenterY: measurement.firstRowCenterY,
            lastRowCenterY: measurement.lastRowCenterY,
            medianRowGapPx: measurement.medianRowGapPx
          }
        );
      }
    }
    if (
      alignedPagedTableMode &&
      page === 0 &&
      !alignedTableFirstRowKind &&
      frame?.path &&
      typeof vision?.probe === "function"
    ) {
      const baselineBands = await readTableColorBands(
        vision,
        frame.path,
        pageDefinition,
        signal
      );
      alignedTableFirstRowKind = baselineBands[0]?.kind || null;
    }
    if (memberDetailsMode) {
      // Normal pages are deliberately non-overlapping five-row windows. Do
      // not run cross-page aliasing/reconciliation on them: a visually valid
      // row whose OCR name resembles a previous row must remain a candidate.
      // Only the calculated tail is allowed to reconcile OCR variants because
      // it is read as one expanded end-page crop and can contain the previous
      // page's half-visible row.
      const rawRows = filterMemberDetailRows(rows);
      if (fullPageRead && page > 0) {
        const previousPageKeys = new Set(
          previousRows
            .map((row) => memberProfileNameKey(row?.name))
            .filter(Boolean)
        );
        tailOverlapKeys = new Set(
          rawRows
            .slice(0, Math.min(expectedTailOverlapCount || 0, rawRows.length))
            .map((row) => memberProfileNameKey(row?.name))
            .filter((key) => key && previousPageKeys.has(key))
        );
        tailOverlapRowIndexes = new Set(
          Array.from(
            {
              length: Math.min(
                expectedTailOverlapCount || 0,
                rawRows.length
              )
            },
            (_, index) => index
          )
        );
      }
      // Detect a duplicate before collapsing it. A repeated row can mean a
      // missed member slot and should still receive row-level recovery.
      memberPageHadExactCollision = hasSuspiciousMemberCollision(
        rawRows,
        byName,
        tailOverlapKeys
      );
      // Exact OCR duplicates are not separate members.  Collapse them before
      // counting/adding the page, while retaining the collision signal above
      // so the row-by-row advisor recovery can still correct a bad read.
      rows = collapseExactMemberDetailRows(rawRows);
      if (fullPageRead || !hasFullPageDefinition) {
        const sourceRows = rows;
        rows = applyPageNameAliases(rows, pageNameAliases);
        rows = reconcilePageRows(previousRows, rows);
        for (let index = 0; index < Math.min(sourceRows.length, rows.length); index += 1) {
          const sourceKey = memberProfileNameKey(sourceRows[index]?.name);
          const canonicalName = String(rows[index]?.name || "").trim();
          if (
            sourceKey &&
            canonicalName &&
            sourceKey !== memberProfileNameKey(canonicalName)
          ) {
            pageNameAliases.set(sourceKey, canonicalName);
          }
        }
      }
      if (fullPageRead && page > 0) {
        const previousPageKeys = new Set(
          previousRows
            .map((row) => memberProfileNameKey(row?.name))
            .filter(Boolean)
        );
        observedTailOverlapKeys = new Set(
          rows
            .map((row) => memberProfileNameKey(row?.name))
            .filter((key) => key && previousPageKeys.has(key))
        );
        if (tailOverlapKeys.size || expectedTailOverlapCount > 0) {
          await report(
            "info",
            "member_details_tail_overlap_excluded",
            `第 ${page + 1} 页按顶部 ${expectedCount} 名成员计算，末页预期排除 ${expectedTailOverlapCount} 个重复行；实际排除：${rows
              .filter((_, index) => tailOverlapRowIndexes.has(index))
              .map((row) => row.name)
              .join("、") || "无"}`,
            {
              page: page + 1,
              expectedTailOverlapCount,
              predictedOverlapNames: rows
                .filter((_, index) => tailOverlapRowIndexes.has(index))
                .map((row) => row.name),
              observedOverlapNames: rows
                .filter((row) =>
                  observedTailOverlapKeys.has(memberProfileNameKey(row?.name))
                )
                .map((row) => row.name),
              overlapNames: rows
                .filter((_, index) => tailOverlapRowIndexes.has(index))
                .map((row) => row.name),
              overlapCount: tailOverlapRowIndexes.size,
              observedOverlapCount: observedTailOverlapKeys.size
            }
          );
        }
      }
    }
    const memberPageNovelty = memberDetailsMode
      ? pageNovelMemberCount(rows, byName)
      : null;
    const shouldRecoverMemberPage =
      memberDetailsMode &&
      frame?.path &&
      (rows.length < minimumRowsPerPage ||
        memberPageHadExactCollision ||
        hasSuspiciousMemberCollision(rows, byName, tailOverlapKeys) ||
        (fullPageRead &&
          memberPageNovelty < rows.length - tailOverlapKeys.size &&
          rows.length >= memberRowsPerPage) ||
        (expectedCount !== null &&
          byName.size < expectedCount &&
          memberPageNovelty === 0));
    if (shouldRecoverMemberPage) {
      const recoveredRows = await vision.extractTableRows(
        frame.path,
        pageDefinition,
        `${label}-${page + 1}-page-recovery`,
        signal,
        { forceMemberAdvisor: true }
      ).catch(async (error) => {
        await report(
          "warning",
          "member_details_page_recovery_failed",
          `第 ${page + 1} 页存在漏行/重复行风险，但模型强化重读失败`,
          { reason: error.message }
        );
        return [];
      });
      const reconciledRecovery = collapseExactMemberDetailRows(
        filterMemberDetailRows(recoveredRows).filter(
          (row) =>
            row.name &&
            !pageDefinition.headerPattern.some((value) =>
              row.name.includes(value)
            )
        )
      );
      const visibleRows = fullPageRead
        ? Number(pageDefinition.pagination.fullPageRows) || 7
        : Number(definition.pagination.rowsPerPage) || 5;
      const originalNovelty = pageNovelMemberCount(rows, byName);
      const recoveredNovelty = pageNovelMemberCount(
        reconciledRecovery,
        byName
      );
      // The forced member advisor can correct a duplicated OCR name while
      // omitting another valid row (the live failure was a tail page where
      // it returned four rows and dropped Orange). For the calculated tail,
      // combine the stronger recovery candidates with the original native
      // candidates instead of rejecting the recovery solely because it has
      // fewer raw rows. The expanded tail crop already excludes the sticky
      // current-player row at the bottom of the page.
      const recoveryCandidates = fullPageRead
          ? mergeMemberRecoveryCandidates(
            reconciledRecovery,
            rows,
            Math.max(1, visibleRows),
            byName
          )
        : reconciledRecovery;
      const recoveryCandidateNovelty = pageNovelMemberCount(
        recoveryCandidates,
        byName
      );
      const shouldUseRecovery = fullPageRead
        ? recoveryCandidateNovelty > originalNovelty ||
          (memberPageNovelty < rows.length &&
            recoveryCandidates.length >= rows.length)
        : reconciledRecovery.length >= rows.length &&
          recoveredNovelty > originalNovelty;
      if (
        shouldUseRecovery
      ) {
        await report(
          "info",
          "member_details_page_recovered",
          `第 ${page + 1} 页强化重读恢复了 ${recoveryCandidateNovelty - originalNovelty} 名新的成员候选`,
          {
            beforeNames: rows.map((row) => row.name),
            recoveredNames: recoveryCandidates.map((row) => row.name),
            rawRecoveredNames: reconciledRecovery.map((row) => row.name)
          }
        );
        rows = recoveryCandidates.slice(0, Math.max(1, visibleRows));
      } else {
        await report(
          "warning",
          "member_details_page_recovery_unresolved",
          `第 ${page + 1} 页强化重读未能安全增加唯一成员，继续翻页或执行整页重扫`,
          {
            names: rows.map((row) => row.name),
            recoveredNames: recoveryCandidates.map((row) => row.name),
            rawRecoveredNames: reconciledRecovery.map((row) => row.name)
          }
        );
      }
    }
    if (memberDetailsMode && fullPageRead && scheduledLastPage) {
      // The game can place the last real member in the same vertical slot as
      // the sticky bottom assistant row. That is a physical UI defect, not a
      // reason to invent a placeholder member. Keep every normal page strict,
      // but allow exactly one absent new row on the calculated final page.
      finalTailExpectedRows = Math.max(
        1,
        memberRowsPerPage - (expectedTailOverlapCount || 0)
      );
      const finalTailOverlapRows = rows.filter((row, index) => {
        const key = memberProfileNameKey(row?.name);
        return (
          tailOverlapRowIndexes.has(index) ||
          (key &&
            (tailOverlapKeys.has(key) || observedTailOverlapKeys.has(key)))
        );
      });
      finalTailRecognizedRows = Math.max(
        0,
        rows.length - finalTailOverlapRows.length
      );
      finalTailMissingCount = Math.max(
        0,
        finalTailExpectedRows - finalTailRecognizedRows
      );
      finalTailMissingAllowed = finalTailMissingCount === 1;
      if (scanState && typeof scanState === "object") {
        scanState.finalPage = page + 1;
        scanState.finalPageExpectedRows = finalTailExpectedRows;
        scanState.finalPageRecognizedRows = finalTailRecognizedRows;
        scanState.finalPageMissingCount = finalTailMissingCount;
        scanState.finalPageMissingAllowed = finalTailMissingAllowed;
        scanState.finalPagePositionLocked = true;
      }
      if (finalTailMissingAllowed) {
        await report(
          "warning",
          "member_details_tail_missing_allowed",
          `第 ${page + 1} 页末页因最后一行与固定底部行重叠，实际缺失 1 名成员；保留已识别列表，不补造成员，按 ${finalTailRecognizedRows}/${finalTailExpectedRows} 个末页新成员上报`,
          {
            page: page + 1,
            expectedCount,
            expectedPageCount,
            expectedTailOverlapCount,
            expectedTailRows: finalTailExpectedRows,
            recognizedTailRows: finalTailRecognizedRows,
            missingCount: finalTailMissingCount,
            positionLocked: true
          }
        );
      } else if (finalTailMissingCount > 1) {
        await report(
          "warning",
          "member_details_tail_missing_unresolved",
          `第 ${page + 1} 页末页缺少 ${finalTailMissingCount} 名成员，超过允许的 1 人缺口；不把缺口伪装成完整名单`,
          {
            page: page + 1,
            expectedCount,
            expectedPageCount,
            expectedTailOverlapCount,
            expectedTailRows: finalTailExpectedRows,
            recognizedTailRows: finalTailRecognizedRows,
            missingCount: finalTailMissingCount,
            positionLocked: true
          }
        );
      }
    }
    if (memberDetailsMode && !fullPageRead && rows.length < memberRowsPerPage) {
      const retryCount = (memberPageRetries.get(page) || 0) + 1;
      if (retryCount <= maxMemberPageRetries) {
        memberPageRetries.set(page, retryCount);
        const recognizedNames = rows
          .map((row) => String(row?.name || "").trim())
          .filter(Boolean);
        await report(
          "warning",
          "member_details_page_incomplete_retry",
          `第 ${page + 1} 页只确认 ${rows.length}/${memberRowsPerPage} 行，保持当前位置重读，不推进到下一页（第 ${retryCount}/${maxMemberPageRetries} 次）；当前已读到：${recognizedNames.join("、") || "无"}`,
          {
            page: page + 1,
            recognizedRows: rows.length,
            expectedRows: memberRowsPerPage,
            recognizedNames
          }
        );
        continue;
      }
      if (scheduledLastPage && hasFullPageDefinition) {
        // A normal five-row crop may hide the final partial row. Re-read the
        // calculated final page with the expanded tail crop before deciding
        // that this is the last page; an incomplete intermediate page must
        // never be promoted to the tail just because its crop is short.
        tailFullPagePending = true;
        tailFullPageReason = "incomplete";
        memberPageRetries.delete(page);
        continue;
      }
      stoppedOnIncompletePage = true;
      incompletePage = page + 1;
      incompletePageNames = rows
        .map((row) => String(row?.name || "").trim())
        .filter(Boolean);
      if (scanState && typeof scanState === "object") {
        scanState.stoppedOnIncompletePage = true;
        scanState.incompletePage = page + 1;
      }
      await report(
        "warning",
        "member_details_incomplete_stop",
        `第 ${page + 1} 页连续重读仍未达到 ${memberRowsPerPage} 行，已立即停止翻页；当前结果为 ${rows.length} 行；当前已读到：${incompletePageNames.join("、") || "无"}`,
        {
          page: page + 1,
          recognizedRows: rows.length,
          recognizedNames: incompletePageNames,
          maxRetries: maxMemberPageRetries
        }
      );
      // Keep the rows that were actually recognized on this page. They are
      // included in the mismatch count so the scheduled retry has an
      // accurate failure reason, while the page is not allowed to advance.
      stopAfterIncompletePage = true;
    }
    memberPageRetries.delete(page);
    const pagePlayerNames = rows
      .map((row) => String(row?.name || "").trim())
      .filter(Boolean);
    if (options.scanStats && Array.isArray(options.scanStats.scannedNames)) {
      const knownNames = new Set(options.scanStats.scannedNames);
      for (const name of pagePlayerNames) {
        if (knownNames.has(name)) continue;
        knownNames.add(name);
        options.scanStats.scannedNames.push(name);
      }
    }
    options.observedParsedRows =
      (Number(options.observedParsedRows) || 0) + rows.length;
    let reachedActivityBoundary = false;
    if (Number.isFinite(Number(options.minimumInactiveDays))) {
      const selection = selectActivityWarningRows(
        rows,
        Number(options.minimumInactiveDays)
      );
      rows = selection.rows;
      reachedActivityBoundary = selection.reachedBoundary;
      if (reachedActivityBoundary) {
        options.thresholdBoundaryReached = true;
      }
    }
    const fingerprint = rows.map((row) => row.name).join("|");
    let added = 0;
    let rejectedAfterExpectedCount = 0;
    if (contributionTableMode) {
      // Contribution pages are retained as raw page output.  Overlap and
      // duplicate names are deliberately preserved until the complete scan
      // finishes; only then does captureContribution deduplicate by name.
      for (const row of rows) {
        contributionRows.push({ ...row });
        const rowKey = contributionNameKey(row.name);
        if (rowKey && !contributionNames.has(rowKey)) {
          contributionNames.add(rowKey);
          added += 1;
        }
      }
    } else {
      for (const [rowIndex, row] of rows.entries()) {
        const baseRowKey = memberDetailsMode
          ? memberProfileNameKey(row.name)
          : row.name;
        const rowKey = baseRowKey;
        if (!rowKey) continue;
        if (
          memberDetailsMode &&
          fullPageRead &&
          (tailOverlapRowIndexes.has(rowIndex) ||
            tailOverlapKeys.has(rowKey) ||
            observedTailOverlapKeys.has(rowKey))
        ) {
          rejectedAfterExpectedCount += 1;
          continue;
        }
        const current = byName.get(rowKey) || {};
        if (
          !byName.has(rowKey) &&
          !memberDetailsMode &&
          !contributionTableMode &&
          expectedCount !== null &&
          byName.size >= expectedCount
        ) {
          rejectedAfterExpectedCount += 1;
          continue;
        }
        if (!byName.has(rowKey)) added += 1;
        const storedRow = memberDetailsMode && hasFullPageDefinition
          ? {
              ...row,
              __memberPage: page + 1,
              __memberTail: fullPageRead
            }
          : row;
        byName.set(
          rowKey,
          memberDetailsMode
            ? mergeMemberProfileRows(current, storedRow)
            : { ...current, ...row }
        );
      }
    }
    const accumulatedRows = contributionTableMode
      ? contributionRows.length
      : byName.size;
    const elapsedMs = Date.now() - pageStartedAt;
    const finalPlayerNames = memberDetailsMode
      ? rows
          .map((row) => String(row?.name || "").trim())
          .filter(Boolean)
      : null;
    await report(
      "info",
      `${label}_page`,
      memberDetailsMode
        ? `第 ${page + 1} 页识别 ${rows.length} 行，最终玩家：${finalPlayerNames.join("、") || "无"}，累计 ${byName.size} 名成员（耗时 ${elapsedMs}ms）`
        : `第 ${page + 1} 页识别 ${rows.length} 行，扫描成员：${pagePlayerNames.join("、") || "无"}，累计 ${accumulatedRows} 行（耗时 ${elapsedMs}ms）`,
      {
        screenshot: frame.path,
        expectedCount,
        rejectedAfterExpectedCount,
        accumulatedRows,
        uniqueNames: contributionTableMode ? contributionNames.size : byName.size,
        pagePlayerNames,
        pagePlayerNameCount: pagePlayerNames.length,
        elapsedMs,
        ...(memberDetailsMode ? { finalPlayerNames } : {})
      }
    );
    const scanProgress = progressForRange(
      options.progressRange?.start,
      options.progressRange?.end,
      scannedPages,
      definition.pagination.maxPages
    );
    await updateWorkflowProgress(
      context,
      scanProgress,
      options.progressRange?.step || `${label}_page`
    );
    if (stopAfterIncompletePage) break;
    const unexpectedTailOverlapCount =
      fullPageRead && page > 0
        ? Math.max(
            0,
            observedTailOverlapKeys.size - (expectedTailOverlapCount || 0)
          )
        : 0;
    if (
      memberDetailsMode &&
      fullPageRead &&
      currentTailReason === "scheduled-last" &&
      expectedCount !== null &&
      byName.size < expectedCount &&
      unexpectedTailOverlapCount > 0 &&
      tailCorrectionAttempts < 2
    ) {
      tailCorrectionAttempts += 1;
      await report(
        "warning",
        "member_details_tail_alignment_correction",
        `第 ${page + 1} 页末页实际多出 ${unexpectedTailOverlapCount} 个上一页重复行，保持固定位置原地重读，不上移、不增加扫描页数`,
        {
          page: page + 1,
          expectedTailOverlapCount,
          observedOverlapCount: observedTailOverlapKeys.size,
          unexpectedTailOverlapCount,
          attempt: tailCorrectionAttempts,
          positionLocked: true
        }
      );
      tailFullPagePending = true;
      tailFullPageReason = "tail-correction";
      continue;
    }
    const organizedMemberCount =
      memberDetailsMode && expectedCount !== null
        ? reconcileMemberDetailRows([...byName.values()], expectedCount).length
        : null;
    const scheduledTailPage =
      currentTailReason === "scheduled-last" ||
      currentTailReason === "tail-correction";
    if (
      memberDetailsMode &&
      fullPageRead &&
      currentTailReason === "incomplete" &&
      !finalTailMissingAllowed &&
      rows.length < memberRowsPerPage
    ) {
      stoppedOnIncompletePage = true;
      incompletePage = page + 1;
      incompletePageNames = rows
        .map((row) => String(row?.name || "").trim())
        .filter(Boolean);
      if (scanState && typeof scanState === "object") {
        scanState.stoppedOnIncompletePage = true;
        scanState.incompletePage = page + 1;
      }
      await report(
        "warning",
        "member_details_incomplete_stop",
        `第 ${page + 1} 页连续重读仍未达到 ${memberRowsPerPage} 行，已立即停止翻页；当前整页重读结果为 ${rows.length} 行；当前已读到：${incompletePageNames.join("、") || "无"}`,
        {
          page: page + 1,
          recognizedRows: rows.length,
          recognizedNames: incompletePageNames,
          maxRetries: maxMemberPageRetries
        }
      );
      break;
    }
    if (
      memberDetailsMode &&
      fullPageRead &&
      scheduledLastPage &&
      finalTailMissingCount > 1
    ) {
      stoppedOnIncompletePage = true;
      incompletePage = page + 1;
      incompletePageNames = rows
        .map((row) => String(row?.name || "").trim())
        .filter(Boolean);
      if (scanState && typeof scanState === "object") {
        scanState.stoppedOnIncompletePage = true;
        scanState.incompletePage = page + 1;
      }
      await report(
        "warning",
        "member_details_incomplete_stop",
        `第 ${page + 1} 页末页缺少 ${finalTailMissingCount} 名成员，超过允许的 1 人缺口，已停止翻页；当前整页读取到 ${finalTailRecognizedRows}/${finalTailExpectedRows} 个末页新成员`,
        {
          page: page + 1,
          recognizedRows: rows.length,
          recognizedNames: incompletePageNames,
          expectedTailRows: finalTailExpectedRows,
          recognizedTailRows: finalTailRecognizedRows,
          missingCount: finalTailMissingCount,
          maxRetries: maxMemberPageRetries,
          positionLocked: true
        }
      );
      break;
    }
    if (
      memberDetailsMode &&
      fullPageRead &&
      (currentTailReason === "stagnant" ||
        scheduledTailPage ||
        (currentTailReason === "incomplete" &&
          (rows.length >= memberRowsPerPage || finalTailMissingAllowed)))
    ) {
      await report(
        "info",
        "member_details_tail_complete",
        `已按顶部 ${expectedCount} 名成员计算末页为第 ${expectedPageCount} 页，并整页读取末页；末页整理为 ${organizedMemberCount} 行，停止继续滚动`,
        {
          page: page + 1,
          expectedPageCount,
          maxMemberPageCount,
          recognizedRows: rows.length,
          recognized: byName.size,
          organizedMemberCount,
          expectedCount,
          finalPageMissingCount: finalTailMissingCount,
          finalPageExpectedRows: finalTailExpectedRows,
          finalPageRecognizedRows: finalTailRecognizedRows,
          finalPageMissingAllowed: finalTailMissingAllowed,
          positionLocked: true
        }
      );
      break;
    }
    if (reachedActivityBoundary) {
      await report(
        "info",
        "activity_threshold_reached",
        `已读到离线时间小于 ${options.minimumInactiveDays} 天的成员，斩杀预警读取提前结束`,
        {
          minimumInactiveDays: Number(options.minimumInactiveDays),
          warningMembers: byName.size
        }
      );
      break;
    }
    // Member details must be scanned through the actual list end. OCR can
    // temporarily produce a different spelling for a row on a later page;
    // stopping as soon as the header count is reached would skip the tail and
    // make the final reconciliation depend on page order. The final pass
    // below deduplicates and caps the organized roster to the header total.
    if (
      !memberDetailsMode &&
      !alignedPagedTableMode &&
      expectedCount !== null &&
      byName.size >= expectedCount
    ) {
      await report(
        "info",
        `${label}_expected_count_reached`,
        `已达到页面顶部报告的 ${expectedCount} 名成员，结束本表扫描`,
        {
          expectedCount,
          recognized: byName.size,
          page: page + 1,
          rejectedAfterExpectedCount
        }
      );
      break;
    }
    if (alignedPagedTableMode && scheduledLastPage) {
      await report(
        "info",
        `${label}_tail_complete`,
        `${label.startsWith("member-contribution") ? "贡献" : "斩杀预警"}列表已按成员资料任务总数 ${expectedCount} 扫描到预测末页第 ${expectedPageCount} 页，末页整理后停止继续翻页`,
        {
          expectedCount,
          expectedPageCount,
          page: page + 1,
          recognized: contributionTableMode
            ? contributionNames.size
            : byName.size,
          expectedTailOverlapCount,
          retainedRows: rows.length
        }
      );
      break;
    }
    const beforeCalculatedTail =
      memberDetailsMode &&
      hasFullPageDefinition &&
      expectedPageCount !== null &&
      page + 1 < expectedPageCount;
    // A repeated OCR spelling on a normal page is not evidence that the
    // list reached its end when the header-derived tail is still ahead. Keep
    // the calculated N-page scan moving; only N and the permitted tail pages
    // may use stagnant-page termination.
    stagnantPages = beforeCalculatedTail
      ? 0
      : added === 0 || fingerprint === previousFingerprint
        ? stagnantPages + 1
        : 0;
    const repeatedMemberPage =
      memberDetailsMode &&
      page > 0 &&
      fullPageRead &&
      (fingerprint === previousFingerprint ||
        (added === 0 && rows.length >= memberRowsPerPage));
    if (repeatedMemberPage && hasFullPageDefinition) {
      // A repeated complete page means the five-row drag has reached the
      // bottom and clamped. Re-read this same position once with the full
      // tail crop, then stop; do not spend several more swipes on the same
      // final page.
      tailFullPagePending = true;
      tailFullPageReason = "stagnant";
      continue;
    }
    if (currentTailReason === "stagnant" && expectedCount !== null && byName.size >= expectedCount) {
      await report(
        "info",
        "member_details_tail_complete",
        `已在末页整页重读后达到顶部报告的 ${expectedCount} 名成员，结束成员列表扫描`,
        {
          expectedCount,
          recognized: byName.size,
          page: page + 1
        }
      );
      break;
    }
    if (
      !beforeCalculatedTail &&
      stagnantPages >= definition.pagination.stopAfterStagnantPages
    ) {
      break;
    }
    previousFingerprint = fingerprint;
    previousRows = rows.map((row) => ({ ...row }));
    const memberPageLimitReached =
      memberDetailsMode &&
      (page + 1 >= memberPageHardLimit ||
        (maxMemberPageCount !== null && page + 1 >= maxMemberPageCount));
    if (memberPageLimitReached || page + 1 >= definition.pagination.maxPages) {
      await report(
        "info",
        `${label}_page_limit_reached`,
        memberPageLimitReached
          ? `已达到成员扫描页数上限 ${memberPageHardLimit} 页，不再继续翻页`
          : `已扫描配置上限 ${definition.pagination.maxPages} 页，不再继续翻页`,
        { expectedPageCount, maxMemberPageCount: memberPageHardLimit }
      );
      break;
    }
    const swipeFrom =
      memberDetailsMode && page === 0 && definition.pagination.firstPageFrom
        ? definition.pagination.firstPageFrom
        : definition.pagination.from;
    const swipeTo =
      memberDetailsMode && page === 0 && definition.pagination.firstPageTo
        ? definition.pagination.firstPageTo
        : definition.pagination.to;
    const effectiveAlignedSwipeTo =
      alignedPagedTableMode && alignedPageHeightPx > 0
        ? {
            ...swipeTo,
            y: Math.round(Number(swipeFrom.y) - alignedPageHeightPx)
          }
        : swipeTo;
    if (memberDetailsMode || alignedPagedTableMode) {
      // MuMu accelerates a single long mouse swipe near the endpoint. That
      // can jump past one or more rows. Send the same calibrated drag as
      // small MOVE segments and release immediately at the calibrated
      // endpoint so the next page starts on a row boundary. The calibrated
      // duration is shortened by 40% to increase speed without changing
      // either endpoint or the segmented path.
      const usedTouchFallback = await memberAlignmentSwipe(
        adb,
        swipeFrom,
        effectiveAlignedSwipeTo,
        scaledTableSwipeDurationMs(definition.pagination.durationMs),
        signal
      );
      if (usedTouchFallback) {
        await report(
          "warning",
          memberDetailsMode
            ? "member_details_swipe_touch_fallback"
            : "table_swipe_touch_fallback",
          memberDetailsMode
            ? "成员详情滚动的 MuMu 鼠标注入被系统拒绝，已切换 Android 触摸滑动"
            : `${contributionTableMode ? "贡献" : "斩杀预警"}列表滚动的 MuMu 鼠标注入被系统拒绝，已切换 Android 触摸滑动`
        );
      }
    } else {
      await adb.mouseSwipe(
        swipeFrom,
        swipeTo,
        definition.pagination.durationMs,
        signal
      );
    }
    const fixedPageSettle =
      label.startsWith("member-contribution") || label.startsWith("member-activity");
    const settleAfterSwipeMs = fixedPageSettle
      ? alignedPagedTableMode
        ? scaledTableSettleMs(
            Math.min(
              2_000,
              Number(definition.pagination.settleAfterSwipeMs) || 2_000
            ),
            2_000,
            600
          )
        : scaledTableSettleMs(
            definition.pagination.settleAfterSwipeMs,
            3_000,
            1_800
          )
      : scaledTableSettleMs(definition.pagination.settleAfterSwipeMs, 0);
    if (settleAfterSwipeMs > 0) {
      await (context.sleep || delay)(settleAfterSwipeMs, signal);
    } else {
      await ui.afterAction(signal);
    }
    page += 1;
  }
  const rows = contributionTableMode ? contributionRows : [...byName.values()];
  if (memberDetailsMode) {
    const reconciled = reconcileMemberDetailRows(rows, expectedCount);
    if (scanState && typeof scanState === "object") {
      scanState.pages = scannedPages;
      scanState.reconciledRows = reconciled.length;
    }
    const scanStoppedOnIncompletePage =
      stoppedOnIncompletePage || scanState?.stoppedOnIncompletePage === true;
    const finalStep = scanStoppedOnIncompletePage
      ? "member_details_scan_stopped_incomplete"
      : "member_details_bottom_reached";
    const finalMessage = scanStoppedOnIncompletePage
      ? expectedCount !== null
        ? `成员资料第 ${incompletePage || scanState?.incompletePage || scannedPages} 页连续重读达到最多 ${maxMemberPageRetries} 次仍不完整，停止当前扫描；整理为 ${reconciled.length}/${expectedCount} 名成员；当前已读到：${incompletePageNames.join("、") || "无"}`
        : `成员资料第 ${incompletePage || scanState?.incompletePage || scannedPages} 页连续重读达到最多 ${maxMemberPageRetries} 次仍不完整，停止当前扫描；整理为 ${reconciled.length} 名成员；当前已读到：${incompletePageNames.join("、") || "无"}`
      : expectedCount !== null
        ? finalTailMissingAllowed
          ? `成员资料列表已完整翻到底部，扫描 ${scannedPages} 页；末页因最后一行与固定底部行重叠允许缺失 1 人，全表整理为 ${reconciled.length}/${expectedCount} 名成员`
          : `成员资料列表已完整翻到底部，扫描 ${scannedPages} 页；全表去重合并后整理为 ${reconciled.length}/${expectedCount} 名成员`
        : `成员资料列表已完整翻到底部，扫描 ${scannedPages} 页；整理结果为 ${reconciled.length} 名成员`;
    await report(
      scanStoppedOnIncompletePage ? "warning" : "info",
      finalStep,
      finalMessage,
      {
        pages: scannedPages,
        scannedRows: rows.length,
        reconciledRows: reconciled.length,
        expectedCount,
        finalPageMissingCount: finalTailMissingCount,
        finalPageExpectedRows: finalTailExpectedRows,
        finalPageRecognizedRows: finalTailRecognizedRows,
        finalPageMissingAllowed: finalTailMissingAllowed,
        positionLocked: finalTailMissingAllowed,
        stoppedAtExpectedCount: false,
        ...(scanStoppedOnIncompletePage
          ? {
              incompletePage: incompletePage || scanState?.incompletePage || scannedPages,
              maxRetries: maxMemberPageRetries,
              recognizedNames: incompletePageNames
            }
          : {})
      }
    );
    return reconciled;
  }
  return rows;
}

function measureAlignedTableHeight(frame, definition, expectedRows) {
  const observations = Array.isArray(frame?.observations)
    ? frame.observations
    : [];
  const region = definition?.region;
  const nameColumn = definition?.columns?.find((column) => column.key === "name");
  if (!observations.length || !region || !nameColumn) return null;
  const width = region.right - region.left;
  const left = region.left + width * Number(nameColumn.left || 0);
  const right = region.left + width * Number(nameColumn.right || 1);
  const candidates = observations
    .filter((item) => {
      const centerX = Number(item.x) + Number(item.width || 0) / 2;
      const centerY = Number(item.y) + Number(item.height || 0) / 2;
      return (
        Number.isFinite(centerX) &&
        Number.isFinite(centerY) &&
        centerX >= left &&
        centerX <= right &&
        centerY >= region.top &&
        centerY <= region.bottom &&
        String(item.text || "").trim()
      );
    })
    .map((item) => ({
      centerY: Number(item.y) + Number(item.height || 0) / 2,
      height: Math.max(1, Number(item.height) || 1)
    }))
    .sort((a, b) => a.centerY - b.centerY);
  if (!candidates.length) return null;
  const medianTextHeight = medianValue(candidates.map((item) => item.height)) || 24;
  const rows = [];
  for (const candidate of candidates) {
    const previous = rows.at(-1);
    if (
      !previous ||
      candidate.centerY - previous.centerY > Math.max(18, medianTextHeight * 1.25)
    ) {
      rows.push({ ...candidate });
    } else {
      previous.centerY = (previous.centerY + candidate.centerY) / 2;
      previous.height = Math.max(previous.height, candidate.height);
    }
  }
  const selected = rows.slice(0, Math.max(1, Number(expectedRows) || 11));
  if (selected.length < Math.max(1, Number(expectedRows) || 11)) return null;
  const gaps = selected
    .slice(1)
    .map((row, index) => row.centerY - selected[index].centerY)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!gaps.length) return null;
  const medianRowGapPx = medianValue(gaps);
  return {
    firstRowCenterY: Math.round(selected[0].centerY),
    lastRowCenterY: Math.round(selected.at(-1).centerY),
    medianRowGapPx: Math.round(medianRowGapPx),
    totalHeightPx: Math.round(
      selected.at(-1).centerY - selected[0].centerY + medianRowGapPx
    )
  };
}

function withAlignedPagedTableCalibration(definition, kind) {
  const source = definition || {};
  const sourcePagination = source.pagination || {};
  const hasPageHeightOverride = Object.prototype.hasOwnProperty.call(
    sourcePagination,
    "pageHeightPx"
  );
  const rowsPerPage = Math.max(
    1,
    Number(sourcePagination.rowsPerPage) || 11
  );
  const rowHeightPx = Math.max(
    1,
    Number(sourcePagination.rowHeightPx) || 66
  );
  const configuredMaxAlignments = Number(sourcePagination.maxRowAlignments);
  const sourceFrom = sourcePagination.from || {};
  const from = {
    x: Number(sourceFrom.x) || 1550,
    y: Number(sourcePagination.swipeStartY) || 980
  };
  const to = {
    x: Number(sourcePagination.to?.x) || Number(from.x) || 1550,
    y: Math.round(Number(from.y) - rowsPerPage * rowHeightPx)
  };
  return {
    ...source,
    rowAnchorTop:
      Number(source.rowAnchorTop ?? sourcePagination.rowAnchorTop) || 285,
    pagination: {
      ...sourcePagination,
      from,
      to,
      durationMs: Math.max(1_000, Number(sourcePagination.durationMs) || 1_000),
      rowsPerPage,
      minimumRowsPerPage: rowsPerPage,
      rowHeightPx,
      measurePageHeightFromRows:
        sourcePagination.measurePageHeightFromRows !== false,
      // Runtime configs from before the explicit calibration field did not
      // carry pageHeightPx. Use the validated MuMu target of 730px for those
      // configs; tests/plugins can explicitly set 0 to keep measurement mode.
      pageHeightPx: hasPageHeightOverride
        ? Math.max(
            0,
            Number(sourcePagination.pageHeightPx) > 0
              ? Number(sourcePagination.pageHeightPx) -
                ALIGNED_TABLE_PAGE_STEP_REDUCTION_PX
              : 0
          )
        : 730 - ALIGNED_TABLE_PAGE_STEP_REDUCTION_PX,
      pageHeightExtraPx: Math.max(
        0,
        Number(sourcePagination.pageHeightExtraPx) ||
          (hasPageHeightOverride ? 5 : 0)
      ),
      rowColorMetric: sourcePagination.rowColorMetric || "luminance",
      rowColorAdaptive: sourcePagination.rowColorAdaptive !== false,
      rowColorSampleStepPx:
        Math.max(2, Number(sourcePagination.rowColorSampleStepPx) || 5),
      rowResidualMaxPx: Math.max(
        8,
        Number(sourcePagination.rowResidualMaxPx) || 18
      ),
      maxRowAlignments: Number.isFinite(configuredMaxAlignments)
        ? Math.max(0, Math.min(2, configuredMaxAlignments))
        : 1,
      rowAlignmentDurationMs:
        Math.max(100, Number(sourcePagination.rowAlignmentDurationMs) || 1_000),
      rowAlignmentSettleMs:
        Math.max(500, Number(sourcePagination.rowAlignmentSettleMs) || 1_500),
      calibrationKind: kind
    }
  };
}

async function alignPagedTablePage(
  context,
  label,
  definition,
  page,
  signal,
  firstRowKind = null
) {
  const { vision, adb, report } = context;
  if (
    !definition?.region ||
    typeof vision?.probe !== "function" ||
    typeof adb?.mouseSwipe !== "function"
  ) {
    return null;
  }
  let frame = await captureTableFrame(context, `${label}-alignment`, definition, signal);
  const pagination = definition.pagination || {};
  const configuredMaxAdjustments = Number(pagination.maxRowAlignments);
  const maxAdjustments = Number.isFinite(configuredMaxAdjustments)
    ? Math.max(0, Math.min(2, configuredMaxAdjustments))
    : 1;
  for (let attempt = 1; attempt <= maxAdjustments; attempt += 1) {
    const bands = await readTableColorBands(
      vision,
      frame.path,
      definition,
      signal
    );
    const adjustment = tableRowAlignmentAdjustment(
      bands,
      definition,
      pagination,
      page,
      firstRowKind
    );
    if (!adjustment) return frame;
    const directionLabel = adjustment.direction === "up" ? "上移" : "下移";
    await report(
      "info",
      "table_row_alignment",
      `${label} 第 ${page + 1} 页检测到顶部色带偏移，按 ${adjustment.distance}px ${directionLabel}自动修正后再读取 ${pagination.rowsPerPage} 行`,
      {
        page: page + 1,
        attempt,
        table: pagination.calibrationKind,
        direction: adjustment.direction,
        distance: adjustment.distance,
        visibleFirstHeight: adjustment.visibleFirstHeight,
        rowHeight: adjustment.rowHeight,
        bands: bands.slice(0, 8)
      }
    );
    const usedTouchFallback = await memberAlignmentSwipe(
      adb,
      { x: adjustment.x, y: adjustment.anchorY },
      {
        x: adjustment.x,
        y:
          adjustment.direction === "up"
            ? adjustment.anchorY - adjustment.distance
            : adjustment.anchorY + adjustment.distance
      },
      scaledTableSwipeDurationMs(pagination.rowAlignmentDurationMs),
      signal
    );
    if (usedTouchFallback) {
      await report(
        "warning",
        "table_swipe_touch_fallback",
        `${pagination.calibrationKind === "contribution" ? "贡献" : "斩杀预警"}列表行对齐的 MuMu 鼠标注入被系统拒绝，已切换 Android 触摸滑动`
      );
    }
    await (context.sleep || delay)(
      scaledTableSettleMs(pagination.rowAlignmentSettleMs, 1_500, 300),
      signal
    );
    frame = await captureTableFrame(
      context,
      `${label}-alignment-${attempt + 1}`,
      definition,
      signal
    );
  }
  return frame;
}

async function readTableColorBands(vision, imagePath, definition, signal) {
  if (!imagePath || !definition?.region) return [];
  const region = definition.region;
  const pagination = definition.pagination || {};
  const step = Math.max(2, Number(pagination.rowColorSampleStepPx) || 5);
  const sampleStart = Math.max(
    region.top,
    Number(definition.rowAnchorTop ?? pagination.rowAnchorTop) || region.top
  );
  const sampleXFractions = [0.12, 0.28, 0.44, 0.60, 0.78, 0.94];
  const points = [];
  for (let y = sampleStart; y <= region.bottom - 5; y += step) {
    for (const fraction of sampleXFractions) {
      points.push({
        x: Math.round(region.left + (region.right - region.left) * fraction),
        y
      });
    }
  }
  let probes;
  try {
    probes = await vision.probe(imagePath, points, 6, signal);
  } catch {
    return [];
  }
  const metric = String(pagination.rowColorMetric || "luminance");
  const byY = new Map();
  for (const probe of Array.isArray(probes) ? probes : []) {
    const y = Number(probe?.y);
    if (!Number.isFinite(y)) continue;
    const value = tableColorValue(probe, metric);
    if (!Number.isFinite(value)) continue;
    const values = byY.get(y) || [];
    values.push(value);
    byY.set(y, values);
  }
  const samples = [...byY.entries()]
    .map(([y, values]) => ({ y: Number(y), value: medianValue(values) }))
    .filter((sample) => Number.isFinite(sample.value))
    .sort((left, right) => left.y - right.y);
  if (!samples.length) return [];
  const adaptive = pagination.rowColorAdaptive !== false;
  const configuredThreshold = Number(pagination.rowColorThreshold);
  const threshold = adaptive
    ? (percentile(samples.map((sample) => sample.value), 0.15) +
        percentile(samples.map((sample) => sample.value), 0.85)) /
      2
    : Number.isFinite(configuredThreshold)
      ? configuredThreshold
      : 0.3;
  const bands = [];
  for (const sample of samples) {
    const kind = sample.value >= threshold ? "light" : "dark";
    const previous = bands.at(-1);
    if (!previous || previous.kind !== kind) {
      bands.push({ kind, start: sample.y, end: sample.y + step });
    } else {
      previous.end = sample.y + step;
    }
  }
  while (
    bands.length > 1 &&
    bands[0].end - bands[0].start < step
  ) {
    bands.shift();
  }
  return bands.map((band) => ({
    ...band,
    length: Math.max(0, band.end - band.start)
  }));
}

function tableColorValue(probe, metric) {
  if (metric === "blue") return Number(probe.meanBlue);
  if (metric === "green") return Number(probe.meanGreen);
  if (metric === "red") return Number(probe.meanRed);
  return (
    Number(probe.meanRed) * 0.2126 +
    Number(probe.meanGreen) * 0.7152 +
    Number(probe.meanBlue) * 0.0722
  );
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction))
  );
  return sorted[index];
}

export function tableRowAlignmentAdjustment(
  bands,
  definition,
  pagination,
  page = 1,
  firstRowKind = null
) {
  if (!Array.isArray(bands) || bands.length < 2) return null;
  const rowHeight = Math.max(1, Number(pagination.rowHeightPx) || 66);
  const first = bands[0];
  const next = bands[1];
  const residualMaxPx = Math.max(
    8,
    Number(pagination.rowResidualMaxPx) || Math.round(rowHeight * 0.25)
  );
  if (first.length > residualMaxPx || next.length < rowHeight * 0.6) {
    return null;
  }
  const visibleFirstHeight = first.length;
  // The first two bands are only actionable when the first visible band is a
  // small residual. Use the alternating row color to distinguish the two
  // possible errors: the expected first-row color means that row is clipped
  // at the top and the list must move down by its missing height; the other
  // color is the previous page's residual and must move up by its visible
  // height. This keeps the correction equal to the measured error rather
  // than applying a full-row gesture that can cover the first row.
  const rowsPerPage = Math.max(1, Number(pagination.rowsPerPage) || 11);
  const expectedFirstRowKind = firstRowKind
    ? (Math.floor(page * rowsPerPage) % 2 === 0
        ? firstRowKind
        : firstRowKind === "light"
          ? "dark"
          : "light")
    : null;
  const direction =
    expectedFirstRowKind && first.kind === expectedFirstRowKind
      ? "down"
      : "up";
  const distance =
    direction === "down"
      ? Math.max(8, Math.round(rowHeight - visibleFirstHeight))
      : Math.max(8, Math.round(visibleFirstHeight));
  const region = definition.region;
  const anchorY = Math.round(
    region.top + (region.bottom - region.top) * 0.42
  );
  const from = pagination.from || {};
  return {
    direction,
    distance,
    visibleFirstHeight,
    rowHeight,
    anchorY,
    x: Number(from.x) || Math.round(region.right - 20)
  };
}

async function alignMemberDetailsPage(
  context,
  label,
  definition,
  page,
  signal
) {
  const { vision, adb, report } = context;
  // Pixel-band alignment is a real-device enhancement. Keep the existing
  // OCR-only path for lightweight test doubles and plugin-defined tables.
  if (
    !definition?.region ||
    typeof vision?.probe !== "function" ||
    typeof adb?.mouseSwipe !== "function"
  ) {
    return null;
  }
  let frame = await captureTableFrame(
    context,
    `${label}-alignment`,
    definition,
    signal
  );
  const pagination = definition.pagination || {};
  const maxAdjustments = Math.max(
    0,
    Math.min(3, Number(pagination.maxRowAlignments) || 1)
  );
  for (let attempt = 1; attempt <= maxAdjustments; attempt += 1) {
    const bands = await readMemberColorBands(
      vision,
      frame.path,
      definition.region,
      pagination,
      signal
    );
    const adjustment = memberRowAlignmentAdjustment(
      bands,
      definition.region,
      page,
      pagination
    );
    if (!adjustment) return frame;
    await report(
      "info",
      "member_details_row_alignment",
      `第 ${page + 1} 页检测到${adjustment.reason}，顶部黑色总数条下边界到首行下边界实际显示 ${adjustment.visibleFirstHeight}px；按 95-${adjustment.visibleFirstHeight}=${adjustment.distance}px ${adjustment.direction === "up" ? "上移" : "下移"}，使首行完整对齐后再读取 5 行`,
      {
        page: page + 1,
        attempt,
        direction: adjustment.direction,
        distance: adjustment.distance,
        visibleFirstHeight: adjustment.visibleFirstHeight,
        rowHeight: adjustment.rowHeight,
        bands: bands.slice(0, 8)
      }
    );
    const usedTouchFallback = await memberAlignmentSwipe(
      adb,
      { x: adjustment.x, y: adjustment.anchorY },
      {
        x: adjustment.x,
        y:
          adjustment.direction === "up"
            ? adjustment.anchorY - adjustment.distance
            : adjustment.anchorY + adjustment.distance
      },
      scaledTableSwipeDurationMs(pagination.rowAlignmentDurationMs),
      signal
    );
    if (usedTouchFallback) {
      await report(
        "warning",
        "member_details_swipe_touch_fallback",
        "成员详情滚动的 MuMu 鼠标注入被系统拒绝，已切换 Android 触摸滑动"
      );
    }
    await (context.sleep || delay)(
      scaledTableSettleMs(pagination.rowAlignmentSettleMs, 1_000, 300),
      signal
    );
    frame = await captureTableFrame(
      context,
      `${label}-alignment-${attempt + 1}`,
      definition,
      signal
    );
  }
  return frame;
}

async function memberAlignmentSwipe(adb, from, to, durationMs, signal) {
  if (typeof adb.shell !== "function") {
    await adb.mouseSwipe(from, to, durationMs, signal);
    return false;
  }
  const distance = Math.abs(Number(to.y) - Number(from.y));
  const steps = Math.max(2, Math.ceil(distance / 10));
    const intervalMs = Math.max(
      TABLE_MOTION_MIN_INTERVAL_MS,
      Math.round(durationMs / steps)
    );
  const shellMotion = async (action, y) => {
    await adb.shell(
      ["input", "mouse", "motionevent", action, Math.round(from.x), Math.round(y)],
      { signal, timeoutMs: 5_000 }
    );
  };
  try {
    await shellMotion("DOWN", from.y);
    for (let step = 1; step <= steps; step += 1) {
      await (delay)(intervalMs, signal);
      const progress = step / steps;
      await shellMotion("MOVE", from.y + (to.y - from.y) * progress);
    }
    await (delay)(intervalMs, signal);
    await shellMotion("UP", to.y);
    return false;
  } catch (error) {
    // Some MuMu/Android images allow input swipe but reject shell-level
    // mouse motionevent injection with INJECT_EVENTS.  A failed segmented
    // mouse gesture must not turn a readable member page into a task crash.
    if (
      typeof adb.touchSwipe !== "function" ||
      !/INJECT_EVENTS|Injecting to another application|SecurityException/i.test(
        String(error?.message || error)
      )
    ) {
      throw error;
    }
    await adb.touchSwipe(from, to, durationMs, signal);
    return true;
  }
}

async function readMemberColorBands(
  vision,
  imagePath,
  region,
  pagination,
  signal
) {
  if (!imagePath) return [];
  const step = Math.max(5, Number(pagination.rowColorSampleStepPx) || 10);
  // Use several columns and take the median. A single point can land on a
  // profession/scene glyph and make a complete background band look clipped.
  const sampleXFractions = [0.38, 0.52, 0.63, 0.75, 0.9];
  const points = [];
  for (let y = region.top + 5; y <= region.bottom - 5; y += step) {
    for (const fraction of sampleXFractions) {
      points.push({
        x: Math.round(region.left + (region.right - region.left) * fraction),
        y
      });
    }
  }
  let probes;
  try {
    probes = await vision.probe(imagePath, points, 6, signal);
  } catch {
    return [];
  }
  const ordered = (Array.isArray(probes) ? probes : [])
    .map((probe) => ({
      y: Number(probe?.y),
      value: Number(
        probe?.meanBlue ?? probe?.meanGreen ?? probe?.meanRed ?? 0
      )
    }))
    .filter(
      (probe) => Number.isFinite(probe.y) && Number.isFinite(probe.value)
    )
    .sort((left, right) => left.y - right.y);
  if (!ordered.length) return [];
  const threshold = Number.isFinite(Number(pagination.rowColorThreshold))
    ? Number(pagination.rowColorThreshold)
    : 0.3;
  const byY = new Map();
  for (const sample of ordered) {
    const values = byY.get(sample.y) || [];
    values.push(sample.value);
    byY.set(sample.y, values);
  }
  const bands = [];
  for (const [y, values] of byY) {
    const kind = medianValue(values) >= threshold ? "light" : "dark";
    const previous = bands.at(-1);
    if (!previous || previous.kind !== kind) {
      bands.push({ kind, start: y, end: y + step });
    } else {
      previous.end = y + step;
    }
  }
  // The horizontal separator immediately below the column header can form a
  // one-sample dark band before the first alternating row color. It is not a
  // clipped member row; remove that artifact before measuring the first row.
  while (
    bands.length > 1 &&
    bands[0].end - bands[0].start <= step * 2
  ) {
    bands.shift();
  }
  return bands.map((band) => ({
    ...band,
    length: Math.max(0, band.end - band.start)
  }));
}

function memberRowAlignmentAdjustment(
  bands,
  region,
  page,
  pagination
) {
  if (!Array.isArray(bands) || bands.length < 2) return null;
  const rowHeight = Math.max(1, Number(pagination.rowHeightPx) || 95);
  const first = bands[0];
  const next = bands[1];
  const fullThreshold = rowHeight - 4;
  const sampleStart = region.top + 5;
  // A one-sample header separator may have been removed from the first band.
  // Add that top gap back so the measured value is the actual visible height,
  // not merely the number of classified color samples.
  const visibleFirstHeight =
    first.length + Math.max(0, first.start - sampleStart);
  const anchorY = Math.round(
    region.top + (region.bottom - region.top) * 0.42
  );
  if (visibleFirstHeight < fullThreshold && next.length >= rowHeight * 0.7) {
    // A 1–5px correction is below the effective MuMu input quantization and
    // often leaves the list visually unchanged. Use 10px as the minimum
    // correction while retaining the measured distance for larger offsets.
    const distance = Math.max(10, Math.round(rowHeight - visibleFirstHeight));
    // The top black member-count bar can cover the first row after a swipe.
    // Move the list down by exactly the missing part so that row is complete;
    // do this once per page because a second correction can skip a row.
    return {
      direction: "down",
      distance,
      visibleFirstHeight,
      rowHeight,
      anchorY,
      x: Math.round(region.left + (region.right - region.left) * 0.94),
      reason: "首行顶部被黑色人数条遮挡"
    };
  }
  return null;
}

function medianValue(values) {
  const sorted = values
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function memberFullPageDefinition(definition) {
  const pagination = definition.pagination || {};
  const fullPageRegion = pagination.fullPageRegion;
  if (!fullPageRegion) return definition;
  const rowHeight = Number(pagination.rowHeightPx);
  const rowAnchorTop = Number(
    definition.rowAnchorTop ?? pagination.rowAnchorTop
  );
  // The end page is not a normal five-row window: the top of the viewport is
  // the lower half of the previous row.  The old definition kept the normal
  // OCR top (285), so Apple OCR/Qwen could spend the first fixed slot on that
  // partial row and the real fifth member was lost behind the sticky bottom
  // assistant row.  Start the effective crop at the first complete row's
  // calibrated boundary.  Keep the configured bottom unchanged because the
  // game's fixed bottom row occupies the area below it and may physically
  // cover the last real member; the workflow handles that as the one allowed
  // final-page gap.
  const configuredTop = Number(fullPageRegion.top);
  const firstCompleteRowTop =
    Number.isFinite(rowHeight) && rowHeight > 0 && Number.isFinite(rowAnchorTop)
      ? rowAnchorTop + rowHeight * 0.5
      : configuredTop;
  const effectiveTop = Number.isFinite(firstCompleteRowTop)
    ? Math.max(configuredTop, Math.round(firstCompleteRowTop))
    : configuredTop;
  return {
    ...definition,
    region: { ...fullPageRegion, top: effectiveTop },
    pagination: {
      ...pagination,
      // The effective region already begins below the leading partial row;
      // retain this marker for the fixed-anchor parser and diagnostics.
      skipLeadingPartialRows: true,
      // Never use a stale seven-row value from an older installed config.
      fullPageRows: Number(pagination.rowsPerPage) || 1,
      rowsPerPage: Number(pagination.rowsPerPage) || 1,
      fullPageRegionEffectiveTop: effectiveTop
    }
  };
}

function filterMemberDetailRows(rows) {
  return (rows || []).filter(
    (row) =>
      row?.name &&
      !isMemberAvatarArtifact(row.name) &&
      !isMemberIdentityBadge(row.name) &&
      !isMemberProfessionArtifact(row.name, row.profession)
  );
}

function collapseExactMemberDetailRows(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    const key = memberProfileNameKey(row?.name);
    if (!key) continue;
    const previous = byName.get(key);
    byName.set(
      key,
      previous ? mergeMemberProfileRows(previous, row) : { ...row }
    );
  }
  return [...byName.values()];
}

function mergeContributionRows(primary, recovered) {
  if (!Array.isArray(recovered) || !recovered.length) return primary;
  if (!Array.isArray(primary) || !primary.length) return recovered;
  const fields = [
    "name",
    "weeklyContribution",
    "technologyPointsUsed",
    "materialContribution"
  ];
  const merged = primary.map((row, index) => {
    const fallback = recovered[index];
    if (!fallback) return row;
    const merged = { ...row };
    for (const field of fields) {
      const currentValue = String(merged[field] || "").trim();
      const recoveredValue = String(fallback[field] || "").trim();
      // Vision.extractTableRows has already applied the shared symbol-aware
      // native/Qwen merge. Prefer its name only when both reads identify the
      // same text core; this replaces a boundary artifact such as `卒`, `米`,
      // `#` or a mayor crest without allowing an unrelated shifted Qwen row
      // to overwrite the native row. Numeric fields retain the native value
      // unless it was missing.
      if (
        field === "name" &&
        recoveredValue &&
        (!currentValue ||
          (sameContributionNameCore(currentValue, recoveredValue) &&
            contributionNameHasOcrBoundaryArtifact(currentValue)))
      ) {
        merged[field] = recoveredValue;
      } else if (!currentValue && recoveredValue) {
        merged[field] = fallback[field];
      }
    }
    return merged;
  });
  return recovered.length > merged.length
    ? [...merged, ...recovered.slice(merged.length)]
    : merged;
}

function sameContributionNameCore(left, right) {
  const core = (value) =>
    Array.from(String(value || "").normalize("NFKC").toLocaleLowerCase())
      .filter((character) => /[\p{L}\p{N}\u3400-\u9fff]/u.test(character))
      .join("");
  const stripBoundary = (value) =>
    value
      .replace(/^(?:9|q|g|4|日|山)/iu, "")
      .replace(/(?:卒|米|導|导|樂|乐|楽|參|午|忠|志)$/u, "");
  const leftCore = stripBoundary(core(left));
  const rightCore = stripBoundary(core(right));
  if (!leftCore || !rightCore) return false;
  if (leftCore === rightCore) return true;
  // One or two Han/digit boundary glyphs can be the OCR rendering of a
  // nearby badge or decoration (`楠卒` vs `楠`, `慕离米` vs `慕离`). Treat
  // this as the same row only when one core is a strict prefix/suffix of the
  // other; unrelated same-length OCR substitutions remain protected.
  return (
    Math.abs(leftCore.length - rightCore.length) <= 2 &&
    (leftCore.startsWith(rightCore) || rightCore.startsWith(leftCore))
  );
}

function contributionNameHasOcrBoundaryArtifact(value) {
  return /(?:卒|米|導|导|樂|乐|楽|參|午|忠|志|[★☆#＃*$+＋&＆]|[”"。)）]|^(?:[9qg4日山]))/iu.test(
    String(value || "").normalize("NFKC").replace(/\s+/gu, "")
  );
}

export function alignContributionRowsToRoster(rows, roster, options = {}) {
  const preserveUnmatched = options?.preserveUnmatched === true;
  const members = (roster || [])
    .map((item) => ({
      name: String(item?.name || "").trim(),
      key: contributionNameKey(item?.name),
      weeklyContribution: Number(item?.weeklyContribution) || 0
    }))
    .filter((item) => item.name && item.key);
  const byCanonicalName = new Map();
  for (const row of rows || []) {
    const sourceKey = contributionNameKey(row?.name);
    if (!sourceKey) continue;
    const exact = members.filter((member) => member.key === sourceKey);
    let matched = exact.length === 1 ? exact[0] : null;
    if (!matched) {
      // A corrected symbol may still be a different Unicode string from the
      // roster (`*慕离米` vs `❀慕离❀`). Match the alphanumeric/CJK core only
      // when it identifies exactly one roster member. If two members share
      // the same core, keep the row unresolved rather than assigning a
      // contribution to the wrong decorated player.
      const sourceCore = contributionNameCore(row?.name);
      const coreCandidates = sourceCore
        ? members.filter((member) => contributionNameCore(member.name) === sourceCore)
        : [];
      if (coreCandidates.length === 1) {
        matched = coreCandidates[0];
      } else if (coreCandidates.length > 1) {
        // The profile snapshot also carries the previous weekly value. It is
        // useful as a conservative tie-breaker when two decorated players
        // share the same text core and the contribution OCR lost both
        // decorations; a tied/stale value remains unresolved for Workers to
        // report as ambiguous.
        const sourceWeekly = Number(row?.weeklyContribution);
        const valueMatches = Number.isFinite(sourceWeekly)
          ? coreCandidates.filter(
              (member) => member.weeklyContribution === sourceWeekly
            )
          : [];
        if (valueMatches.length === 1) matched = valueMatches[0];
      }
    }
    // The mayor card places a small role badge immediately after the name.
    // OCR sometimes returns that badge as one extra Han character (for
    // example 雨梦也). Only accept a unique one/two-character prefix/suffix
    // correction against the authoritative member roster; never create a new
    // member from a contribution-only OCR string.
    if (!matched) {
      const candidates = members.filter((member) => {
        const difference = Math.abs(member.key.length - sourceKey.length);
        return (
          difference > 0 &&
          difference <= 2 &&
          (member.key.startsWith(sourceKey) || sourceKey.startsWith(member.key))
        );
      });
      matched = candidates.length === 1 ? candidates[0] : null;
    }
    // Contribution data is subordinate to the profile roster. In the normal
    // member-sync path an OCR-only name is discarded. The standalone
    // contribution task can retain it for the server-side reconciliation
    // pass, but it still cannot create a member: Workers will either map it
    // to this roster or ignore/report it as ambiguous.
    const canonicalRow = matched ? { ...row, name: matched.name } : { ...row };
    if (!matched && !preserveUnmatched) continue;
    const canonicalKey = matched
      ? contributionNameKey(matched.name)
      : `${contributionNameKey(row?.name)}|${String(row?.weeklyContribution || "")}|${String(row?.technologyPointsUsed || "")}|${String(row?.materialContribution || "")}`;
    const previous = byCanonicalName.get(canonicalKey);
    byCanonicalName.set(
      canonicalKey,
      previous
        ? mergeContributionRecord(previous, canonicalRow)
        : canonicalRow
    );
  }
  return [...byCanonicalName.values()];
}

function contributionNameCore(value) {
  return Array.from(String(value || "").normalize("NFKC").toLocaleLowerCase())
    .filter((character) => /[\p{L}\p{N}\u3400-\u9fff]/u.test(character))
    .join("");
}

function mergeContributionRecord(current, incoming) {
  const merged = { ...current, name: current.name || incoming.name };
  for (const field of [
    "weeklyContribution",
    "technologyPointsUsed",
    "materialContribution"
  ]) {
    const existing = String(merged[field] || "").trim();
    const next = String(incoming[field] || "").trim();
    if (!existing) {
      if (next) merged[field] = next;
      continue;
    }
    if (/^\d+$/.test(existing) && /^\d+$/.test(next)) {
      // Overlap pages can produce one complete row and one row with a dropped
      // zero. Keep a populated numeric observation rather than allowing the
      // later partial OCR pass to erase a real contribution; do not replace a
      // non-zero value with an arbitrary larger OCR number.
      if (Number(existing) === 0 && Number(next) > 0) merged[field] = next;
    }
  }
  return merged;
}

function applyPageNameAliases(rows, aliases) {
  return rows.map((row) => {
    const canonicalName = aliases.get(memberProfileNameKey(row?.name));
    return canonicalName ? { ...row, name: canonicalName } : row;
  });
}

function contributionNameKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, "");
}

function reconcileMemberDetailRows(rows, expectedCount = null) {
  const reconciled = [];
  const hasTailMetadata = rows.some((row) =>
    Object.prototype.hasOwnProperty.call(row || {}, "__memberTail")
  );
  for (const row of rows) {
    const duplicateIndex = reconciled.findIndex(
      (existing) =>
        // Normal pages are guaranteed non-overlapping and must retain all
        // five candidates. Only a row from an expanded tail page may merge
        // with another candidate, which keeps legitimate look-alike names
        // from being discarded before the header-count cap is applied.
        (!hasTailMetadata ||
          existing.__memberTail === true ||
          row.__memberTail === true) &&
        sameMemberProfileIdentity(existing, row) &&
        similarMemberProfileName(existing.name, row.name)
    );
    if (duplicateIndex < 0) {
      reconciled.push(row);
      continue;
    }
    reconciled[duplicateIndex] = mergeMemberProfileRows(
      reconciled[duplicateIndex],
      row
    );
  }
  if (
    expectedCount !== null &&
    Number.isFinite(Number(expectedCount)) &&
    reconciled.length > Number(expectedCount)
  ) {
    const ranked = reconciled
      .map((row, index) => ({
        row,
        index,
        score: memberDetailQualityScore(row)
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.index - right.index
      )
      .slice(0, Number(expectedCount))
      .sort((left, right) => left.index - right.index);
    const capped = ranked.map(({ row }) => row);
    // Fuzzy OCR reconciliation must never turn an already complete raw
    // roster into an under-count. If a pair was merged too aggressively,
    // restore distinct raw candidates until the header count is satisfied;
    // exact duplicate keys were already removed by the page map.
    if (capped.length < Number(expectedCount) && rows.length >= Number(expectedCount)) {
      const restored = [...capped];
      const used = new Set(restored.map((row) => memberProfileNameKey(row.name)));
      for (const row of rows) {
        if (restored.length >= Number(expectedCount)) break;
        const key = memberProfileNameKey(row.name);
        if (!key || used.has(key)) continue;
        restored.push(row);
        used.add(key);
      }
      return restored.slice(0, Number(expectedCount));
    }
    return capped;
  }
  if (
    expectedCount !== null &&
    Number.isFinite(Number(expectedCount)) &&
    rows.length >= Number(expectedCount) &&
    reconciled.length < Number(expectedCount)
  ) {
    const restored = [...reconciled];
    const used = new Set(restored.map((row) => memberProfileNameKey(row.name)));
    for (const row of rows) {
      if (restored.length >= Number(expectedCount)) break;
      const key = memberProfileNameKey(row.name);
      if (!key || used.has(key)) continue;
      restored.push(row);
      used.add(key);
    }
    return restored.slice(0, Number(expectedCount));
  }
  return reconciled;
}

function memberDetailQualityScore(row) {
  const name = String(row?.name || "").trim();
  const fields = [
    "profession",
    "weeklyContribution",
    "manorLevel",
    "campTitle",
    "roommateName"
  ];
  const populatedFields = fields.filter((field) => {
    const value = row?.[field];
    return value !== null && value !== undefined && String(value).trim();
  }).length;
  return (isPlausibleMemberName(name) ? 100 : 0) + populatedFields * 2;
}

function hasSuspiciousMemberCollision(
  rows,
  byName,
  ignoredExistingKeys = new Set()
) {
  const pageRows = new Map();
  for (const row of rows) {
    const key = memberProfileNameKey(row.name);
    if (!key) continue;
    const samePage = pageRows.get(key);
    // A repeated name can mean that one row was merged into its neighbour or
    // that the native OCR returned the previous page's row twice. It needs
    // the same forced row-by-row reread as a conflicting duplicate.
    if (samePage) return true;
    pageRows.set(key, samePage || row);
    const existing = byName.get(key);
    if (
      existing &&
      !ignoredExistingKeys.has(key) &&
      memberProfileDataConflicts(existing, row)
    ) {
      return true;
    }
  }
  return false;
}

function pageNovelMemberCount(rows, byName) {
  const names = new Set(byName.keys());
  let added = 0;
  for (const row of rows) {
    const key = memberProfileNameKey(row.name);
    if (!key || names.has(key)) continue;
    names.add(key);
    added += 1;
  }
  return added;
}

function mergeMemberRecoveryCandidates(
  recoveredRows,
  originalRows,
  limit,
  existingMembers = null
) {
  const merged = [];
  const seen = new Set();
  const existing =
    existingMembers instanceof Map
      ? new Set(existingMembers.keys())
      : new Set(
          (existingMembers || [])
            .map((row) => memberProfileNameKey(row?.name || row))
            .filter(Boolean)
        );
  const add = (row) => {
    const key = memberProfileNameKey(row?.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(row);
  };
  // The tail can contain a sticky copy of the current player.  If the
  // advisor returns the missing row but lists already-known rows first,
  // adding recovered rows in source order can fill the limit before the
  // native-only candidates are considered.  Prefer candidates that are new
  // to the roster, then retain the strongest recovered/native row for any
  // remaining slots.
  const candidates = [...(recoveredRows || []), ...(originalRows || [])];
  candidates.sort((left, right) => {
    const leftNovel = existing.has(memberProfileNameKey(left?.name)) ? 0 : 1;
    const rightNovel = existing.has(memberProfileNameKey(right?.name)) ? 0 : 1;
    return rightNovel - leftNovel;
  });
  for (const row of candidates) {
    if (merged.length >= limit) break;
    add(row);
  }
  return merged.slice(0, limit);
}

function memberProfileNameKey(value) {
  const normalized = String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, "");
  // Decorative symbols are part of the in-game display name. Removing them
  // made distinct members such as "#愿✨" and "愿" collapse into one map
  // entry, which caused the page count to be lower than the header count.
  return normalized;
}

export function expectedMemberTailOverlapCount(expectedCount, rowsPerPage = 5) {
  const count = Math.max(0, Number.parseInt(expectedCount, 10) || 0);
  const pageRows = Math.max(1, Number.parseInt(rowsPerPage, 10) || 5);
  const remainder = count % pageRows;
  return remainder === 0 ? 0 : pageRows - remainder;
}

function memberProfileDataConflicts(left, right) {
  return [
    "profession",
    "weeklyContribution",
    "manorLevel",
    "campTitle",
    "roommateName"
  ].some((key) => {
    const leftValue = comparableMemberField(left?.[key]);
    const rightValue = comparableMemberField(right?.[key]);
    return leftValue && rightValue && leftValue !== rightValue;
  });
}

function comparableMemberField(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s,，]/g, "");
}

function mergeMemberProfileRows(current, incoming) {
  if (!Object.keys(current).length) return { ...incoming };
  const currentName = String(current.name || "");
  const incomingName = String(incoming.name || "");
  const preferredName =
    Array.from(incomingName).length > Array.from(currentName).length
      ? incomingName
      : currentName;
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && String(value).trim()) {
      merged[key] = value;
    }
  }
  merged.name = preferredName || incomingName;
  return merged;
}

function sameMemberProfileIdentity(left, right) {
  const fields = [
    "profession",
    "weeklyContribution",
    "manorLevel",
    "campTitle",
    "roommateName"
  ];
  const matched = fields.filter((field) => {
    const leftValue = comparableMemberField(left?.[field]);
    const rightValue = comparableMemberField(right?.[field]);
    return leftValue && rightValue && leftValue === rightValue;
  });
  const strongMatch = ["weeklyContribution", "roommateName"].some((field) => {
    const leftValue = comparableMemberField(left?.[field]);
    const rightValue = comparableMemberField(right?.[field]);
    return leftValue && rightValue && leftValue === rightValue;
  });
  return matched.length >= 2 && strongMatch;
}

function similarMemberProfileName(left, right) {
  const leftName = exactPageName(left);
  const rightName = exactPageName(right);
  if (!leftName || !rightName || leftName === rightName) return true;
  const leftLetters = leftName.match(/[\p{L}\p{N}]+/gu)?.join("") || "";
  const rightLetters = rightName.match(/[\p{L}\p{N}]+/gu)?.join("") || "";
  // Keep intentional display-name decorations as distinct members.
  if (!leftLetters || leftLetters === rightLetters) return false;
  // Equal-length names that differ by one Han character are valid distinct
  // players far more often than they are OCR suffix variants (for example
  // “天-行” and “天-者”). Never merge those names only because the profile
  // fields happen to be identical on the same page.
  if (Array.from(leftLetters).length === Array.from(rightLetters).length) {
    return false;
  }
  const minimumLength = Math.min(
    Array.from(leftLetters).length,
    Array.from(rightLetters).length
  );
  const maximumDistance = minimumLength >= 8 ? 2 : 1;
  const shorter = leftLetters.length <= rightLetters.length ? leftLetters : rightLetters;
  const longer = leftLetters.length <= rightLetters.length ? rightLetters : leftLetters;
  return (
    longer.startsWith(shorter) &&
    memberNameDistance(leftLetters, rightLetters) <= maximumDistance
  );
}

function memberNameDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current.push(
        Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] +
            (left[row - 1] === right[column - 1] ? 0 : 1)
        )
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function selectActivityWarningRows(rows, minimumInactiveDays) {
  const minimum = Math.max(1, Number(minimumInactiveDays) || 1);
  const inspected = rows.map((row) => ({
    row,
    normalized: normalizeActivity([row])[0] || null
  }));
  return {
    rows: inspected
      .filter(
        ({ normalized }) =>
          Number.isFinite(normalized?.inactiveDays) &&
          normalized.inactiveDays >= minimum
      )
      .map(({ row }) => row),
    reachedBoundary: inspected.some(
      ({ normalized }) =>
        Number.isFinite(normalized?.inactiveDays) &&
        normalized.inactiveDays < minimum
    )
  };
}

export function mergeActivityRecoveryRows(primaryRows, recoveredRows) {
  const merged = [];
  const seen = new Set();
  for (const row of [...(primaryRows || []), ...(recoveredRows || [])]) {
    const name = String(row?.name || "")
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/g, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    merged.push(row);
  }
  return merged;
}

export function reconcilePageRows(previousRows, currentRows) {
  if (previousRows.length < 3 || currentRows.length < 3) return currentRows;
  const previousBoundary = previousRows.at(-1);
  const currentBoundary = currentRows[0];
  if (
    sameMemberProfileIdentity(previousBoundary, currentBoundary) ||
    sameExactNonEmpty(
      previousBoundary.roommateName,
      currentBoundary.roommateName
    )
  ) {
    currentRows = [
      { ...currentBoundary, name: previousBoundary.name },
      ...currentRows.slice(1)
    ];
  }
  let best = null;
  for (let offset = 1; offset < previousRows.length; offset += 1) {
    const overlap = Math.min(
      previousRows.length - offset,
      currentRows.length
    );
    if (overlap < 2) continue;
    let exactMatches = 0;
    for (let index = 0; index < overlap; index += 1) {
      if (samePageMember(previousRows[offset + index], currentRows[index])) {
        exactMatches += 1;
      }
    }
    const candidate = {
      offset,
      overlap,
      exactMatches,
      ratio: exactMatches / overlap
    };
    if (
      !best ||
      candidate.ratio > best.ratio ||
      (
        candidate.ratio === best.ratio &&
        candidate.exactMatches > best.exactMatches
      ) ||
      (
        candidate.ratio === best.ratio &&
        candidate.exactMatches === best.exactMatches &&
        candidate.overlap < best.overlap
      )
    ) {
      best = candidate;
    }
  }
  if (!best || best.exactMatches < 3 || best.ratio < 0.75) {
    return currentRows;
  }
  return currentRows.map((row, index) => {
    if (index >= best.overlap) return row;
    const previous = previousRows[best.offset + index];
    return samePageMember(previous, row)
      ? row
      : { ...row, name: previous.name };
  });
}

function samePageMember(left, right) {
  return (
    exactPageName(left?.name) === exactPageName(right?.name) ||
    sameMemberProfileIdentity(left, right)
  );
}

function exactPageName(value) {
  return String(value || "").trim().normalize("NFKC").toLowerCase();
}

function sameExactNonEmpty(left, right) {
  const leftValue = exactPageName(left);
  const rightValue = exactPageName(right);
  return Boolean(leftValue) && leftValue === rightValue;
}
