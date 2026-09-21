import { loadConfig } from "../src/config.mjs";
import { AgentApi } from "../src/api.mjs";
import { AdbClient } from "../src/adb.mjs";
import { MumuLifecycle } from "../src/mumu.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import { withGameSession } from "../src/game-session.mjs";
import { run as runWeeklyActivitySync, config as pluginConfig } from "../plugins/weekly-activity/plugin.mjs";

const config = await loadConfig();
const api = new AgentApi(config);
const adb = new AdbClient(config);
const mumu = new MumuLifecycle(config, adb);
const vision = new Vision(config, adb);
const controller = new AbortController();
const report = async (level, step, message, detail = {}) => {
  const safeDetail = { ...detail };
  delete safeDetail.screenshot;
  console.log(JSON.stringify({ event: "weekly_activity_current_test", level, step, message, ...safeDetail }));
};
const progress = async (value, step) => {
  console.log(JSON.stringify({ event: "weekly_activity_current_progress", progress: value, step }));
};

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => controller.abort(new Error(`Current weekly activity test received ${signalName}`)));
}

let memberRoster = [];
try {
  const bootstrap = await api.bootstrap(null, controller.signal);
  memberRoster = Array.isArray(bootstrap.memberRoster)
    ? bootstrap.memberRoster.filter((member) => member?.name)
    : [];
} catch (error) {
  if (!/agent_disabled/.test(error.message)) throw error;
  const response = await fetch(`${config.server.baseUrl.replace(/\/+$/, "")}/api/public/bootstrap`, {
    signal: controller.signal
  });
  const publicBootstrap = await response.json();
  memberRoster = Array.isArray(publicBootstrap.members)
    ? publicBootstrap.members
        .filter((member) => member?.name)
        .map((member) => ({ name: member.name }))
    : [];
  console.log(JSON.stringify({
    event: "weekly_activity_current_test_roster_fallback",
    reason: "agent_disabled",
    source: "public_bootstrap"
  }));
}
if (!memberRoster.length) {
  throw new Error("WEEKLY_ACTIVITY_CURRENT_TEST_NO_ROSTER: Workers 未返回成员主名单");
}

const taskConfig = {
  ...config,
  ...pluginConfig,
  tables: { ...(config.tables || {}), ...(pluginConfig.tables || {}) },
  flows: { ...(config.flows || {}), ...(pluginConfig.flows || {}) }
};
const ui = new GameUi(taskConfig, adb, vision, report, mumu);
ui.setPluginConfig(pluginConfig);
const snapshotRows = [];
const context = {
  config: taskConfig,
  api: {
    snapshot: async (_runId, type, rows) => {
      snapshotRows.push({ type, rows });
      return { ok: true, count: rows.length, received: rows.length, ignored: 0, ambiguous: 0 };
    }
  },
  adb,
  mumu,
  vision,
  ui,
  report,
  progress,
  positionIndependent: true,
  skipUnknownRecovery: false,
  skipReturnToCenter: true,
  memberRoster,
  pluginConfig,
  pluginId: "zone.yume.lifeafter.weekly-activity"
};

let completed = false;
let cleanupIssue = null;
const startedAt = Date.now();
vision.beginTask();
try {
  await withGameSession(
    context,
    (signal) => runWeeklyActivitySync(
      context,
      { runId: "local-weekly-activity-current-test", payload: { taskKey: "weekly_activity_sync" } },
      null,
      signal
    ),
    controller.signal,
    config.automationConfig?.gameWatchdog
  );
  completed = true;
} catch (error) {
  cleanupIssue = error.message;
  throw error;
} finally {
  const removedScreenshots = await vision.cleanupTask().catch(() => 0);
  console.log(JSON.stringify({
    event: "weekly_activity_current_test_result",
    completed,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
    roster: memberRoster.length,
    submittedType: snapshotRows.at(-1)?.type || null,
    submittedRows: snapshotRows.at(-1)?.rows?.length || 0,
    cleanupIssue,
    removedScreenshots,
    emulatorStopRequested: config.mumu.stopEmulatorAfterTask === true,
    gameAndMumuPreserved: false
  }));
}
