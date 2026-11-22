import { validateSession, syncIdentityChatUsers } from "../session.js";
import { activeUserSql } from "../user-status.js";
import {
  isVerifiedInternalRequest,
  parseVerifiedUserId,
} from "../verified-identity.js";

const CHECK_INTERVAL = 30_000;
const CONNECTION_TIMEOUT = 75_000;
export const DIRECTORY_MARKER = "identity-directory";

// One named ChatInbox instance owns the directory and presence of this camp.
// Socket attachments restore authenticated connections after DO hibernation.
export class IdentityDirectory {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set(
      state
        .getWebSockets()
        .filter((ws) => ws.deserializeAttachment()?.kind === DIRECTORY_MARKER),
    );
    this.fingerprint = null;
    this.pending = Promise.resolve();
  }

  refresh(changed = false) {
    const task = this.pending.catch(() => {}).then(() => this.publish(changed));
    this.pending = task;
    return task;
  }

  async publish(changed) {
    await syncIdentityChatUsers(this.env);
    const { results } = await this.env.DB.prepare(
      `SELECT id,username,display_name,avatar_url FROM users WHERE deleted_at IS NULL AND ${activeUserSql()} ORDER BY id`,
    ).all();
    const fingerprint = JSON.stringify(results);
    const directoryChanged = changed || this.fingerprint !== fingerprint;
    this.fingerprint = fingerprint;
    const online = new Set();
    const valid = [];
    const checked = new Map();
    for (const ws of this.sockets) {
      try {
        const meta = ws.deserializeAttachment();
        let auth = checked.get(meta.token);
        if (!auth) {
          auth = await validateSession(this.env, meta.token);
          checked.set(meta.token, auth);
        }
        if (!auth.ok || auth.session.userId !== meta.userId) {
          ws.close(1008, "Identity session expired");
          this.sockets.delete(ws);
          continue;
        }
        if (
          ws.readyState !== 1 ||
          Date.now() - meta.seenAt > CONNECTION_TIMEOUT
        ) {
          ws.close(1001, "Presence heartbeat expired");
          this.sockets.delete(ws);
          continue;
        }
        online.add(auth.session.userId);
        valid.push(ws);
      } catch {
        this.sockets.delete(ws);
      }
    }
    const packet = JSON.stringify({
      protocolVersion: 1,
      type: "directory_changed",
      directoryChanged,
      onlineUserIds: [...online],
      at: Date.now(),
    });
    for (const ws of valid) {
      try {
        ws.send(packet);
      } catch {
        this.sockets.delete(ws);
      }
    }
    if (this.sockets.size) {
      // Schedule at the next identity expiry, including members who never opened chat.
      const next = await this.env.DB.prepare(
        "SELECT min(datetime(expires_at)) AS expiry FROM identity_codes WHERE status='active' AND datetime(expires_at)>CURRENT_TIMESTAMP",
      ).first();
      const expiry = next?.expiry
        ? Date.parse(next.expiry.replace(" ", "T") + "Z")
        : NaN;
      const alarm = Number.isFinite(expiry)
        ? Math.min(Date.now() + CHECK_INTERVAL, expiry + 100)
        : Date.now() + CHECK_INTERVAL;
      await this.state.storage.setAlarm(alarm);
    } else await this.state.storage.deleteAlarm();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/directory/change" && request.method === "POST") {
      if (!isVerifiedInternalRequest(request))
        return new Response("Unauthorized", { status: 401 });
      await this.state.storage.put(DIRECTORY_MARKER, true);
      await this.refresh(true);
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/directory/connect")
      return new Response("Not Found", { status: 404 });
    const userId = parseVerifiedUserId(request);
    const token = url.searchParams.get("token") || "";
    const auth = await validateSession(this.env, token);
    if (!userId || !auth.ok || auth.session.userId !== userId)
      return new Response("Unauthorized", { status: 401 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected websocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      kind: DIRECTORY_MARKER,
      userId,
      token,
      seenAt: Date.now(),
    });
    this.sockets.add(server);
    await this.state.storage.put(DIRECTORY_MARKER, true);
    await this.refresh();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 128) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data?.type !== "ping") return; // Clients never choose their own identity or status.
    const meta = ws.deserializeAttachment();
    const auth = await validateSession(this.env, meta?.token || "");
    if (!auth.ok || auth.session.userId !== meta?.userId) {
      ws.close(1008, "Identity session expired");
      this.sockets.delete(ws);
      await this.refresh(true);
      return;
    }
    ws.serializeAttachment({ ...meta, seenAt: Date.now() });
    ws.send(
      JSON.stringify({ protocolVersion: 1, type: "directory_heartbeat" }),
    );
  }

  async disconnect(ws) {
    this.sockets.delete(ws);
    await this.refresh();
  }
}
