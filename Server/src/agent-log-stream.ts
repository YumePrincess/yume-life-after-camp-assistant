import { DurableObject } from "cloudflare:workers";
import {
  appendRunEvent,
  getRun,
  updateRun
} from "./db";
import type { RunState } from "./domain";

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
    server.serializeAttachment({ connectedAt: Date.now() });
    server.send(JSON.stringify({ type: "ready", at: new Date().toISOString() }));
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
    ws.close(code, reason);
  }

  private async publishAdminUpdate(): Promise<void> {
    try {
      await this.env.LIVE_UPDATES.getByName("global").fetch(
        new Request("https://live.internal/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: ["admin"], reason: "agent-log-stream" })
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
