import { DurableObject } from "cloudflare:workers";
import {
  appendRunEvent,
  getConfigBundle,
  getHeartbeat,
  getRun,
  touchHeartbeat,
  updateRun
} from "./db";
import type { RunState, TaskKey } from "./domain";

const TERMINAL_RUN_STATES = new Set<RunState>([
  "interrupted",
  "succeeded",
  "partially_succeeded",
  "failed",
  "timed_out",
  "skipped"
]);

const RUN_STATES = new Set<RunState>([
  "queued",
  "claimed",
  "running",
  "cancelling",
  ...TERMINAL_RUN_STATES
]);

const EVENT_LEVELS = new Set(["debug", "info", "warning", "error"]);
const MAX_BATCH_SIZE = 100;
const MAX_FRAME_BYTES = 512_000;
const TASK_KEYS = new Set<TaskKey>([
  "tech_switch",
  "contribution_sync",
  "inactivity_sync",
  "member_profile_sync",
  "weekly_activity_sync",
  "patrol"
]);

interface SocketAttachment {
  connectedAt: number;
  channel: "control" | "logs";
  agentId: string | null;
  presenceSignature: string | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WebSocket payload must be an object");
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${field} is invalid`);
  return result;
}

function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && RUN_STATES.has(value as RunState);
}

function isTerminalRunState(value: string): boolean {
  return TERMINAL_RUN_STATES.has(value as RunState);
}

function isEventLevel(value: unknown): value is "debug" | "info" | "warning" | "error" {
  return typeof value === "string" && EVENT_LEVELS.has(value);
}

function parseMessage(message: string | ArrayBuffer): Record<string, unknown> {
  const text = typeof message === "string"
    ? message
    : new TextDecoder().decode(message);
  if (new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) {
    throw new Error("WebSocket frame is too large");
  }
  return objectValue(JSON.parse(text));
}

function offeredProtocol(request: Request): string | null {
  return (request.headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value === "mrzh-agent-stream") || null;
}

export interface AgentRunUpdateBatch {
  type: "run-update-batch";
  runId: string;
  sequence: number;
  updates: Array<Record<string, unknown>>;
}

export class AgentLogStream extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/notify") {
      let payload: Record<string, unknown>;
      try {
        payload = parseMessage(await request.text());
      } catch {
        return new Response("Invalid notification payload", { status: 400 });
      }
      if (payload.type !== "command-available") {
        return new Response("Unsupported notification", { status: 400 });
      }
      const agentId = textValue(payload.agentId, "agentId", 80);
      let notified = 0;
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = this.socketAttachment(socket);
        if (attachment.channel !== "control" || attachment.agentId !== agentId) continue;
        try {
          socket.send(JSON.stringify({ type: "command-available" }));
          notified += 1;
        } catch {
          // A reconnect will perform a queue sweep if this socket is stale.
        }
      }
      return Response.json({ ok: true, notified });
    }
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const protocol = offeredProtocol(request);
    if (!protocol) return new Response("Agent stream protocol required", { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const channel = url.searchParams.get("channel") === "control" ? "control" : "logs";
    const agentId = channel === "control"
      ? textValue(url.searchParams.get("agentId"), "agentId", 80)
      : null;
    const attachment: SocketAttachment = {
      connectedAt: Date.now(),
      channel,
      agentId,
      presenceSignature: null
    };
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: "ready", channel, at: new Date().toISOString() }));
    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": protocol },
      webSocket: client
    });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let sequence: number | null = null;
    try {
      const payload = parseMessage(message);
      if (payload.type === "presence") {
        await this.handlePresence(ws, payload);
        return;
      }
      if (payload.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
        return;
      }
      if (payload.type !== "run-update-batch") {
        throw new Error("Unsupported agent stream message");
      }
      const runId = textValue(payload.runId, "runId", 80);
      sequence = Number(payload.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error("sequence is invalid");
      }
      if (!Array.isArray(payload.updates) || payload.updates.length < 1 || payload.updates.length > MAX_BATCH_SIZE) {
        throw new Error("updates is invalid");
      }
      for (const rawUpdate of payload.updates) {
        await this.applyUpdate(runId, objectValue(rawUpdate));
      }
      this.ctx.waitUntil(this.publishAdminUpdate());
      ws.send(JSON.stringify({ type: "ack", sequence }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: "error",
        ...(sequence !== null ? { sequence } : {}),
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = this.socketAttachment(ws);
    if (
      attachment.channel === "control" &&
      attachment.agentId &&
      !this.ctx.getWebSockets().some((candidate) => {
        if (candidate === ws) return false;
        const other = this.socketAttachment(candidate);
        return other.channel === "control" && other.agentId === attachment.agentId;
      })
    ) {
      await this.markAgentOffline(attachment.agentId);
    }
    ws.close(code, reason);
  }

  private socketAttachment(ws: WebSocket): SocketAttachment {
    const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
    return {
      connectedAt: Number(attachment?.connectedAt) || Date.now(),
      channel: attachment?.channel === "control" ? "control" : "logs",
      agentId: typeof attachment?.agentId === "string" ? attachment.agentId : null,
      presenceSignature:
        typeof attachment?.presenceSignature === "string"
          ? attachment.presenceSignature
          : null
    };
  }

  private async handlePresence(
    ws: WebSocket,
    payload: Record<string, unknown>
  ): Promise<void> {
    const attachment = this.socketAttachment(ws);
    if (attachment.channel !== "control" || !attachment.agentId) {
      throw new Error("Presence is only accepted on the Agent control channel");
    }
    const agentId = textValue(payload.agentId, "agentId", 80);
    if (agentId !== attachment.agentId) throw new Error("Agent identity does not match channel");
    const status = ["idle", "running", "offline"].includes(String(payload.status))
      ? String(payload.status)
      : "idle";
    const activeRunId = typeof payload.activeRunId === "string"
      ? payload.activeRunId.slice(0, 80)
      : null;
    const activeTaskValue = typeof payload.activeTaskKey === "string"
      ? payload.activeTaskKey
      : null;
    const activeTaskKey = activeTaskValue && TASK_KEYS.has(activeTaskValue as TaskKey)
      ? activeTaskValue as TaskKey
      : null;
    const displayName = typeof payload.displayName === "string"
      ? payload.displayName.slice(0, 80)
      : agentId;
    const capabilities = payload.capabilities && typeof payload.capabilities === "object" &&
      !Array.isArray(payload.capabilities)
      ? payload.capabilities
      : {};
    const detail = payload.detail && typeof payload.detail === "object" &&
      !Array.isArray(payload.detail)
      ? payload.detail
      : {};

    await touchHeartbeat(this.env, {
      agentId,
      displayName,
      activeRunId,
      activeTaskKey,
      status,
      capabilities,
      detail
    });
    const bundle = await getConfigBundle(this.env);
    const activeRun = activeRunId ? await getRun(this.env, activeRunId) : null;
    const activeRunMissing = Boolean(activeRunId && !activeRun);
    const signature = JSON.stringify({ status, activeRunId, activeTaskKey });
    const statusChanged = attachment.presenceSignature !== signature;
    if (statusChanged) {
      ws.serializeAttachment({ ...attachment, presenceSignature: signature });
    }
    ws.send(JSON.stringify({
      type: "presence-ack",
      ...(Number.isSafeInteger(payload.sequence) ? { sequence: payload.sequence } : {}),
      enabled: bundle.campConfig.agentId === agentId,
      activeAgentId: bundle.campConfig.agentId || null,
      cancelRequested: activeRunMissing || activeRun?.cancel_requested === 1,
      activeRunMissing
    }));
    if (statusChanged) this.ctx.waitUntil(this.publishAdminUpdate("agent-presence"));
  }

  private async markAgentOffline(agentId: string): Promise<void> {
    const heartbeat = await getHeartbeat(this.env, agentId);
    if (!heartbeat || heartbeat.status === "offline") return;
    await touchHeartbeat(this.env, {
      agentId,
      displayName: heartbeat.display_name || agentId,
      activeRunId: heartbeat.active_run_id,
      activeTaskKey: heartbeat.active_task_key &&
        TASK_KEYS.has(heartbeat.active_task_key as TaskKey)
        ? heartbeat.active_task_key as TaskKey
        : null,
      status: "offline",
      capabilities: this.parseStoredObject(heartbeat.capabilities_json),
      detail: this.parseStoredObject(heartbeat.detail_json)
    });
    await this.publishAdminUpdate("agent-offline");
  }

  private parseStoredObject(value: string | null): Record<string, unknown> {
    if (!value) return {};
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private async publishAdminUpdate(reason = "agent-log-stream"): Promise<void> {
    try {
      await this.env.LIVE_UPDATES.getByName("global").fetch(
        new Request("https://live.internal/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: ["admin"], reason })
        })
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: "agent_log_live_update_failed",
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  private async applyUpdate(
    runId: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const previousRun = await getRun(this.env, runId);
    if (!previousRun) throw new Error("Run not found");
    const state = isRunState(body.state) ? body.state : undefined;
    const run = await updateRun(this.env, {
      runId,
      state,
      message: optionalText(body.message, 1000),
      currentStep: body.currentStep === null
        ? null
        : optionalText(body.currentStep, 120),
      progress: typeof body.progress === "number" ? body.progress : undefined,
      detail: body.detail
    });
    if (!run) throw new Error("Run not found");

    const rawEvent = body.event;
    if (
      !isTerminalRunState(previousRun.state) &&
      rawEvent &&
      typeof rawEvent === "object" &&
      !Array.isArray(rawEvent)
    ) {
      const event = rawEvent as Record<string, unknown>;
      await appendRunEvent(this.env, {
        runId,
        level: isEventLevel(event.level) ? event.level : "info",
        step: optionalText(event.step, 120) ?? null,
        message: textValue(event.message, "event.message", 2000),
        detail: event.detail ?? {},
        streamEventId: optionalText(body.streamEventId, 100)
      });
    }
  }
}
