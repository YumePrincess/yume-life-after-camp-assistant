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
import { loadTaskPlugins } from "./plugin-loader.mjs";
import {
  clearTaskDebugArtifacts,
  TaskDebugArtifacts
} from "./task-debug.mjs";
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
let activeTaskDebug = null;
let stopping = false;
const runtimeLocale = {
  value: normalizeTaskLocale(config.server.locale)
};
let controlStream = null;
let commandWakePending = false;
let resolveCommandWake = null;
let commandRetryTimer = null;
let commandRetryAttempt = 0;
const shutdownController = new AbortController();
const HEARTBEAT_INTERVAL_MS = 30_000;

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
    wakeAgentLoop();
  });
}

if (!once) {
  controlStream = api.startControlStream({
    onOpen: () => {
      console.log(JSON.stringify({ event: "agent_control_connected" }));
      sendAgentPresence();
      // The queue is authoritative, so sweep it after every connection or reconnect.
      wakeAgentLoop();
    },
    onCommandAvailable: () => wakeAgentLoop(),
    onPresenceAck: (ack) => {
      if (active && (ack.cancelRequested === true || ack.activeRunMissing === true)) {
        active.controller.abort(new Error("Workers 请求中断当前任务"));
      }
    },
    onDisconnect: () => {
      console.warn(JSON.stringify({ event: "agent_control_disconnected" }));
    },
    onError: (error) => {
      console.error(JSON.stringify({ event: "agent_control_error", message: error.message }));
    }
  });
}
const presenceTimer = once
  ? null
  : setInterval(() => sendAgentPresence(), HEARTBEAT_INTERVAL_MS);

while (!stopping) {
  if (!once) await waitForAgentWake();
  if (stopping) break;
  try {
    const pollResponse = await api.nextCommand(
      Boolean(active),
      runtimeLocale.value,
      shutdownController.signal
    );
    const { command } = pollResponse;
    commandRetryAttempt = 0;
    if (command?.type === "interrupt_task") {
      const target = command.payload?.runId;
      if (active && active.command.runId === target) {
        active.controller.abort(new Error("管理员请求中断"));
        await api.completeCommand(command, "completed", "已向运行任务发送中断信号");
      } else {
        await api.completeCommand(command, "cancelled", "目标任务当前未在本 Agent 运行");
      }
      sendAgentPresence();
    } else if (command?.type === "run_task" && !active) {
      const payloadRunId = command.payload?.runId;
      if (
        typeof command.runId !== "string" ||
        !command.runId ||
        (payloadRunId !== undefined && payloadRunId !== command.runId)
      ) {
        console.error(
          JSON.stringify({
            event: "orphan_command_rejected",
            commandId: command.id,
            runId: command.runId || null,
            payloadRunId: payloadRunId || null,
            reason: "run_task command has no matching persisted run"
          })
        );
        await api.completeCommand(
          command,
          "cancelled",
          "命令未关联有效任务，已拒绝执行"
        );
      } else {
        startCommand(command);
      }
      sendAgentPresence();
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
    const retryMs = Math.min(30_000, 1_000 * 2 ** Math.min(commandRetryAttempt, 5));
    commandRetryAttempt = Math.min(commandRetryAttempt + 1, 5);
    commandRetryTimer = setTimeout(() => {
      commandRetryTimer = null;
      wakeAgentLoop();
    }, retryMs);
  }
  if (once) break;
}

if (presenceTimer) clearInterval(presenceTimer);
if (commandRetryTimer) clearTimeout(commandRetryTimer);
if (stopping && controlStream) {
  await controlStream.sendPresenceAndWait({
    ...heartbeatPayload("offline"),
    agentId: config.server.agentId,
    displayName: config.server.agentName || config.server.agentId,
    activeRunId: null,
    activeTaskKey: null
  });
  api.closeControlStream();
}
if (active) await active.promise.catch(() => undefined);
await closeDebugServer(debugServer);

function heartbeatPayload(status) {
  const activityStatus = status || (active ? "running" : "idle");
  return {
    locale: runtimeLocale.value,
    activeRunId: active?.command.runId || null,
    activeTaskKey: active?.command.payload?.taskKey || null,
    status: status || activityStatus,
    capabilities: {
      backgroundAdbMouse: true,
      visionOcr: true,
      unicodeChat: true,
      stopEmulatorAfterTask: config.mumu.stopEmulatorAfterTask
    },
    detail: {
      activityMode: activityStatus,
      adbSerial: config.adb.serial,
      emulatorInstance:
        mumu.currentInstance()?.index ?? config.mumu.instanceIndex,
      emulatorName:
        mumu.currentInstance()?.name ?? config.mumu.instanceName ?? null
    }
  };
}

function sendAgentPresence() {
  return controlStream?.sendPresence({
    agentId: config.server.agentId,
    displayName: config.server.agentName || config.server.agentId,
    ...heartbeatPayload()
  }) ?? false;
}

function wakeAgentLoop() {
  commandWakePending = true;
  const resolve = resolveCommandWake;
  resolveCommandWake = null;
  resolve?.();
}

function waitForAgentWake() {
  if (commandWakePending || stopping) {
    commandWakePending = false;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    resolveCommandWake = () => {
      commandWakePending = false;
      resolve();
    };
  });
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
      sendAgentPresence();
      wakeAgentLoop();
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
  const startedAt = new Date().toISOString();
  const taskName = localizedPluginTaskName(plugin.manifest, taskKey, taskLocale);
  const taskMetadata = {
    runId: command.runId,
    commandId: command.id,
    taskKey,
    taskName,
    executionMode:
      command.payload?.executionMode ||
      command.payload?.mode ||
      command.payload?.triggerMode ||
      "unknown",
    startedAt
  };
  const taskDebug = config.debug?.captureScreenshots === true
    ? new TaskDebugArtifacts(taskMetadata)
    : null;
  const writeTaskLog = async (record) => {
    const event = {
      ...taskMetadata,
      timestamp: new Date().toISOString(),
      ...record
    };
    // Every task-facing log entry gets one contemporaneous screen, even when
    // the workflow did not attach a screenshot to its server detail payload.
    // This is a raw capture: it does not add another OCR pass or alter the
    // decisions of the actual workflow.
    if (
      taskDebug?.enabled === true &&
      ["task_event", "task_started", "task_finished", "task_failure_detailed", "task_snapshots_removed"].includes(event.event)
    ) {
      try {
        const frame = await vision.captureSource(
          `log-${event.step || event.event}`,
          signal?.aborted ? undefined : signal
        );
        if (frame.debugPath) {
          event.detail = {
            ...(event.detail || {}),
            debugImage: frame.debugPath
          };
        }
      } catch (error) {
        event.debugImageCaptureError = String(error?.message || error);
      }
    }
    console.info(JSON.stringify(event));
    await taskDebug?.recordEvent(event);
  };
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
  // Page scans emit several progress/events per swipe. Waiting for a debug
  // screenshot and a Worker round-trip in that hot path makes the Agent drag
  // visibly in MuMu, even though the same workflow is smooth in the local
  // diagnostic script. Keep those updates ordered, but let the UI continue;
  // terminal updates flush the queue before publishing the final state.
  let runUpdateQueue = Promise.resolve();
  const enqueueRunUpdate = (operation, phase) => {
    const next = runUpdateQueue
      .then(operation, operation)
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: "run_update_queue_failed",
            runId: command.runId,
            phase,
            message: String(error?.message || error)
          })
        );
      });
    runUpdateQueue = next;
  };
  const flushRunUpdates = async () => {
    await runUpdateQueue;
    try {
      await api.flushRunStream(command.runId);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "run_update_stream_flush_failed",
          runId: command.runId,
          message: String(error?.message || error)
        })
      );
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
    const event = {
      event: "task_event",
      level,
      step,
      message: localizedMessage,
      detail: localizedDetail
    };
    enqueueRunUpdate(async () => {
      await writeTaskLog(event);
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
    enqueueRunUpdate(
      () => updateRunSafely(
        { progress: next, currentStep },
        `progress:${currentStep || "unknown"}`
      ),
      `progress:${currentStep || "unknown"}`
    );
  };
  const pluginConfig = plugin.config || {};
  const taskConfig = {
    ...config,
    ...pluginConfig,
    tables: {
      ...(config.tables || {}),
      ...(pluginConfig.tables || {})
    },
    flows: {
      ...(config.flows || {}),
      ...(pluginConfig.flows || {})
    }
  };
  const ui = new GameUi(taskConfig, adb, vision, report, mumu);
  ui.setPluginConfig(pluginConfig);
  const positionIndependent = plugin.manifest.task.positionIndependent === true;
  const context = {
    config: taskConfig,
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
    memberRoster: [],
    pluginConfig,
    pluginId: plugin.manifest.id
  };
  vision.beginTask({ taskDebug });
  try {
    await taskDebug?.start();
    activeTaskDebug = taskDebug;
    const bootstrap = await api.bootstrap(command.runId, signal);
    context.memberRoster = Array.isArray(bootstrap.memberRoster)
      ? bootstrap.memberRoster.filter((member) => member?.name)
      : [];
    context.runtimeAutomation = bootstrap.configBundle.automationConfig;
    ui.setRuntimeAutomation(bootstrap.configBundle.automationConfig);
    if (!bootstrap.run) throw new Error("任务记录不存在，拒绝执行孤立命令");
    if (bootstrap.run.cancel_requested) throw new Error("任务在开始前已被中断");
    // Task-facing progress and event updates use one authenticated WebSocket
    // stream. Control-plane requests (bootstrap, snapshots, final state, and
    // command completion) remain explicit HTTP operations.
    api.startRunStream(command.runId, signal);
    taskMetadata.executionMode =
      taskMetadata.executionMode === "unknown"
        ? bootstrap.run.trigger_mode || "unknown"
        : taskMetadata.executionMode;
    await writeTaskLog({
      event: "task_started",
      level: "info",
      step: "starting",
      message: "本地 Agent 已领取任务",
      mode: taskMetadata.executionMode
    });
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
      await flushRunUpdates();
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
      await flushRunUpdates();
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
    await flushRunUpdates();
    if (!interrupted) {
      await writeTaskLog({
        event: "task_failure_detailed",
        level: "error",
        step: "failure",
        ...failureDetail,
        message: failureReason
      });
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
      await writeTaskLog({
        event: "task_snapshots_removed",
        level: "info",
        step: "cleanup",
        count: removedScreenshots
      });
    }
    const finishedAt = new Date().toISOString();
    await writeTaskLog({
      event: "task_finished",
      level: terminalState === "failed" ? "error" : terminalState === "interrupted" ? "warning" : "info",
      step: "finished",
      state: terminalState,
      success: ["succeeded", "partially_succeeded"].includes(terminalState),
      finishedAt,
      message: terminalMessage
    });
    await taskDebug?.finish({
      state: terminalState,
      message: terminalMessage,
      finishedAt
    });
    // task_finished itself may capture the final screen while Debug mode is
    // enabled. Remove that transient source frame after the Debug artifact
    // has been written so normal snapshots never accumulate on disk.
    await vision.cleanupTask().catch(() => 0);
    if (activeTaskDebug === taskDebug) activeTaskDebug = null;
    api.closeRunStream(command.runId);
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

function localizedPluginTaskName(manifest, taskKey, locale) {
  const names = manifest?.name;
  if (typeof names === "string") return names;
  return names?.[locale] || names?.["zh-cn"] || names?.en || taskKey || "unknown";
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
          activityMode: active ? "running" : "idle",
          adbSerial: config.adb.serial,
          stopEmulatorAfterTask: config.mumu.stopEmulatorAfterTask,
          debugCaptureScreenshots: config.debug.captureScreenshots === true,
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
    if (request.method === "POST" && request.url === "/shutdown") {
      const interrupted = Boolean(active);
      stopping = true;
      active?.controller.abort(new Error("本机调试端点请求停止 Agent"));
      shutdownController.abort(new Error("本机调试端点请求停止 Agent"));
      wakeAgentLoop();
      // The main loop publishes the final offline presence before closing the
      // persistent Workers control channel.
      response.end(JSON.stringify({ ok: true, stopping: true, interrupted }));
      return;
    }
    if (request.method === "POST" && request.url === "/debug-capture") {
      const body = await readJsonRequest(request);
      config.debug.captureScreenshots = body.enabled === true;
      if (!config.debug.captureScreenshots) {
        activeTaskDebug?.disable();
        await clearTaskDebugArtifacts();
      }
      response.end(JSON.stringify({
        ok: true,
        enabled: config.debug.captureScreenshots
      }));
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
