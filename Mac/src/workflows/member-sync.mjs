import {
  normalizeActivity,
  normalizeContribution,
  normalizeMembers,
  normalizeProfiles,
  normalizeStaffGrid,
  parseTable
} from "../table-parser.mjs";

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
  await context.api.snapshot(
    command.runId,
    "staff",
    staff,
    new Date().toISOString(),
    signal
  );
  await context.report(
    "info",
    "member_sync_done",
    `已用最新完整名单替换当前列表：${members.length} 名成员、${staff.length} 项公职`
  );
}

export async function runContributionSync(context, command, _bundle, signal) {
  const rows = normalizeContribution(await captureContribution(context, signal));
  assertContributionComplete(rows, context.config.tables.contribution);
  await context.api.snapshot(
    command.runId,
    "contribution",
    rows,
    new Date().toISOString(),
    signal
  );
  await context.report("info", "contribution_done", `已更新 ${rows.length} 名成员贡献`);
}

export async function runInactivitySync(context, command, bundle, signal) {
  const minimumInactiveDays = Math.max(
    1,
    Number(bundle?.campConfig?.inactivityWarningDays) || 1
  );
  const rows = normalizeActivity(
    await captureActivity(context, true, signal, { minimumInactiveDays })
  );
  await context.api.snapshot(
    command.runId,
    "activity",
    rows,
    new Date().toISOString(),
    signal
  );
  await context.report(
    "info",
    "activity_done",
    `已更新 ${rows.length} 名离线达到 ${minimumInactiveDays} 天的斩杀预警成员`
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
  await context.api.snapshot(
    command.runId,
    "staff",
    staff,
    new Date().toISOString(),
    signal
  );
  await context.report(
    "info",
    "profiles_done",
    `已更新 ${profiles.length} 名成员资料和 ${staff.length} 项公职`
  );
}

export async function captureContribution(context, signal) {
  await context.ui.executeFlow("teleportCityHall", {}, signal);
  await context.ui.executeFlow("navigateToSandTable", {}, signal);
  await context.ui.executeFlow("openContribution", {}, signal);
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
  await ensureActivityDescending(context, signal);
  return capturePagedTable(
    context,
    "member-activity",
    context.config.tables.activity,
    signal,
    options
  );
}

async function ensureActivityDescending(context, signal) {
  const definition = context.config.tables.activity;
  const before = await context.vision.capture("activity-sort-before", signal);
  const beforeRows = normalizeActivity(parseTable(before.observations, definition));
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
  }
  const after = await context.vision.capture("activity-sort-after", signal);
  const afterValues = normalizeActivity(parseTable(after.observations, definition))
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

export async function captureProfilesAndStaff(context, signal) {
  await context.ui.executeFlow("openCampPanel", {}, signal);
  await context.ui.executeFlow("openMemberPanel", {}, signal);
  const expectedMembers = await context.vision.readMemberExpectedTotal(signal);
  const details = await capturePagedTable(
    context,
    "member-details",
    context.config.tables.members,
    signal
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
  if (!staff.length) throw new Error("No staff rows recognized; snapshot was not uploaded");
  if (staff.length > 11) {
    throw new Error(
      `STAFF_COUNT_INVALID: recognized ${staff.length}, maximum is mayor 1 + staff 10`
    );
  }
  return { details, staff };
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
  let stagnantPages = 0;
  let previousFingerprint = "";
  let previousRows = [];
  for (let page = 0; page < definition.pagination.maxPages; page += 1) {
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
      const attemptFrame = await vision.capture(attemptLabel, signal);
      let attemptRows =
        definition.extractionMode === "hybrid"
          ? []
          : parseTable(attemptFrame.observations, definition).filter(
              (row) =>
                row.name &&
                !definition.headerPattern.some((value) =>
                  row.name.includes(value)
                )
            );
      if (
        (!attemptRows.length || definition.extractionMode === "hybrid") &&
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
    rows = reconcilePageRows(previousRows, rows);
    let reachedActivityBoundary = false;
    if (Number.isFinite(Number(options.minimumInactiveDays))) {
      const selection = selectActivityWarningRows(
        rows,
        Number(options.minimumInactiveDays)
      );
      rows = selection.rows;
      reachedActivityBoundary = selection.reachedBoundary;
    }
    const fingerprint = rows.map((row) => row.name).join("|");
    let added = 0;
    for (const row of rows) {
      const current = byName.get(row.name) || {};
      if (!byName.has(row.name)) added += 1;
      byName.set(row.name, { ...current, ...row });
    }
    await report(
      "info",
      `${label}_page`,
      `第 ${page + 1} 页识别 ${rows.length} 行，累计 ${byName.size} 名成员`,
      { screenshot: frame.path }
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
    stagnantPages =
      added === 0 || fingerprint === previousFingerprint ? stagnantPages + 1 : 0;
    if (stagnantPages >= definition.pagination.stopAfterStagnantPages) break;
    previousFingerprint = fingerprint;
    previousRows = rows.map((row) => ({ ...row }));
    await adb.mouseSwipe(
      definition.pagination.from,
      definition.pagination.to,
      definition.pagination.durationMs,
      signal
    );
    await ui.afterAction(signal);
  }
  return [...byName.values()];
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
