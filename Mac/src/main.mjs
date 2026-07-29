import { createServer } from "node:http";
import { loadConfig, MAC_ROOT } from "./config.mjs";
import { enableExternalFileLogging } from "./file-logger.mjs";
import { AdbClient } from "./adb.mjs";
import { AgentApi } from "./api.mjs";
import { MumuLifecycle } from "./mumu.mjs";
import { Vision } from "./vision.mjs";
import { GameUi } from "./ui.mjs";
import { withGameSession } from "./game-session.mjs";
import { delay } from "./process.mjs";
import { runTechnology } from "./workflows/technology.mjs";
import {
  runContributionSync,
  runInactivitySync,
  runMemberProfileSync
} from "./workflows/member-sync.mjs";
import { runPatrol } from "./workflows/patrol.mjs";
import {
  runKickInactiveMembers,
  runKickMember
} from "./workflows/kick-member.mjs";

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

const workflows = {
  tech_switch: runTechnology,
  contribution_sync: runContributionSync,
  inactivity_sync: runInactivitySync,
  member_profile_sync: runMemberProfileSync,
  patrol: runPatrol,
  kick_member: runKickMember,
  kick_inactive_members: runKickInactiveMembers
};

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
  });
}

do {
  try {
    const heartbeat = await api.heartbeat({
      activeRunId: active?.command.runId || null,
      activeTaskKey: active?.command.payload?.taskKey || null,
      status: active ? "running" : "idle",
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
    });
    if (active && heartbeat.cancelRequested === true) {
      active.controller.abort(new Error("管理员请求中断"));
    }

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
  if (!once) await delay(nextPollSeconds * 1000).catch(() => undefined);
} while (!stopping);

if (active) await active.promise.catch(() => undefined);
await closeDebugServer(debugServer);

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
  const workflow = workflows[taskKey];
  if (!workflow) {
    await api.completeCommand(command, "failed", `未知任务：${taskKey}`);
    return;
  }
  let terminalState = "succeeded";
  let terminalMessage = "任务完成";
  const report = async (level, step, message, detail = {}) => {
    await api.updateRun(command.runId, {
      currentStep: step,
      message,
      event: { level, step, message, detail }
    });
  };
  const progress = async (value, currentStep) => {
    await api.updateRun(command.runId, { progress: value, currentStep });
  };
  const ui = new GameUi(config, adb, vision, report);
  const positionIndependent = [
    "tech_switch",
    "member_profile_sync"
  ].includes(taskKey);
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
    skipReturnToCenter: positionIndependent
  };
  vision.beginTask();
  try {
    const bootstrap = await api.bootstrap(command.runId, signal);
    context.runtimeAutomation = bootstrap.configBundle.automationConfig;
    ui.setRuntimeAutomation(bootstrap.configBundle.automationConfig);
    if (bootstrap.run?.cancel_requested) throw new Error("任务在开始前已被中断");
    await api.updateRun(command.runId, {
      state: "running",
      message: "本地 Agent 已开始执行",
      currentStep: "starting",
      progress: 0.02,
      event: {
        level: "info",
        step: "starting",
        message: "本地 Agent 已领取任务"
      }
    });
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
      await api.updateRun(command.runId, {
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
      });
    } else {
      await api.updateRun(command.runId, {
        state: "succeeded",
        message: "任务已成功完成，游戏与模拟器已停止",
        currentStep: null,
        progress: 1,
        event: {
          level: "info",
          step: "finished",
          message: "任务成功；已完成资源清理"
        }
      });
    }
  } catch (error) {
    const interrupted = signal.aborted;
    terminalState = interrupted ? "interrupted" : "failed";
    terminalMessage = interrupted ? "任务已由管理员中断" : error.message;
    await api.updateRun(command.runId, {
      state: terminalState,
      message: terminalMessage,
      currentStep: null,
      event: {
        level: interrupted ? "warning" : "error",
        step: "finished",
        message: terminalMessage
      }
    }).catch(() => undefined);
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
          stopEmulatorAfterTask: config.mumu.stopEmulatorAfterTask
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
