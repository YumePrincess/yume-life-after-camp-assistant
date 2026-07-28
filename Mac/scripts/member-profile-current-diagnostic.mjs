import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import { capturePagedTable } from "../src/workflows/member-sync.mjs";
import {
  normalizeProfiles,
  normalizeStaffGrid
} from "../src/table-parser.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
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
const context = { config, adb, vision, ui, report };

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
const startedAt = Date.now();
try {
  await adb.connect();
  advisorStarted = await vision.startAdvisor(controller.signal);
  const expectedProfiles = await vision.readMemberExpectedTotal(
    controller.signal
  );
  profiles = normalizeProfiles(
    await capturePagedTable(
      context,
      "member-profile-current",
      config.tables.members,
      controller.signal
    )
  );
  if (profiles.length !== expectedProfiles) {
    throw new Error(
      `MEMBER_PROFILE_INCOMPLETE: recognized ${profiles.length}/${expectedProfiles} required unique member rows`
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
  if (advisedStaff.length > staff.length) staff = advisedStaff;
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
