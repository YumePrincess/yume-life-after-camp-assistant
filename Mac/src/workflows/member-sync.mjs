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
  if (!rows.length) throw new Error("No contribution rows recognized");
  await context.api.snapshot(
    command.runId,
    "contribution",
    rows,
    new Date().toISOString(),
    signal
  );
  await context.report("info", "contribution_done", `已更新 ${rows.length} 名成员贡献`);
}

export async function runInactivitySync(context, command, _bundle, signal) {
  const rows = normalizeActivity(await captureActivity(context, true, signal));
  if (!rows.length) throw new Error("No activity rows recognized");
  await context.api.snapshot(
    command.runId,
    "activity",
    rows,
    new Date().toISOString(),
    signal
  );
  await context.report("info", "activity_done", `已更新 ${rows.length} 名成员在线情况`);
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

async function captureContribution(context, signal) {
  await context.ui.executeFlow("teleportCityHall", {}, signal);
  await context.ui.executeFlow("navigateToSandTable", {}, signal);
  await context.ui.executeFlow("openContribution", {}, signal);
  return capturePagedTable(
    context,
    "member-contribution",
    context.config.tables.contribution,
    signal
  );
}

async function captureActivity(context, startFromWorld, signal) {
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
    signal
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
    await context.ui.tap({ x: 1560, y: 215 }, signal);
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

async function captureProfilesAndStaff(context, signal) {
  await context.ui.executeFlow("teleportNoticeBoard", {}, signal);
  await context.ui.executeFlow("openCampPanel", {}, signal);
  await context.ui.executeFlow("openMemberPanel", {}, signal);
  const details = await capturePagedTable(
    context,
    "member-details",
    context.config.tables.members,
    signal
  );
  await context.ui.executeFlow("openStaffPanel", {}, signal);
  const staffFrame = await context.vision.capture("camp-staff", signal);
  const staff = normalizeStaffGrid(
    staffFrame.observations,
    context.config.tables.staffGrid
  );
  if (!staff.length) throw new Error("No staff rows recognized; snapshot was not uploaded");
  return { details, staff };
}

async function capturePagedTable(context, label, definition, signal) {
  const { vision, adb, ui, report } = context;
  const byName = new Map();
  let stagnantPages = 0;
  let previousFingerprint = "";
  for (let page = 0; page < definition.pagination.maxPages; page += 1) {
    const frame = await vision.capture(`${label}-${page + 1}`, signal);
    const rows = parseTable(frame.observations, definition).filter(
      (row) => row.name && !definition.headerPattern.some((value) => row.name.includes(value))
    );
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
    stagnantPages =
      added === 0 || fingerprint === previousFingerprint ? stagnantPages + 1 : 0;
    if (stagnantPages >= definition.pagination.stopAfterStagnantPages) break;
    previousFingerprint = fingerprint;
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
