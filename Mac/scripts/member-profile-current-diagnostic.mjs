import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { MumuLifecycle } from "../src/mumu.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import { capturePagedTable } from "../src/workflows/member-sync.mjs";
import {
  normalizeProfiles,
  normalizeStaffGrid
} from "../src/table-parser.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
const mumu = new MumuLifecycle(config, adb);
const vision = new Vision(config, adb);
const controller = new AbortController();
const report = async (level, step, message, detail = {}) => {
  const safeDetail = { ...detail };
  delete safeDetail.screenshot;
  console.log(
    JSON.stringify({
      event: "member_profile_current_test",
      level,
      step,
      message,
      ...safeDetail
    })
  );
};
const ui = new GameUi(config, adb, vision, report);
ui.setRuntimeAutomation({
  gameWatchdog: {
    actionTimeoutSeconds: 180,
    frozenScreenSeconds: 180
  }
});
const context = { config, adb, mumu, vision, ui, report };

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(
      new Error(`Current member profile test received ${signalName}`)
    );
  });
}

vision.beginTask();
let advisorStarted = false;
let profiles = [];
let staff = [];
let completed = false;
let expectedProfiles = null;
let finalPageMissingAllowed = false;
const startedAt = Date.now();
try {
  const instance = await mumu.resolveInstance(controller.signal, { refresh: true });
  await adb.connect();
  await adb.waitReady(config.mumu.adbReadyTimeoutSeconds, controller.signal);
  await report(
    "info",
    "mumu_instance_resolved",
    `已连接 MuMu 实例 ${instance.name}(${instance.index})，ADB ${config.adb.serial}`,
    { instance: instance.name, index: instance.index, serial: config.adb.serial }
  );
  advisorStarted = await vision.startAdvisor(controller.signal);
  await ui.executeFlow("resetMemberPanelForRescan", {}, controller.signal);
  const memberCountBreakdown =
    typeof vision.readMemberExpectedBreakdown === "function"
      ? await vision.readMemberExpectedBreakdown(controller.signal)
      : { total: await vision.readMemberExpectedTotal(controller.signal) };
  // Both header denominators are member populations for pagination; online
  // numerators and the adjacent info glyph are never added.
  expectedProfiles = memberCountBreakdown.total ??
    memberCountBreakdown.formalTotal + memberCountBreakdown.sailingTotal;
  const scanState = {};
  profiles = normalizeProfiles(
    await capturePagedTable(
      context,
      "member-details",
      config.tables.members,
      controller.signal,
      { expectedCount: expectedProfiles, scanState }
    )
  );
  finalPageMissingAllowed =
    scanState.finalPageMissingAllowed === true &&
    Number(scanState.finalPageMissingCount) === 1 &&
    profiles.length === expectedProfiles - 1;
  if (profiles.length !== expectedProfiles && !finalPageMissingAllowed) {
    console.log(
      JSON.stringify({
        event: "member_profile_current_test_mismatch_rows",
        expectedProfiles,
        profiles: profiles.map((row, index) => ({
          index: index + 1,
          name: row.name,
          profession: row.profession,
          manorLevel: row.manorLevel,
          roommateName: row.roommateName,
          campTitle: row.campTitle
        }))
      })
    );
    throw new Error(
      `MEMBER_PROFILE_INCOMPLETE: recognized ${profiles.length}/${expectedProfiles} required unique member rows`
    );
  }
  if (finalPageMissingAllowed) {
    await report(
      "warning",
      "member_profile_tail_missing_allowed",
      `末页固定底部行与最后一名成员重叠，实机测试允许缺失 1 人：实际 ${profiles.length}/${expectedProfiles}`,
      {
        expectedCount: expectedProfiles,
        recognizedCount: profiles.length,
        missingCount: 1,
        finalPage: scanState.finalPage,
        positionLocked: true
      }
    );
  }
  await ui.executeFlow("openStaffPanel", {}, controller.signal);
  const staffFrame = await vision.captureAccurate(
    "camp-staff-current",
    controller.signal
  );
  staff = normalizeStaffGrid(
    staffFrame.observations,
    config.tables.staffGrid
  );
  const advisedStaff = await vision.extractStaffRows(
    staffFrame.path,
    controller.signal
  );
  if (advisedStaff.length >= staff.length && advisedStaff.length > 0) {
    staff = advisedStaff;
  }
  if (staff.length > 11) {
    throw new Error(
      `STAFF_COUNT_INVALID: recognized ${staff.length}, maximum is mayor 1 + staff 10`
    );
  }
  completed = true;
} finally {
  const removedScreenshots = await vision.cleanupTask().catch(() => 0);
  if (advisorStarted) {
    await vision.stopAdvisor().catch(() => undefined);
  }
  console.log(
    JSON.stringify({
      event: "member_profile_current_test_result",
      completed,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      profiles: profiles.length,
      expectedProfiles,
      missingCount: Math.max(0, expectedProfiles - profiles.length),
      finalPageMissingAllowed,
      uniqueNames: new Set(profiles.map((row) => row.name)).size,
      withProfession: profiles.filter((row) => row.profession).length,
      withRoommate: profiles.filter((row) => row.roommateName).length,
      staff: staff.length,
      firstProfile: profiles[0] || null,
      lastProfile: profiles.at(-1) || null,
      staffRows: staff,
      removedScreenshots,
      gameAndMumuPreserved: true
    })
  );
}
