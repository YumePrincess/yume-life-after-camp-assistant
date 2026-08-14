import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { MumuLifecycle } from "../src/mumu.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import {
  alignStaffNamesToRoster,
  capturePagedTable
} from "../src/workflows/member-sync.mjs";
import { normalizeVisualName } from "../src/visual-name.mjs";
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
const context = { config, adb, vision, ui, report };

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(
      new Error(`Current member profile test received ${signalName}`)
    );
  });
}

vision.beginTask();
let profiles = [];
let staff = [];
let completed = false;
const startedAt = Date.now();
try {
  await mumu.ensureStarted(controller.signal);
  await adb.connect();
  await ui.executeFlow("openCampPanel", {}, controller.signal);
  await ui.executeFlow("openMemberPanel", {}, controller.signal);
  const expectedProfiles = await vision.readMemberExpectedTotal(
    controller.signal
  );
  profiles = normalizeProfiles(
    await capturePagedTable(
      context,
      "member-details",
      config.tables.members,
      controller.signal,
      { expectedCount: expectedProfiles }
    )
  );
  if (profiles.length !== expectedProfiles) {
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
  await ui.executeFlow("openStaffPanel", {}, controller.signal);
  const staffFrame = await vision.captureAccurate(
    "camp-staff-current",
    controller.signal
  );
  staff = normalizeStaffGrid(
    staffFrame.observations,
    config.tables.staffGrid
  );
  staff = alignStaffNamesToRoster(staff, profiles);
  if (staff.length > 11) {
    throw new Error(
      `STAFF_COUNT_INVALID: recognized ${staff.length}, maximum is mayor 1 + staff 10`
    );
  }
  completed = true;
} finally {
  const removedScreenshots = await vision.cleanupTask().catch(() => 0);
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
      profileNames: profiles.map((row, index) => auditVisualName(row.name, index + 1)),
      symbolNames: profiles
        .map((row, index) => auditVisualName(row.name, index + 1))
        .filter((row) => row.specialCharacters.length > 0 || row.visualSpaces.length > 0),
      staffRows: staff,
      removedScreenshots,
      gameAndMumuPreserved: true
    })
  );
}

function auditVisualName(value, index) {
  const text = String(value || "");
  const normalized = normalizeVisualName(text);
  const characters = [...text];
  return {
    index,
    text,
    normalized,
    codePoints: characters.map((character) =>
      `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`
    ),
    specialCharacters: characters.filter((character) =>
      /[\p{P}\p{S}]/u.test(character)
    ),
    visualSpaces: characters.filter((character) =>
      /\s|[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200B]/u.test(character)
    ),
    changedByNormalization: text !== normalized
  };
}
