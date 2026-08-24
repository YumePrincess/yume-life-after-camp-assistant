import { createServer } from "node:http";
import { resolve } from "node:path";
import { loadConfig, MAC_ROOT } from "./config.mjs";
import { enableExternalFileLogging } from "./file-logger.mjs";
import { AdbClient } from "./adb.mjs";
import { AgentApi } from "./api.mjs";
import { MumuLifecycle } from "./mumu.mjs";
import { Vision } from "./vision.mjs";
import { GameUi } from "./ui.mjs";
import { withGameSession } from "./game-session.mjs";
import { delay } from "./process.mjs";
import { loadTaskPlugins } from "./plugin-loader.mjs";
import {
  localizeTaskEvent,
  localizedTaskEventMessages,
  normalizeTaskLocale
} from "./task-localization.mjs";

enableExternalFileLogging(MAC_ROOT);
const config = await loadConfig();
const api = new AgentApi(config);
const adb = new AdbClient(config);
const mumu = new MumuLifecycle(config, adb);
const vision = new Vision(config, adb);
const staleSnapshotsRemoved = await vision.cleanupStale();
if (staleSnapshotsRemoved) {
  console.log(
    JSON.stringify({
      event: "stale_snapshots_removed",
      count: staleSnapshotsRemoved
    })
  );
}
const once = process.argv.includes("--once");
let active = null;
let stopping = false;
const runtimeLocale = {
  value: normalizeTaskLocale(config.server.locale)
};
let nextPollSeconds = config.server.pollSeconds;
const shutdownController = new AbortController();
const HEARTBEAT_INTERVAL_MS = 15_000;

const pluginRegistry = await loadTaskPlugins({
  builtinDirectory: resolve(MAC_ROOT, "plugins"),
  userDirectory: config.plugins.userDirectory,
  disabledPluginIds: config.plugins.disabled,
  trustedKeys: config.plugins.trustedKeys,
  allowUnsignedLocal: config.plugins.allowUnsignedLocal
});
const workflows = Object.fromEntries(
  Object.entries(pluginRegistry.workflows).map(([taskKey, plugin]) => [
    taskKey,
    plugin.workflow
  ])
);
for (const error of pluginRegistry.errors) {
  console.error(JSON.stringify({ event: "plugin_load_failed", ...error }));
}
console.log(
  JSON.stringify({
    event: "plugins_loaded",
    count: pluginRegistry.plugins.length,
    plugins: pluginRegistry.plugins.map(({ manifest, builtin, signature }) => ({
      id: manifest.id,
      version: manifest.version,
      build: manifest.build,
      taskKey: manifest.task.key,
      builtin,
      signed: signature.verified
    }))
  })
);

const debugServer = createDebugServer();
debugServer.listen(config.debug.port, config.debug.host, () => {
  console.log(
    JSON.stringify({
      event: "debug_listening",
      address: `http://${config.debug.host}:${config.debug.port}`
    })
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    active?.controller.abort(new Error(`Agent received ${signal}`));
    shutdownController.abort(new Error(`Agent received ${signal}`));
  });
}

do {
  try {
    await sendHeartbeat(shutdownController.signal);

    const pollResponse = await api.nextCommand(Boolean(active), runtimeLocale.value);
    const { command } = pollResponse;
    if (Number.isFinite(pollResponse.pollAfterSeconds)) {
      nextPollSeconds = Math.max(1, Math.min(3600, pollResponse.pollAfterSeconds));
    }
    if (command?.type === "interrupt_task") {
      const target = command.payload?.runId;
      if (active && active.command.runId === target) {
        active.controller.abort(new Error("管理员请求中断"));
        await api.completeCommand(command, "completed", "已向运行任务发送中断信号");
      } else {
        await api.completeCommand(command, "cancelled", "目标任务当前未在本 Agent 运行");
      }
    } else if (command?.type === "run_task" && !active) {
      startCommand(command);
      // The command was claimed during an idle poll. Poll again immediately
      // so the server can switch us to its active interval and deliver an
      // interrupt without waiting for the (possibly five-minute) idle delay.
      nextPollSeconds = 1;
    }

    if (once) {
      if (active) await active.promise.catch(() => undefined);
      console.log(
        JSON.stringify({
          event: "agent_once_complete",
          commandHandled: Boolean(command)
        })
      );
      break;
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "agent_loop_error", message: error.message }));
    if (once) {
      process.exitCode = 1;
      break;
    }
  }
  if (!once && !stopping) {
    await waitForNextPoll(nextPollSeconds).catch(() => undefined);
  }
} while (!stopping);

if (stopping) await sendOfflineHeartbeat();
if (active) await active.promise.catch(() => undefined);
await closeDebugServer(debugServer);

function heartbeatPayload(status = active ? "running" : "idle") {
  return {
    locale: runtimeLocale.value,
    activeRunId: active?.command.runId || null,
    activeTaskKey: active?.command.payload?.taskKey || null,
    status,
    capabilities: {
      backgroundAdbMouse: true,
      visionOcr: true,
      unicodeChat: true,
      stopEmulatorAfterTask: config.mumu.stopEmulatorAfterTask
    },
    detail: {
      adbSerial: config.adb.serial,
      emulatorInstance:
        mumu.currentInstance()?.index ?? config.mumu.instanceIndex,
      emulatorName:
        mumu.currentInstance()?.name ?? config.mumu.instanceName ?? null
    }
  };
}

async function sendHeartbeat(signal) {
  const heartbeat = await api.heartbeat(heartbeatPayload(), signal);
  if (active && heartbeat.cancelRequested === true) {
    active.controller.abort(new Error("管理员请求中断"));
  }
}

async function sendOfflineHeartbeat() {
  try {
    await api.heartbeat(
      {
        ...heartbeatPayload("offline"),
        activeRunId: null,
        activeTaskKey: null
      }
    );
  } catch (error) {
    console.error(
      JSON.stringify({ event: "offline_heartbeat_failed", message: error.message })
    );
  }
}

async function waitForNextPoll(seconds) {
  const deadline = Date.now() + Math.max(1, seconds) * 1000;
  while (!stopping) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await delay(
      Math.min(remaining, HEARTBEAT_INTERVAL_MS),
      shutdownController.signal
    );
    if (Date.now() < deadline && !stopping) {
      try {
        await sendHeartbeat(shutdownController.signal);
      } catch (error) {
        if (shutdownController.signal.aborted) return;
        console.error(
          JSON.stringify({ event: "heartbeat_refresh_failed", message: error.message })
        );
      }
    }
  }
}

async function closeDebugServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    // A Cloudflare Tunnel or local health check can keep an HTTP connection to
    // port 8091 alive. `--once` must still return control to the shell.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function startCommand(command) {
  const controller = new AbortController();
  const record = { command, controller, promise: null };
  active = record;
  record.promise = executeCommand(command, controller.signal)
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: "command_failed",
          commandId: command.id,
          runId: command.runId,
          message: error.message
        })
      );
    })
    .finally(() => {
      if (active === record) active = null;
    });
}

async function executeCommand(command, signal) {
  const taskKey = command.payload?.taskKey;
  const taskLocale = normalizeTaskLocale(
    command?.payload?.locale || command?.payload?.detail?.locale || runtimeLocale.value
  );
  const plugin = pluginRegistry.workflows[taskKey];
  const workflow = plugin?.workflow;
  if (!workflow) {
    await api.completeCommand(command, "failed", `未知任务：${taskKey}`);
    return;
  }
  let terminalState = "succeeded";
  let terminalMessage = "任务完成";
  const updateRunSafely = async (update, phase, detached = false) => {
    try {
      // Terminal reporting must outlive task cancellation. Reusing the task's
      // already-aborted signal here prevents the interrupted state from ever
      // reaching Workers and leaves the web UI stuck at `cancelling`.
      await api.updateRun(command.runId, update, detached ? undefined : signal);
      return true;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "run_update_failed",
          runId: command.runId,
          phase,
          message: error.message
        })
      );
      return false;
    }
  };
  const report = async (level, step, message, detail = {}) => {
    const localizedMessages = localizedTaskEventMessages(step, message);
    const localizedMessage = localizedMessages[taskLocale];
    const localizedDetail = {
      ...detail,
      locale: taskLocale,
      localizedMessages
    };
    console.info(JSON.stringify({
      event: "task_event",
      runId: command.runId,
      level,
      step,
      message: localizedMessage,
      detail: localizedDetail
    }));
    await updateRunSafely({
      currentStep: step,
      message: localizedMessage,
      detail: localizedDetail,
      event: {
        level,
        step,
        message: localizedMessage,
        detail: localizedDetail
      }
    }, `event:${step}`);
  };
  const progressState = { value: 0.02, step: "starting" };
  const progress = async (value, currentStep) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const next = Math.min(1, Math.max(progressState.value, numeric));
    if (
      next === progressState.value ||
      (currentStep === progressState.step &&
        next - progressState.value < 0.005)
    ) {
      return;
    }
    progressState.value = next;
    progressState.step = currentStep;
    await updateRunSafely(
      { progress: next, currentStep },
      `progress:${currentStep || "unknown"}`
    );
  };
  const ui = new GameUi(config, adb, vision, report, mumu);
  const positionIndependent = plugin.manifest.task.positionIndependent === true;
  const context = {
    config,
    api,
    adb,
    mumu,
    vision,
    ui,
    report,
    progress,
    positionIndependent,
    skipUnknownRecovery: false,
    skipReturnToCenter: positionIndependent,
    memberRoster: []
  };
  vision.beginTask();
  try {
    const bootstrap = await api.bootstrap(command.runId, signal);
    context.memberRoster = Array.isArray(bootstrap.memberRoster)
      ? bootstrap.memberRoster.filter((member) => member?.name)
      : [];
    context.runtimeAutomation = bootstrap.configBundle.automationConfig;
    ui.setRuntimeAutomation(bootstrap.configBundle.automationConfig);
    if (bootstrap.run?.cancel_requested) throw new Error("任务在开始前已被中断");
    await updateRunSafely({
      state: "running",
      message: localizeTaskEvent(
        "starting",
        "本地 Agent 已开始执行",
        taskLocale
      ),
      currentStep: "starting",
      progress: 0.02,
      detail: {
        locale: taskLocale,
        localizedMessages: localizedTaskEventMessages(
          "starting",
          "本地 Agent 已领取任务"
        )
      },
      event: {
        level: "info",
        step: "starting",
        message: localizedTaskEventMessages(
          "starting",
          "本地 Agent 已领取任务"
        )[taskLocale],
        detail: {
          locale: taskLocale,
          localizedMessages: localizedTaskEventMessages(
            "starting",
            "本地 Agent 已领取任务"
          )
        }
      }
    }, "starting");
    const sessionResult = await withGameSession(
      context,
      (attemptSignal) =>
        workflow(context, command, bootstrap.configBundle, attemptSignal),
      signal,
      bootstrap.configBundle.automationConfig.gameWatchdog
    );
    if (sessionResult?.cleanupCompleted === false) {
      terminalState = "partially_succeeded";
      const terminalSourceMessage =
        `核心数据已更新，但收尾未完全完成：${sessionResult.cleanupIssues.join("；")}`;
      const localizedMessages = localizedTaskEventMessages(
        "finished",
        terminalSourceMessage
      );
      terminalMessage = localizedMessages[taskLocale];
      await updateRunSafely({
        state: terminalState,
        message: terminalMessage,
        currentStep: null,
        progress: 1,
        detail: {
          cleanupIssues: sessionResult.cleanupIssues,
          locale: taskLocale,
          localizedMessages
        },
        event: {
          level: "warning",
          step: "finished",
          message: terminalMessage,
          detail: {
            cleanupIssues: sessionResult.cleanupIssues,
            locale: taskLocale,
            localizedMessages
          }
        }
      }, "finished:partially_succeeded", true);
    } else {
      terminalState = "succeeded";
      const localizedMessages = localizedTaskEventMessages(
        "finished",
        "任务已成功完成，游戏与模拟器已停止"
      );
      terminalMessage = localizedMessages[taskLocale];
      await updateRunSafely({
        state: "succeeded",
        message: terminalMessage,
        currentStep: null,
        progress: 1,
        detail: {
          locale: taskLocale,
          localizedMessages
        },
        event: {
          level: "info",
          step: "finished",
          message: localizeTaskEvent(
            "finished",
            "任务成功；已完成资源清理",
            taskLocale
          ),
          detail: {
            locale: taskLocale,
            localizedMessages: localizedTaskEventMessages(
              "finished",
              "任务成功；已完成资源清理"
            )
          }
        }
      }, "finished:succeeded", true);
    }
  } catch (error) {
    const interrupted = signal.aborted;
    terminalState = interrupted ? "interrupted" : "failed";
    const failureReason = interrupted
      ? "任务已由管理员中断"
      : String(error?.message || error || "未知错误");
    const failureDetail = interrupted
      ? { interrupted: true }
      : {
          errorName: String(error?.name || "Error"),
          errorMessage: failureReason,
          errorStack: String(error?.stack || "").slice(0, 8_000),
          taskKey,
          workflowPhase: context.patrolTeamPhase || null,
          patrolDeadlineAt: context.patrolDeadlineAt || null,
          patrolExistingValidRoute: context.patrolExistingValidRoute === true,
          patrolKeepExistingTeam: context.patrolKeepExistingTeam === true,
          patrolFailureCleanupDone: context.patrolFailureCleanupDone === true,
          suppressScheduledRetry: context.suppressScheduledRetry === true,
          suppressScheduledRetryReason:
            context.suppressScheduledRetryReason || null
        };
    if (!interrupted) {
      console.error(
        JSON.stringify({
          event: "task_failure_detailed",
          runId: command.runId,
          commandId: command.id,
          ...failureDetail
        })
      );
    }
    const terminalSourceMessage = failureReason;
    const terminalMessages = localizedTaskEventMessages("finished", terminalSourceMessage);
    terminalMessage = terminalMessages[taskLocale];
    const terminalDetail = context.suppressScheduledRetry
      ? {
          suppressScheduledRetry: true,
          retrySuppressionReason:
            context.suppressScheduledRetryReason || "task_cleanup"
        }
      : undefined;
    await updateRunSafely({
      state: terminalState,
      message: terminalMessage,
      currentStep: null,
      detail: {
        ...(terminalDetail || {}),
        ...failureDetail,
        locale: taskLocale,
        localizedMessages: terminalMessages
      },
      event: {
        level: interrupted ? "warning" : "error",
        step: "finished",
        message: terminalMessage,
        detail: {
          ...(terminalDetail || {}),
          ...failureDetail,
          locale: taskLocale,
          localizedMessages: terminalMessages
        }
      }
    }, `finished:${terminalState}`, true);
  } finally {
    const removedScreenshots = await vision.cleanupTask().catch(() => 0);
    if (removedScreenshots) {
      console.log(
        JSON.stringify({
          event: "task_snapshots_removed",
          runId: command.runId,
          count: removedScreenshots
        })
      );
    }
    await api.completeCommand(
      command,
      ["succeeded", "partially_succeeded"].includes(terminalState)
        ? "completed"
        : terminalState === "interrupted"
          ? "cancelled"
          : "failed",
      terminalMessage
    ).catch(() => undefined);
  }
}

function parseRunDetail(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function createDebugServer() {
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (!authorizedDebugRequest(request)) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.end(
        JSON.stringify({
          ok: true,
          locale: runtimeLocale.value,
          activeRunId: active?.command.runId || null,
          activeTaskKey: active?.command.payload?.taskKey || null,
          adbSerial: config.adb.serial,
          stopEmulatorAfterTask: config.mumu.stopEmulatorAfterTask,
          plugins: pluginRegistry.plugins.map(({ manifest, builtin }) => ({
            id: manifest.id,
            version: manifest.version,
            build: manifest.build,
            taskKey: manifest.task.key,
            builtin
          }))
        })
      );
      return;
    }
    if (request.method === "POST" && request.url === "/locale") {
      const body = await readJsonRequest(request);
      runtimeLocale.value = normalizeTaskLocale(body.locale);
      config.server.locale = runtimeLocale.value;
      response.end(JSON.stringify({ ok: true, locale: runtimeLocale.value }));
      return;
    }
    if (request.method === "POST" && request.url === "/abort") {
      if (active) active.controller.abort(new Error("本机调试端点请求中断"));
      response.end(JSON.stringify({ ok: true, interrupted: Boolean(active) }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
}

function authorizedDebugRequest(request) {
  const authorization = request.headers.authorization || "";
  return authorization === `Bearer ${config.debug.token}`;
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}
