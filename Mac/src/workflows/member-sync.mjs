import {
  normalizeActivity,
  normalizeContribution,
  normalizeMembers,
  normalizeProfiles,
  normalizeStaffGrid,
  parseTable
} from "../table-parser.mjs";
import { delay } from "../process.mjs";

export async function runMemberSync(context, command, _bundle, signal) {
  const contribution = await captureContribution(context, signal);
  await context.progress(0.3, "contribution");
  const activity = await captureActivity(context, false, signal);
  await context.progress(0.5, "activity");
  await context.ui.executeFlow("closeContribution", {}, signal);
  const { details, staff } = await captureProfilesAndStaff(context, signal);
  const members = normalizeMembers(contribution, details, activity);
  if (!members.length) throw new Error("No member rows recognized; snapshot was not uploaded");
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
  await context.report(
    "info",
    "member_sync_done",
    `已用最新完整名单替换当前列表：${members.length} 名成员、${staffCount} 项公职`
  );
}

export async function runContributionSync(context, command, _bundle, signal) {
  const rows = normalizeContribution(await captureContribution(context, signal));
  assertContributionComplete(rows, context.config.tables.contribution);
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
      "CONTRIBUTION_MASTER_LIST_MISSING: 贡献数据未能匹配成员资料主名单，请先执行“更新成员资料”"
    );
  }
  await context.report(
    ignored ? "warning" : "info",
    "contribution_done",
    `贡献页识别 ${rows.length} 行，已匹配更新 ${matched} 名成员，忽略 ${ignored} 行未确认 OCR 数据；成员总数未改变`,
    {
      recognized: rows.length,
      matched,
      ignored,
      ambiguous: Number(result?.ambiguous) || 0
    }
  );
}

export async function runInactivitySync(context, command, bundle, signal) {
  const minimumInactiveDays = Math.max(
    1,
    Number(bundle?.campConfig?.inactivityWarningDays) || 1
  );
  const scanOptions = { minimumInactiveDays };
  const rows = normalizeActivity(
    await captureActivity(context, true, signal, scanOptions)
  );
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
  const { details, staff } = await captureProfilesAndStaff(context, signal);
  const profiles = normalizeProfiles(details);
  if (!profiles.length) throw new Error("No profile rows recognized");
  await context.api.snapshot(
    command.runId,
    "profiles",
    profiles,
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
  await context.report(
    "info",
    "profiles_done",
    `已更新 ${profiles.length} 名成员资料（含周贡献交叉比对值）和 ${staffCount} 项最新公职`
  );
}

export async function captureContribution(context, signal) {
  await context.ui.executeFlow("teleportCityHall", {}, signal);
  await context.ui.executeFlow("navigateToSandTable", {}, signal);
  await context.ui.executeFlow("openContribution", {}, signal);
  await settleTableBeforeFirstScan(context, "contribution", signal);
  let rows = await capturePagedTable(
    context,
    "member-contribution",
    context.config.tables.contribution,
    signal
  );
  const minimumRows = contributionMinimum(context.config.tables.contribution);
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
      signal
    );
  }
  return rows;
}

export function assertContributionComplete(rows, definition) {
  const minimumRows = contributionMinimum(definition);
  if (rows.length < minimumRows) {
    throw new Error(
      `CONTRIBUTION_INCOMPLETE: recognized ${rows.length}/${minimumRows} required unique member rows`
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
    await context.ui.executeFlow("teleportCityHall", {}, signal);
    await context.ui.executeFlow("navigateToSandTable", {}, signal);
  }
  await context.ui.executeFlow(
    startFromWorld ? "openActivity" : "openActivityFromMember",
    {},
    signal
  );
  await settleTableBeforeFirstScan(context, "activity", signal);
  await ensureActivityDescending(context, signal);
  return capturePagedTable(
    context,
    "member-activity",
    context.config.tables.activity,
    signal,
    options
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

export async function captureProfilesAndStaff(context, signal) {
  await context.ui.executeFlow("openCampPanel", {}, signal);
  await context.ui.executeFlow("openMemberPanel", {}, signal);
  const expectedMembers = await context.vision.readMemberExpectedTotal(signal);
  const details = await capturePagedTable(
    context,
    "member-details",
    context.config.tables.members,
    signal,
    { expectedCount: expectedMembers }
  );
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
  return { details, staff };
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
  let stagnantPages = 0;
  let previousFingerprint = "";
  let previousRows = [];
  const expectedCount = Number.isFinite(Number(options.expectedCount))
    ? Math.max(1, Number(options.expectedCount))
    : null;
  for (let page = 0; page < definition.pagination.maxPages; page += 1) {
    const pageStartedAt = Date.now();
    let frame;
    let rows = [];
    const minimumRowsPerPage = Math.max(
      1,
      Number(definition.pagination.minimumRowsPerPage) || 1
    );
    for (let readAttempt = 1; readAttempt <= 3; readAttempt += 1) {
      const attemptLabel =
        readAttempt === 1
          ? `${label}-${page + 1}`
          : `${label}-${page + 1}-retry-${readAttempt}`;
      const attemptFrame = await captureTableFrame(
        context,
        attemptLabel,
        definition,
        signal
      );
      // The fast native parser is only available for definitions carrying
      // calibrated regions/columns. Test doubles and plugin-defined tables
      // may intentionally provide capture observations without that layout;
      // let those tables use the existing extractor fallback instead of
      // throwing while reading an undefined region.
      const canParseNative =
        Array.isArray(attemptFrame.observations) &&
        definition.region &&
        Array.isArray(definition.columns);
      let attemptRows = canParseNative
        ? parseTable(attemptFrame.observations, definition).filter(
            (row) =>
              row.name &&
              !definition.headerPattern.some((value) => row.name.includes(value))
          )
        : [];
      if (
        (!attemptRows.length ||
          (definition.extractionMode === "hybrid" &&
            attemptRows.length < minimumRowsPerPage)) &&
        typeof vision.extractTableRows === "function"
      ) {
        attemptRows = await vision.extractTableRows(
          attemptFrame.path,
          definition,
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
        !definition.headerPattern.some((value) => row.name.includes(value))
    );
    if (!memberDetailsMode) {
      rows = reconcilePageRows(previousRows, rows);
    }
    if (
      memberDetailsMode &&
      frame?.path &&
      hasSuspiciousMemberCollision(rows, byName)
    ) {
      const recoveredRows = await vision.extractTableRows(
        frame.path,
        definition,
        `${label}-${page + 1}-duplicate-recovery`,
        signal,
        { forceMemberAdvisor: true }
      ).catch(async (error) => {
        await report(
          "warning",
          "member_details_duplicate_recovery_failed",
          `第 ${page + 1} 页发现疑似姓名 OCR 合并，但模型强化重读失败`,
          { reason: error.message }
        );
        return [];
      });
      const reconciledRecovery = recoveredRows.filter(
        (row) =>
          row.name &&
          !definition.headerPattern.some((value) =>
            row.name.includes(value)
          )
      );
      const originalNovelty = pageNovelMemberCount(rows, byName);
      const recoveredNovelty = pageNovelMemberCount(
        reconciledRecovery,
        byName
      );
      if (
        reconciledRecovery.length >= rows.length &&
        recoveredNovelty > originalNovelty
      ) {
        await report(
          "info",
          "member_details_duplicate_recovered",
          `第 ${page + 1} 页强化重读已从疑似重名/特殊字符 OCR 合并中恢复 ${recoveredNovelty - originalNovelty} 名成员`,
          {
            beforeNames: rows.map((row) => row.name),
            recoveredNames: reconciledRecovery.map((row) => row.name)
          }
        );
        rows = reconciledRecovery;
      } else {
        await report(
          "warning",
          "member_details_duplicate_unresolved",
          `第 ${page + 1} 页存在疑似重名或特殊字符姓名，强化重读未能安全增加唯一成员`,
          {
            names: rows.map((row) => row.name),
            recoveredNames: reconciledRecovery.map((row) => row.name)
          }
        );
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
    for (const row of rows) {
      const rowKey = memberDetailsMode
        ? memberProfileNameKey(row.name)
        : row.name;
      if (!rowKey) continue;
      const current = byName.get(rowKey) || {};
      if (
        !byName.has(rowKey) &&
        expectedCount !== null &&
        byName.size >= expectedCount
      ) {
        rejectedAfterExpectedCount += 1;
        continue;
      }
      if (!byName.has(rowKey)) added += 1;
      byName.set(
        rowKey,
        memberDetailsMode
          ? mergeMemberProfileRows(current, row)
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
    if (expectedCount !== null && byName.size >= expectedCount) {
      await report(
        "info",
        `${label}_expected_count_reached`,
        `已达到页面顶部报告的 ${expectedCount} 名成员，立即停止翻页；末页 OCR 变体不得继续新增成员`,
        {
          expectedCount,
          recognized: byName.size,
          page: page + 1,
          rejectedAfterExpectedCount
        }
      );
      break;
    }
    stagnantPages =
      added === 0 || fingerprint === previousFingerprint ? stagnantPages + 1 : 0;
    if (stagnantPages >= definition.pagination.stopAfterStagnantPages) break;
    previousFingerprint = fingerprint;
    previousRows = rows.map((row) => ({ ...row }));
    if (page + 1 >= definition.pagination.maxPages) {
      await report(
        "info",
        `${label}_page_limit_reached`,
        `已扫描配置上限 ${definition.pagination.maxPages} 页，不再继续翻页`
      );
      break;
    }
    await adb.mouseSwipe(
      definition.pagination.from,
      definition.pagination.to,
      definition.pagination.durationMs,
      signal
    );
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
  }
  return [...byName.values()];
}

function hasSuspiciousMemberCollision(rows, byName) {
  const pageRows = new Map();
  for (const row of rows) {
    const key = memberProfileNameKey(row.name);
    if (!key) continue;
    const samePage = pageRows.get(key);
    if (samePage && memberProfileDataConflicts(samePage, row)) return true;
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

function memberProfileNameKey(value) {
  const normalized = String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, "");
  return normalized.replace(/[^\p{L}\p{N}]/gu, "") || normalized;
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
    exactPageName(previousBoundary.name) !==
      exactPageName(currentBoundary.name) &&
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
      if (
        exactPageName(previousRows[offset + index].name) ===
        exactPageName(currentRows[index].name)
      ) {
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
    return exactPageName(previous.name) === exactPageName(row.name)
      ? row
      : { ...row, name: previous.name };
  });
}

function exactPageName(value) {
  return String(value || "").trim().normalize("NFKC").toLowerCase();
}

function sameExactNonEmpty(left, right) {
  const leftValue = exactPageName(left);
  const rightValue = exactPageName(right);
  return Boolean(leftValue) && leftValue === rightValue;
}
