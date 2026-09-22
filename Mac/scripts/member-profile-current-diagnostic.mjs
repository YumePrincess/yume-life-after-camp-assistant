import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { MumuLifecycle } from "../src/mumu.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import { capturePagedTable } from "../src/workflows/member-sync.mjs";
import { waitForGameReady } from "../src/game-session.mjs";
import { config as memberProfilePluginConfig } from "../plugins/member-profile/config.mjs";
import {
  normalizeProfiles,
  normalizeStaffGrid
} from "../src/table-parser.mjs";

const config = await loadConfig();
const taskConfig = {
  ...config,
  tables: {
    ...(config.tables || {}),
    ...(memberProfilePluginConfig.tables || {})
  },
  flows: {
    ...(config.flows || {}),
    ...(memberProfilePluginConfig.flows || {})
  }
};
const adb = new AdbClient(taskConfig);
const mumu = new MumuLifecycle(taskConfig, adb);
const vision = new Vision(taskConfig, adb);
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
const ui = new GameUi(taskConfig, adb, vision, report, mumu);
ui.setPluginConfig(memberProfilePluginConfig);
ui.setRuntimeAutomation({
  gameWatchdog: {
    actionTimeoutSeconds: 180,
    frozenScreenSeconds: 180
  }
});
const context = { config: taskConfig, adb, mumu, vision, ui, report };

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
  advisorStarted = await vision.startAdvisor(controller.signal).catch(
    async (error) => {
      await report(
        "warning",
        "local_model_unavailable",
        "本地模型不可用，继续使用确定性流程",
        { reason: error.message }
      );
      return false;
    }
  );
  const instance = await mumu.resolveInstance(controller.signal, { refresh: true });
  await report(
    "info",
    "mumu_start",
    "已解析 MuMu 实例，开始确保模拟器运行并等待 ADB 就绪"
  );
  await mumu.ensureStarted(controller.signal);
  await adb.waitReady(taskConfig.mumu.adbReadyTimeoutSeconds, controller.signal);
  await report(
    "info",
    "mumu_instance_resolved",
    `已连接 MuMu 实例 ${instance.name}(${instance.index})，ADB ${taskConfig.adb.serial}`,
    { instance: instance.name, index: instance.index, serial: taskConfig.adb.serial }
  );
  await report("info", "game_start", "正在启动明日之后");
  await adb.launchGame();
  await report("info", "game_ready_wait", "正在等待游戏登录完成并确认 HUD 稳定");
  await waitForGameReady(context, controller.signal);
  await report("info", "open_camp_panel", "从 HUD 进入营地卡片首页");
  await ui.executeFlow("openCampPanel", {}, controller.signal);
  await ui.executeFlow("openMemberPanel", {}, controller.signal);
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
      taskConfig.tables.members,
      controller.signal,
      { expectedCount: expectedProfiles, scanState }
    )
  );
  const knownSceneLeaks = ["鸣鸥港", "私人营地", "茅斯小镇"];
  const sceneLeaks = profiles.flatMap((profile) => {
    const roommateName = String(profile?.roommateName || "");
    return knownSceneLeaks
      .filter((scene) => roommateName.includes(scene))
      .map((scene) => ({ name: profile.name, roommateName, scene }));
  });
  await report(
    sceneLeaks.length ? "error" : "info",
    "member_profile_mask_validation",
    sceneLeaks.length
      ? `遮罩校验发现 ${sceneLeaks.length} 个场景值进入同居字段`
      : "遮罩校验通过：未发现鸣鸥港、私人营地、茅斯小镇进入同居字段",
    { sceneLeaks, checkedProfiles: profiles.length }
  );
  if (sceneLeaks.length) {
    throw new Error(
      `MEMBER_PROFILE_SCENE_LEAK: ${sceneLeaks
        .map((item) => `${item.name}=${item.roommateName}`)
        .join("、")}`
    );
  }
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
    taskConfig.tables.staffGrid
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
