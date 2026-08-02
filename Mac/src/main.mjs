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

    const pollResponse = await api.nextCommand(Boolean(active));
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
    await updateRunSafely({
      currentStep: step,
      message,
      event: { level, step, message, detail }
    }, `event:${step}`);
  };
  const progress = async (value, currentStep) => {
    await updateRunSafely(
      { progress: value, currentStep },
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
    skipReturnToCenter: positionIndependent
  };
  vision.beginTask();
  try {
    const bootstrap = await api.bootstrap(command.runId, signal);
    context.runtimeAutomation = bootstrap.configBundle.automationConfig;
    ui.setRuntimeAutomation(bootstrap.configBundle.automationConfig);
    if (bootstrap.run?.cancel_requested) throw new Error("任务在开始前已被中断");
    await updateRunSafely({
      state: "running",
      message: "本地 Agent 已开始执行",
      currentStep: "starting",
      progress: 0.02,
      event: {
        level: "info",
        step: "starting",
        message: "本地 Agent 已领取任务"
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
      terminalMessage = `核心数据已更新，但收尾未完全完成：${sessionResult.cleanupIssues.join("；")}`;
      await updateRunSafely({
        state: terminalState,
        message: terminalMessage,
        currentStep: null,
        progress: 1,
        event: {
          level: "warning",
          step: "finished",
          message: terminalMessage,
          detail: { cleanupIssues: sessionResult.cleanupIssues }
        }
      }, "finished:partially_succeeded", true);
    } else {
      terminalState = "succeeded";
      terminalMessage = "任务已成功完成，游戏与模拟器已停止";
      await updateRunSafely({
        state: "succeeded",
        message: terminalMessage,
        currentStep: null,
        progress: 1,
        event: {
          level: "info",
          step: "finished",
          message: "任务成功；已完成资源清理"
        }
      }, "finished:succeeded", true);
    }
  } catch (error) {
    const interrupted = signal.aborted;
    terminalState = interrupted ? "interrupted" : "failed";
    terminalMessage = interrupted ? "任务已由管理员中断" : error.message;
    await updateRunSafely({
      state: terminalState,
      message: terminalMessage,
      currentStep: null,
      event: {
        level: interrupted ? "warning" : "error",
        step: "finished",
        message: terminalMessage
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
