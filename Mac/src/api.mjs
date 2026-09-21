import { delay } from "./process.mjs";
import { randomUUID } from "node:crypto";

const TERMINAL_RUN_STATES = new Set([
  "interrupted",
  "succeeded",
  "partially_succeeded",
  "failed",
  "timed_out",
  "skipped"
]);

function websocketTokenProtocol(token) {
  return `mrzh-agent-token.${Buffer.from(String(token), "utf8").toString("base64url")}`;
}

class RunLogStream {
  constructor(api, runId, signal) {
    this.api = api;
    this.runId = runId;
    this.signal = signal;
    this.pending = [];
    this.inflight = [];
    this.sequence = 0;
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.flushTimer = null;
    this.flushWaiters = [];
    this.onAbort = () => this.close(new Error("run log stream aborted"));
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  start() {
    this.connect();
    return this;
  }

  send(update) {
    if (this.closed) return Promise.reject(new Error("run log stream is closed"));
    this.pending.push({
      sequence: ++this.sequence,
      streamEventId: randomUUID(),
      update
    });
    this.connect();
    this.scheduleFlush();
    // Preserve ordering in the task queue, but wait for persistence only once
    // before the terminal HTTP update instead of doing one ack round-trip per
    // log entry.
    return Promise.resolve({ ok: true });
  }

  flushAndWait() {
    if (this.closed) {
      return Promise.reject(new Error("run log stream is closed"));
    }
    if (!this.pending.length && !this.inflight.length) {
      return Promise.resolve({ ok: true });
    }
    return new Promise((resolve, reject) => {
      this.flushWaiters.push({ resolve, reject });
      this.connect();
      this.scheduleFlush();
    });
  }

  connect() {
    const WebSocketCtor = globalThis.WebSocket;
    if (
      this.closed ||
      this.connected ||
      this.socket?.readyState === WebSocketCtor?.CONNECTING ||
      this.reconnectTimer
    ) return;
    if (typeof WebSocketCtor !== "function") {
      this.failPending(new Error("当前 Node.js 运行时不支持 WebSocket 日志流"));
      return;
    }
    const socket = new WebSocketCtor(
      `${this.api.websocketBaseUrl}/api/agent/run-stream`,
      ["mrzh-agent-stream", websocketTokenProtocol(this.api.token)]
    );
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.scheduleFlush();
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let payload;
      try {
        payload = JSON.parse(String(event.data || ""));
      } catch {
        return;
      }
      if (payload?.type === "ack" && Number.isSafeInteger(payload.sequence)) {
        const acknowledged = this.inflight.filter(
          (entry) => entry.sequence <= payload.sequence
        );
        this.inflight = this.inflight.filter(
          (entry) => entry.sequence > payload.sequence
        );
        this.resolveFlushWaitersIfIdle();
        this.scheduleFlush();
      } else if (payload?.type === "error") {
        const message = new Error(`run log stream: ${payload.message || "server rejected update"}`);
        // A validation/database error is not recoverable by replaying the same
        // frame. Stop this stream so the task can finish through the control
        // plane without silently looping on a bad payload.
        this.close(message);
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = null;
      if (this.closed) return;
      this.pending.unshift(...this.inflight.splice(0));
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) socket.close();
    });
  }

  flush() {
    if (!this.connected || !this.socket || this.inflight.length || !this.pending.length) return;
    const batch = this.pending.splice(0, 50);
    this.inflight = batch;
    try {
      this.socket.send(JSON.stringify({
        type: "run-update-batch",
        runId: this.runId,
        sequence: batch[batch.length - 1].sequence,
        updates: batch.map((entry) => ({
          ...entry.update,
          streamEventId: entry.streamEventId
        }))
      }));
    } catch {
      this.pending.unshift(...this.inflight.splice(0));
      this.socket.close();
    }
  }

  scheduleFlush() {
    if (this.closed || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 25);
  }

  resolveFlushWaitersIfIdle() {
    if (this.pending.length || this.inflight.length || !this.flushWaiters.length) return;
    const waiters = this.flushWaiters.splice(0);
    waiters.forEach(({ resolve }) => resolve({ ok: true }));
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 5);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  failPending(error) {
    this.pending = [];
    this.inflight = [];
    const waiters = this.flushWaiters.splice(0);
    waiters.forEach(({ reject }) => reject(error));
  }

  close(error = null) {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.failPending(error || new Error("run log stream closed"));
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }
}

export class AgentApi {
  constructor(config) {
    this.baseUrl = config.server.baseUrl.replace(/\/+$/, "");
    this.websocketBaseUrl = this.baseUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
    this.token = config.server.agentToken;
    this.agentId = config.server.agentId;
    this.displayName = config.server.agentName || this.agentId;
    this.runStreams = new Map();
  }

  async request(path, body, signal, { maximumAttempts = 1 } = {}) {
    let response;
    let lastNetworkError;
    const attempts = Math.max(1, Math.min(4, Number(maximumAttempts) || 1));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal
        });
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastNetworkError = error;
        if (attempt >= attempts || !isTransientNetworkError(error)) break;
        await delay(attempt * 500, signal);
      }
    }
    if (!response) {
      throw new Error(formatNetworkError(path, lastNetworkError, attempts));
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = payload.code ? ` [${payload.code}]` : "";
      throw new Error(
        `${path}: ${payload.error || `HTTP ${response.status}`}${code}`
      );
    }
    return payload;
  }

  heartbeat(input, signal) {
    return this.request(
      "/api/agent/heartbeat",
      { agentId: this.agentId, displayName: this.displayName, ...input },
      signal,
      { maximumAttempts: 3 }
    );
  }

  nextCommand(busy, localeOrSignal, maybeSignal, manualActive = false) {
    // Keep the old two-argument shape working for diagnostic scripts and
    // third-party local callers while the Agent now sends its UI locale.
    const hasLocale = typeof localeOrSignal === "string";
    const locale = hasLocale ? localeOrSignal : undefined;
    const signal = hasLocale ? maybeSignal : localeOrSignal;
    return this.request(
      "/api/agent/next-command",
      { agentId: this.agentId, busy, manualActive: manualActive === true, locale },
      signal
    );
  }

  bootstrap(runId, signal) {
    return this.request(
      "/api/agent/bootstrap",
      { agentId: this.agentId, runId },
      signal,
      { maximumAttempts: 3 }
    );
  }

  updateRun(runId, update, signal) {
    const stream = this.runStreams.get(runId);
    if (stream && !TERMINAL_RUN_STATES.has(update?.state)) {
      return stream.send(update);
    }
    return this.request(
      "/api/agent/run-update",
      { runId, ...update },
      signal,
      { maximumAttempts: 4 }
    );
  }

  startRunStream(runId, signal) {
    this.closeRunStream(runId);
    const stream = new RunLogStream(this, runId, signal).start();
    this.runStreams.set(runId, stream);
    return stream;
  }

  closeRunStream(runId, error = null) {
    const stream = this.runStreams.get(runId);
    if (!stream) return;
    this.runStreams.delete(runId);
    stream.close(error);
  }

  flushRunStream(runId) {
    const stream = this.runStreams.get(runId);
    return stream ? stream.flushAndWait() : Promise.resolve({ ok: true });
  }

  snapshot(runId, type, payload, capturedAt, signal, metadata = {}) {
    return this.request(
      "/api/agent/snapshot",
      { runId, type, payload, capturedAt, ...metadata },
      signal,
      { maximumAttempts: 3 }
    );
  }

  completeCommand(command, state, message, signal) {
    return this.request(
      "/api/agent/complete-command",
      {
        commandId: command.id,
        leaseToken: command.leaseToken,
        state,
        message
      },
      signal,
      { maximumAttempts: 4 }
    );
  }
}

function isTransientNetworkError(error) {
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(error?.cause?.code);
}

function formatNetworkError(path, error, attempts) {
  const cause = error?.cause;
  const code = cause?.code;
  const endpoint = cause?.hostname
    ? `${cause.hostname}${cause.port ? `:${cause.port}` : ""}`
    : null;
  const retry = attempts > 1 ? `，已自动尝试 ${attempts} 次` : "";
  if (code === "ECONNRESET" && Number(cause?.port) === 443) {
    return `${path}: HTTPS 连接被远端临时重置${retry}（ECONNRESET，端口 443；这不是 HTTP 443 状态码）`;
  }
  const details = [code, endpoint].filter(Boolean).join("，");
  return `${path}: ${error?.message || "Network request failed"}${retry}${
    details ? `（${details}）` : ""
  }`;
}
