import {
  normalizeActivity,
  normalizeContribution,
  normalizeMembers,
  normalizeProfiles,
  normalizeStaffGrid,
  parseTable
} from "../table-parser.mjs";
import { isPlausibleMemberName } from "../member-name.mjs";
import { delay } from "../process.mjs";
import {
  progressForRange,
  progressRangeSlice,
  updateWorkflowProgress
} from "./progress.mjs";

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
  const { details, staff } = await captureProfilesAndStaff(context, signal, {
    progressRange: { start: 0.56, end: 0.82, step: "member_profile_scan" }
  });
  await updateWorkflowProgress(context, 0.86, "member_profile_complete");
  const members = normalizeMembers(
    alignContributionRowsToRoster(contribution, details),
    details,
    activity
  );
  if (!members.length) throw new Error("No member rows recognized; snapshot was not uploaded");
  await updateWorkflowProgress(context, 0.91, "member_snapshot");
  await context.api.snapshot(
    command.runId,
    "members",
    members,
    new Date().toISOString(),
    signal
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
    `已用最新完整名单替换当前列表：${members.length} 名成员、${staffCount} 项公职`
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
  await updateWorkflowProgress(context, 0.04, "contribution_prepare");
  const rawRows = await captureContribution(context, signal, {
    expectedCount: expectedMemberCount,
    progressRange: { start: 0.08, end: 0.72, step: "contribution_scan" }
  });
  const alignedRows = alignContributionRowsToRoster(rawRows, memberRoster);
  const rows = normalizeContribution(alignedRows);
  const locallyFiltered = Math.max(0, rawRows.length - rows.length);
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
  const incomplete = matched < expectedMemberCount;
  await updateWorkflowProgress(context, 0.97, "contribution_complete");
  await context.report(
    ignored || locallyFiltered || incomplete ? "warning" : "info",
    "contribution_done",
    `贡献页识别 ${rawRows.length} 行，OCR 清洗后保留 ${rows.length} 行；按成员资料主名单 ${expectedMemberCount} 名成员去重匹配，最终更新 ${matched} 名，忽略 ${ignored + locallyFiltered} 行；不会新增成员`,
    {
      recognized: rawRows.length,
      normalized: rows.length,
      locallyFiltered,
      expectedMemberCount,
      matched,
      ignored: ignored + locallyFiltered,
      ambiguous: Number(result?.ambiguous) || 0,
      incomplete
    }
  );
}

export async function runInactivitySync(context, command, bundle, signal) {
  const minimumInactiveDays = Math.max(
    1,
    Number(bundle?.campConfig?.inactivityWarningDays) || 1
  );
  await updateWorkflowProgress(context, 0.04, "activity_prepare");
  const scanOptions = { minimumInactiveDays };
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
    `斩杀页识别 ${rows.length} 行，自身去重后更新 ${matched} 条离线达到 ${minimumInactiveDays} 天的独立预警，忽略 ${ignored} 条重复数据；不会写入或关联成员名单`,
    {
      recognized: rows.length,
      matched,
      ignored,
      ambiguous
    }
  );
}

export async function runMemberProfileSync(context, command, _bundle, signal) {
  await updateWorkflowProgress(context, 0.04, "member_profile_prepare");
  const { details, staff, expectedMembers } = await captureProfilesAndStaff(
    context,
    signal,
    { progressRange: { start: 0.10, end: 0.78, step: "member_profile_scan" } }
  );
  await updateWorkflowProgress(context, 0.84, "member_profile_validate");
  const profiles = normalizeProfiles(details);
  if (!profiles.length) throw new Error("No profile rows recognized");
  if (profiles.length !== expectedMembers) {
    throw new Error(
      `MEMBER_PROFILE_COUNT_MISMATCH: normalized ${profiles.length}, page header reports ${expectedMembers}; profile snapshot was not uploaded`
    );
  }
  await context.api.snapshot(
    command.runId,
    "profiles",
    profiles,
    new Date().toISOString(),
    signal
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
    `已更新 ${profiles.length} 名成员资料和 ${staffCount} 项最新公职；贡献数值由“更新贡献”任务单独更新`
  );
}

export async function captureContribution(context, signal, options = {}) {
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
      expectedCount: options.expectedCount,
      progressRange: scanProgressRange
    }
  );
  const minimumRows = Math.max(
    1,
    Number(options.expectedCount) ||
      contributionMinimum(context.config.tables.contribution)
  );
  if (rows.length < minimumRows) {
    await context.report(
      "warning",
      "contribution_empty_retry",
      `贡献表首次仅识别 ${rows.length}/${minimumRows} 名成员，点击左下角返回并重新进入贡献页；不关闭游戏或容器`
    );
    await context.ui.tap({ x: 80, y: 1080 }, signal);
    await context.ui.executeFlow("openContribution", {}, signal);
    await settleTableBeforeFirstScan(context, "contribution-retry", signal);
    rows = await capturePagedTable(
      context,
      "member-contribution-retry",
      context.config.tables.contribution,
      signal,
      {
        expectedCount: options.expectedCount,
        progressRange: scanProgressRange
      }
    );
  }
  return rows;
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
  const expectedMembers = await context.vision.readMemberExpectedTotal(signal);
  const scanProgressRange = progressRangeSlice(options.progressRange, 0.1);
  const scanMemberDetails = () =>
    capturePagedTable(
      context,
      "member-details",
      context.config.tables.members,
      signal,
      {
        expectedCount: expectedMembers,
        progressRange: scanProgressRange
      }
    );
  let details = await scanMemberDetails();
  if (details.length < expectedMembers) {
    await context.report(
      "warning",
      "member_details_count_retry",
      `成员资料首次扫描识别 ${details.length}/${expectedMembers} 名，先通过顶部“首页”返回列表起点，再进入“成员”页完整重扫一次，避免末页 OCR 漏行`
    );
    await context.ui.executeFlow("resetMemberPanelForRescan", {}, signal);
    details = await scanMemberDetails();
  }
  if (details.length !== expectedMembers) {
    throw new Error(
      `MEMBER_PROFILE_COUNT_MISMATCH: recognized ${details.length}, page header reports ${expectedMembers}`
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
  staff = dedupeStaffAssignments(staff);
  if (!staff.length) throw new Error("No staff rows recognized; snapshot was not uploaded");
  if (staff.length > 11) {
    throw new Error(
      `STAFF_COUNT_INVALID: recognized ${staff.length}, maximum is mayor 1 + staff 10`
    );
  }
  return { details, staff, expectedMembers };
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
  const memberDetailsMode = label === "member-details";
  const contributionTableMode = label.startsWith("member-contribution");
  let stagnantPages = 0;
  let previousFingerprint = "";
  let previousRows = [];
  const pageNameAliases = new Map();
  let scannedPages = 0;
  let tailFullPagePending = false;
  let tailFullPageReason = null;
  const memberPageRetries = new Map();
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
  const maxMemberPageRetries = Math.max(
    1,
    Number(definition.pagination.maxIncompletePageRetries) || 3
  );
  const expectedPageCount =
    memberDetailsMode && expectedCount !== null
      ? Math.max(1, Math.ceil(expectedCount / memberRowsPerPage))
      : null;
  const maxMemberPageCount =
    expectedPageCount === null
      ? null
      : expectedPageCount + Math.max(
          0,
          Number(definition.pagination.maxExtraPagesAfterExpected) || 2
        );
  for (let page = 0; page < definition.pagination.maxPages; ) {
    memberPageHadExactCollision = false;
    scannedPages = page + 1;
    const scheduledLastPage =
      memberDetailsMode &&
      expectedPageCount !== null &&
      page + 1 === expectedPageCount;
    // Once the calculated last page is incomplete, the two permitted
    // continuation pages are tail pages too.  They must use the expanded
    // full-page crop as-is; applying the normal five-row alignment pass here
    // can shift the first row and create an artificial partial/duplicate row.
    const scheduledLastContinuationPage =
      memberDetailsMode &&
      expectedPageCount !== null &&
      page + 1 > expectedPageCount &&
      page + 1 <= maxMemberPageCount;
    const fullPageRead =
      hasFullPageDefinition &&
      (tailFullPagePending || scheduledLastPage || scheduledLastContinuationPage);
    const currentTailReason =
      tailFullPageReason ||
      (scheduledLastPage
        ? "scheduled-last"
        : scheduledLastContinuationPage
          ? "scheduled-last-continuation"
          : null);
    const pageDefinition = fullPageRead
      ? memberFullPageDefinition(definition)
      : definition;
    tailFullPagePending = false;
    tailFullPageReason = null;
    const pageStartedAt = Date.now();
    let frame;
    let rows = [];
    let preparedFrame = null;
    if (memberDetailsMode && page > 0 && !fullPageRead) {
      preparedFrame = await alignMemberDetailsPage(
        context,
        `${label}-${page + 1}`,
        pageDefinition,
        page,
        signal
      );
    }
    const minimumRowsPerPage = Math.max(
      1,
      Number(definition.pagination.minimumRowsPerPage) || 1
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
        ? parseTable(attemptFrame.observations, pageDefinition).filter(
            (row) =>
              row.name &&
              !pageDefinition.headerPattern.some((value) => row.name.includes(value))
          )
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
        attemptRows.some((row) =>
          [
            "weeklyContribution",
            "technologyPointsUsed",
            "materialContribution"
          ].some((field) => !/\d/.test(String(row[field] || "")))
        );
      if (
        (!attemptRows.length ||
          (definition.extractionMode === "hybrid" &&
            attemptRows.length < minimumRowsPerPage) ||
          contributionNeedsRecovery) &&
        typeof vision.extractTableRows === "function"
      ) {
          const recoveredRows = await vision.extractTableRows(
            attemptFrame.path,
            pageDefinition,
            attemptLabel,
            signal
        ).catch(async (error) => {
          await report(
            "warning",
            `${label}_ai_ocr_failed`,
            `第 ${page + 1} 页 AI 表格识别失败，保留当前界面并继续重试`,
            { reason: error.message }
          );
          return [];
        });
        attemptRows = mergeContributionRows(attemptRows, recoveredRows);
        if (memberDetailsMode) {
          attemptRows = filterMemberDetailRows(attemptRows);
          if (!fullPageRead) {
            const visibleRows = Number(definition.pagination.rowsPerPage) || 5;
            attemptRows = attemptRows.slice(0, Math.max(1, visibleRows));
          }
        }
      }
      if (!frame || attemptRows.length > rows.length) {
        frame = attemptFrame;
        rows = attemptRows;
      }
      if (rows.length >= minimumRowsPerPage || readAttempt === 3) break;
      await report(
        "warning",
        `${label}_empty_page_retry`,
        `第 ${page + 1} 页仅识别 ${rows.length}/${minimumRowsPerPage} 行，保持当前位置原地重读`
      );
      await ui.afterAction(signal);
    }
    rows = rows.filter(
      (row) =>
        row.name &&
        !pageDefinition.headerPattern.some((value) => row.name.includes(value))
    );
    if (memberDetailsMode) {
      // Normal pages are deliberately non-overlapping five-row windows. Do
      // not run cross-page aliasing/reconciliation on them: a visually valid
      // row whose OCR name resembles a previous row must remain a candidate.
      // Only the calculated tail and its continuation pages are allowed to
      // reconcile OCR variants because those pages are read as one expanded
      // end-page crop and may legitimately contain a repeated final row.
      const rawRows = filterMemberDetailRows(rows);
      memberPageHadExactCollision = hasSuspiciousMemberCollision(
        rawRows,
        byName
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
    }
    const memberPageNovelty = memberDetailsMode
      ? pageNovelMemberCount(rows, byName)
      : null;
    const shouldRecoverMemberPage =
      memberDetailsMode &&
      frame?.path &&
      (rows.length < minimumRowsPerPage ||
        memberPageHadExactCollision ||
        hasSuspiciousMemberCollision(rows, byName) ||
        (fullPageRead &&
          memberPageNovelty < rows.length &&
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
    if (memberDetailsMode && !fullPageRead && rows.length < memberRowsPerPage) {
      const retryCount = (memberPageRetries.get(page) || 0) + 1;
      if (retryCount <= maxMemberPageRetries) {
        memberPageRetries.set(page, retryCount);
        await report(
          "warning",
          "member_details_page_incomplete_retry",
          `第 ${page + 1} 页只确认 ${rows.length}/${memberRowsPerPage} 行，保持当前位置重读，不推进到下一页（第 ${retryCount}/${maxMemberPageRetries} 次）`,
          { page: page + 1, recognizedRows: rows.length, expectedRows: memberRowsPerPage }
        );
        continue;
      }
      if (hasFullPageDefinition) {
        // A normal five-row crop may hide the final partial row. Re-read the
        // same position with the expanded tail crop before deciding that this
        // is the last page; do not swipe away from an incomplete page.
        tailFullPagePending = true;
        tailFullPageReason = "incomplete";
        memberPageRetries.delete(page);
        continue;
      }
      throw new Error(
        `MEMBER_DETAILS_PAGE_INCOMPLETE: page ${page + 1} recognized ${rows.length}/${memberRowsPerPage} rows`
      );
    }
    memberPageRetries.delete(page);
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
    for (const row of rows) {
      const baseRowKey = memberDetailsMode
        ? memberProfileNameKey(row.name)
        : row.name;
      const rowKey = baseRowKey;
      if (!rowKey) continue;
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
    const elapsedMs = Date.now() - pageStartedAt;
    await report(
      "info",
      `${label}_page`,
      `第 ${page + 1} 页识别 ${rows.length} 行，累计 ${byName.size} 名成员（耗时 ${elapsedMs}ms）`,
      {
        screenshot: frame.path,
        expectedCount,
        rejectedAfterExpectedCount,
        elapsedMs
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
    const organizedMemberCount =
      memberDetailsMode && expectedCount !== null
        ? reconcileMemberDetailRows([...byName.values()], expectedCount).length
        : null;
    const scheduledTailPage =
      currentTailReason === "scheduled-last" ||
      currentTailReason === "scheduled-last-continuation";
    const scheduledLastNeedsContinuation =
      memberDetailsMode &&
      scheduledTailPage &&
      expectedCount !== null &&
      organizedMemberCount < expectedCount &&
      page + 1 < maxMemberPageCount;
    if (
      memberDetailsMode &&
      fullPageRead &&
      (currentTailReason === "stagnant" ||
        (currentTailReason === "incomplete" && rows.length < memberRowsPerPage) ||
        (scheduledTailPage && !scheduledLastNeedsContinuation))
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
          scheduledLastNeedsContinuation
        }
      );
      break;
    }
    if (scheduledLastNeedsContinuation) {
      await report(
        "warning",
        "member_details_expected_page_incomplete",
        `预计末页第 ${expectedPageCount} 页整理出 ${organizedMemberCount}/${expectedCount} 名，继续向下补读（最多到第 ${maxMemberPageCount} 页）`,
        {
          page: page + 1,
          expectedPageCount,
          maxMemberPageCount,
          organizedMemberCount,
          expectedCount
        }
      );
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
      !contributionTableMode &&
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
      !scheduledLastNeedsContinuation &&
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
      maxMemberPageCount !== null &&
      page + 1 >= maxMemberPageCount;
    if (memberPageLimitReached || page + 1 >= definition.pagination.maxPages) {
      await report(
        "info",
        `${label}_page_limit_reached`,
        memberPageLimitReached
          ? `已达到顶部人数计算末页 ${expectedPageCount} 页后的最多补读 ${maxMemberPageCount - expectedPageCount} 页（上限第 ${maxMemberPageCount} 页），不再继续翻页`
          : `已扫描配置上限 ${definition.pagination.maxPages} 页，不再继续翻页`,
        { expectedPageCount, maxMemberPageCount }
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
    if (memberDetailsMode) {
      // MuMu accelerates a single long mouse swipe near the endpoint. That
      // can jump past one or more 95px rows. Send the same calibrated drag as
      // small MOVE segments and release immediately at the exact 475px
      // (5-row) endpoint so the next page starts on a row boundary. The
      // calibrated duration is shortened by 30% to increase speed without
      // changing either endpoint or the segmented path.
      await memberAlignmentSwipe(
        adb,
        swipeFrom,
        swipeTo,
        Math.max(
          100,
          Math.round((Number(definition.pagination.durationMs) || 1_000) * 0.7)
        ),
        signal
      );
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
      ? Math.max(3_000, Number(definition.pagination.settleAfterSwipeMs) || 3_000)
      : Math.max(0, Number(definition.pagination.settleAfterSwipeMs) || 0);
    if (settleAfterSwipeMs > 0) {
      await (context.sleep || delay)(settleAfterSwipeMs, signal);
    } else {
      await ui.afterAction(signal);
    }
    page += 1;
  }
  const rows = [...byName.values()];
  if (memberDetailsMode) {
    const reconciled = reconcileMemberDetailRows(rows, expectedCount);
    await report(
      "info",
      "member_details_bottom_reached",
      expectedCount !== null
        ? `成员资料列表已完整翻到底部，扫描 ${scannedPages} 页；全表去重合并后整理为 ${reconciled.length}/${expectedCount} 名成员`
        : `成员资料列表已完整翻到底部，扫描 ${scannedPages} 页；整理结果为 ${reconciled.length} 名成员`,
      {
        pages: scannedPages,
        scannedRows: rows.length,
        reconciledRows: reconciled.length,
        expectedCount,
        stoppedAtExpectedCount: false
      }
    );
    return reconciled;
  }
  return rows;
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
    await memberAlignmentSwipe(
      adb,
      { x: adjustment.x, y: adjustment.anchorY },
      {
        x: adjustment.x,
        y:
          adjustment.direction === "up"
            ? adjustment.anchorY - adjustment.distance
            : adjustment.anchorY + adjustment.distance
      },
      Math.max(
        100,
        Math.round((Number(pagination.rowAlignmentDurationMs) || 1_000) * 0.7)
      ),
      signal
    );
    await (context.sleep || delay)(
      Math.max(500, Number(pagination.rowAlignmentSettleMs) || 1_000),
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
    return;
  }
  const distance = Math.abs(Number(to.y) - Number(from.y));
  const steps = Math.max(2, Math.ceil(distance / 10));
  const intervalMs = Math.max(80, Math.round(durationMs / steps));
  const shellMotion = async (action, y) => {
    await adb.shell(
      ["input", "mouse", "motionevent", action, Math.round(from.x), Math.round(y)],
      { signal, timeoutMs: 5_000 }
    );
  };
  await shellMotion("DOWN", from.y);
  for (let step = 1; step <= steps; step += 1) {
    await (delay)(intervalMs, signal);
    const progress = step / steps;
    await shellMotion("MOVE", from.y + (to.y - from.y) * progress);
  }
  await (delay)(intervalMs, signal);
  await shellMotion("UP", to.y);
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

function memberRowAlignmentAdjustment(bands, region, page, pagination) {
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
  const fullPageRegion = definition.pagination?.fullPageRegion;
  if (!fullPageRegion) return definition;
  return {
    ...definition,
    region: { ...fullPageRegion },
    pagination: {
      ...definition.pagination,
      // The tail crop begins immediately below the black member-count bar.
      // Its first visible band is the lower half of the previous row; it is
      // never a new member and must be discarded before taking the five full
      // rows that follow it.
      skipLeadingPartialRows: true,
      // `fullPageRows` is the maximum number of rows returned from the
      // expanded crop; keep the calibrated row spacing/count for anchor
      // inference so a missing online-state OCR token is not redistributed
      // across the larger crop.
      rowsPerPage: Number(definition.pagination.rowsPerPage) || 1
    }
  };
}

function isMemberAvatarArtifact(value) {
  const text = String(value || "")
    .trim()
    .normalize("NFKC")
    .replace(/\s+/g, "");
  // The avatar artwork carries a printed 2025/20251-style year marker.  It
  // is outside the identity column in the calibrated crop, but this guard is
  // also required for legacy/plugin OCR providers that still return it.
  return /^2025\d*$/u.test(text);
}

function filterMemberDetailRows(rows) {
  return (rows || []).filter(
    (row) => row?.name && !isMemberAvatarArtifact(row.name)
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
      if (!String(merged[field] || "").trim() && String(fallback[field] || "").trim()) {
        merged[field] = fallback[field];
      }
    }
    return merged;
  });
  return recovered.length > merged.length
    ? [...merged, ...recovered.slice(merged.length)]
    : merged;
}

export function alignContributionRowsToRoster(rows, roster) {
  const members = (roster || [])
    .map((item) => ({
      name: String(item?.name || "").trim(),
      key: contributionNameKey(item?.name)
    }))
    .filter((item) => item.name && item.key);
  const byCanonicalName = new Map();
  for (const row of rows || []) {
    const sourceKey = contributionNameKey(row?.name);
    if (!sourceKey) continue;
    const exact = members.filter((member) => member.key === sourceKey);
    let matched = exact.length === 1 ? exact[0] : null;
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
    // Contribution data is subordinate to the profile roster. An OCR-only
    // name must never create a new member or reach the server as a candidate.
    if (!matched) continue;
    const canonicalRow = { ...row, name: matched.name };
    const canonicalKey = contributionNameKey(matched.name);
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

function hasSuspiciousMemberCollision(rows, byName) {
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
    if (existing && memberProfileDataConflicts(existing, row)) {
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
