import { DurableObject } from "cloudflare:workers";

export type LiveUpdateScope = "public" | "admin";

export interface LiveConnectionAttachment {
  scope: LiveUpdateScope;
  connectedAt: number;
}

export interface LiveUpdateMessage {
  type: "data-changed";
  scopes: LiveUpdateScope[];
  reason: string;
  at: string;
}

const BROADCAST_PATH = "/broadcast";
const TRANSITIONS_PATH = "/schedule-transitions";
const TRANSITIONS_STORAGE_KEY = "live-vote-transition-times";
const MAX_TRANSITIONS = 20_000;
const MAX_TRANSITION_HORIZON_MS = 9 * 24 * 60 * 60_000;

function isLiveScope(value: string | null): value is LiveUpdateScope {
  return value === "public" || value === "admin";
}

function websocketUpgrade(request: Request): boolean {
  return request.method === "GET" &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

export function liveBroadcastMessage(
  value: unknown
): LiveUpdateMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const scopes = Array.isArray(source.scopes)
    ? [...new Set(source.scopes.filter((scope): scope is LiveUpdateScope =>
        scope === "public" || scope === "admin"
      ))]
    : [];
  const reason = typeof source.reason === "string" && source.reason.trim()
    ? source.reason.trim().slice(0, 120)
    : "data_changed";
  if (!scopes.length) return null;
  return {
    type: "data-changed",
    scopes,
    reason,
    at: typeof source.at === "string" && source.at
      ? source.at
      : new Date().toISOString()
  };
}

export class LiveUpdates extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === BROADCAST_PATH) {
      return this.broadcast(request);
    }
    if (request.method === "POST" && url.pathname === TRANSITIONS_PATH) {
      return this.scheduleTransitions(request);
    }

    if (!websocketUpgrade(request)) {
      return new Response("WebSocket upgrade required", {
        status: 426,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const scope = url.searchParams.get("scope");
    if (!isLiveScope(scope)) {
      return new Response("Invalid WebSocket scope", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: LiveConnectionAttachment = {
      scope,
      connectedAt: Date.now()
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({
      type: "ready",
      scope,
      at: new Date().toISOString()
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string"
      ? message
      : new TextDecoder().decode(message);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if ((value as Record<string, unknown>).type !== "ping") return;
    ws.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string
  ): Promise<void> {
    // 1005/1006/1015 are reporting-only values and cannot be sent in a Close
    // frame. The configured Workers runtime auto-replies to peer Close frames.
    if (![1005, 1006, 1015].includes(code)) ws.close(code, reason);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const scheduled = await this.ctx.storage.get<number[]>(TRANSITIONS_STORAGE_KEY) ?? [];
    const due = scheduled.some((time) => time <= now);
    const remaining = scheduled.filter((time) => time > now);
    if (due) {
      this.broadcastMessage({
        type: "data-changed",
        scopes: ["public", "admin"],
        reason: "time_boundary",
        at: new Date(now).toISOString()
      });
    }
    if (remaining.length) {
      await this.ctx.storage.put(TRANSITIONS_STORAGE_KEY, remaining);
      await this.ctx.storage.setAlarm(remaining[0]!);
    } else {
      await this.ctx.storage.delete(TRANSITIONS_STORAGE_KEY);
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async scheduleTransitions(request: Request): Promise<Response> {
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return new Response("Invalid transition schedule", { status: 400 });
    }
    const source = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : null;
    const times = source?.times;
    if (!Array.isArray(times) || times.length > MAX_TRANSITIONS ||
      !times.every((time) => Number.isSafeInteger(time))) {
      return new Response("Invalid transition schedule", { status: 400 });
    }
    const now = Date.now();
    const future = [...new Set(times as number[])]
      .filter((time) => time > now && time <= now + MAX_TRANSITION_HORIZON_MS)
      .sort((left, right) => left - right);
    if (future.length) {
      await this.ctx.storage.put(TRANSITIONS_STORAGE_KEY, future);
      if (await this.ctx.storage.getAlarm() !== future[0]) {
        await this.ctx.storage.setAlarm(future[0]!);
      }
    } else {
      await this.ctx.storage.delete(TRANSITIONS_STORAGE_KEY);
      await this.ctx.storage.deleteAlarm();
    }
    return new Response(null, { status: 204 });
  }

  private async broadcast(request: Request): Promise<Response> {
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return new Response("Invalid broadcast payload", { status: 400 });
    }
    const message = liveBroadcastMessage(input);
    if (!message) return new Response("Invalid broadcast payload", { status: 400 });
    this.broadcastMessage(message);
    return new Response(null, { status: 204 });
  }

  private broadcastMessage(message: LiveUpdateMessage): void {
    const encoded = JSON.stringify(message);
    for (const websocket of this.ctx.getWebSockets()) {
      const attachment = websocket.deserializeAttachment() as LiveConnectionAttachment | null;
      if (!attachment || !message.scopes.includes(attachment.scope)) continue;
      try {
        websocket.send(encoded);
      } catch {
        websocket.close(1011, "Live update delivery failed");
      }
    }
  }
}
