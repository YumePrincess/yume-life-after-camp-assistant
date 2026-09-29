import { delay } from "./process.mjs";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

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

class AgentControlStream {
  constructor(api, callbacks = {}) {
    this.api = api;
    this.callbacks = callbacks;
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.reconnectTimer = null;
    this.connectionTimer = null;
    this.reconnectAttempt = 0;
    this.presenceSequence = 0;
    this.presenceWaiters = new Map();
    this.commandAckWaiters = new Map();
  }

  start() {
    this.connect();
    return this;
  }

  connect() {
    const WebSocketCtor = globalThis.WebSocket;
    const connecting = typeof WebSocketCtor === "function" &&
      this.socket?.readyState === WebSocketCtor.CONNECTING;
    const open = typeof WebSocketCtor === "function" &&
      this.socket?.readyState === WebSocketCtor.OPEN;
    if (
      this.closed ||
      connecting ||
      open ||
      this.reconnectTimer
    ) return;
    if (typeof WebSocketCtor !== "function") {
      this.notify("onError", new Error("当前 Node.js 运行时不支持 WebSocket Agent 控制通道"));
      this.scheduleReconnect();
      return;
    }
    const query = new URLSearchParams({ channel: "control", agentId: this.api.agentId });
    this.socket = null;
    this.connected = false;
    let socket;
    try {
      socket = new WebSocketCtor(
        `${this.api.websocketBaseUrl}/api/agent/run-stream?${query}`,
        ["mrzh-agent-stream", websocketTokenProtocol(this.api.token)]
      );
    } catch (error) {
      this.notify("onError", error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.connectionTimer = setTimeout(() => {
      if (this.socket === socket && !this.connected) {
        this.forceReconnect("control WebSocket handshake timed out");
      }
    }, 15_000);
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.notify("onOpen");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let payload;
      try {
        payload = JSON.parse(String(event.data || ""));
      } catch {
        return;
      }
      if (payload?.type === "ready") {
        this.notify("onReady", payload);
      } else if (payload?.type === "command") {
        this.notify("onCommand", payload.command);
      } else if (payload?.type === "command-available") {
        this.notify("onCommandAvailable");
      } else if (payload?.type === "presence-ack") {
        const waiter = this.presenceWaiters.get(payload.sequence);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.presenceWaiters.delete(payload.sequence);
          waiter.resolve(payload);
        }
        this.notify("onPresenceAck", payload);
      } else if (payload?.type === "command-ack") {
        const key = `${payload.commandId}:${payload.leaseToken || ""}`;
        const waiter = this.commandAckWaiters.get(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.commandAckWaiters.delete(key);
          waiter.resolve(payload);
        }
      } else if (payload?.type === "error") {
        this.notify("onError", new Error(`Agent control stream: ${payload.message || "server rejected message"}`));
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
      this.connected = false;
      this.socket = null;
      this.resolvePresenceWaiters();
      this.resolveCommandAckWaiters();
      if (this.closed) return;
      this.notify("onDisconnect", {
        code: event?.code ?? null,
        reason: event?.reason || "",
        wasClean: event?.wasClean ?? false
      });
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.notify("onError", new Error("Agent control WebSocket transport error"));
      this.forceReconnect("control WebSocket transport error");
    });
  }

  sendPresence(payload) {
    const sequence = ++this.presenceSequence;
    return this.send({ type: "presence", sequence, ...payload });
  }

  acknowledgeCommand(command) {
    if (!this.connected || !this.socket) return Promise.resolve(null);
    const commandId = command?.id;
    const leaseToken = command?.leaseToken;
    const key = `${commandId}:${leaseToken || ""}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.commandAckWaiters.delete(key);
        resolve(null);
      }, 3_000);
      this.commandAckWaiters.set(key, { resolve, timer });
      if (!this.send({ type: "command-received", commandId, leaseToken })) {
        clearTimeout(timer);
        this.commandAckWaiters.delete(key);
        resolve(null);
      }
    });
  }

  deferCommand(command) {
    return this.send({
      type: "command-deferred",
      commandId: command?.id,
      leaseToken: command?.leaseToken
    });
  }

  sendPresenceAndWait(payload, timeoutMs = 2_000) {
    const sequence = ++this.presenceSequence;
    return new Promise((resolve) => {
      if (!this.connected || !this.socket) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        this.presenceWaiters.delete(sequence);
        resolve(null);
      }, timeoutMs);
      this.presenceWaiters.set(sequence, { resolve, timer });
      if (!this.send({ type: "presence", sequence, ...payload })) {
        clearTimeout(timer);
        this.presenceWaiters.delete(sequence);
        resolve(null);
      }
    });
  }

  forceReconnect(reason = "control stream health check failed") {
    if (this.closed) return false;

    // A half-open TCP/WebSocket can keep readyState at OPEN without delivering
    // command notifications or presence acknowledgements. Detach it before
    // closing so the reconnect timer can always create a fresh socket even if
    // the old transport never dispatches its close event.
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.resolvePresenceWaiters();
    this.resolveCommandAckWaiters();
    try {
      socket?.close(4000, String(reason).slice(0, 120));
    } catch {
      // The connection is already unusable; the scheduled fresh connection
      // below is the recovery path.
    }
    this.notify("onDisconnect", { reason });
    this.scheduleReconnect();
    return true;
  }

  send(payload) {
    if (!this.connected || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      this.forceReconnect("control WebSocket send failed");
      return false;
    }
  }

  notify(name, value) {
    try {
      this.callbacks[name]?.(value);
    } catch (error) {
      this.callbacks.onError?.(error);
    }
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    // Retry quickly after a short drop, then back off during longer outages so
    // reconnect handshakes do not become an unbounded Worker/DO request stream.
    const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** this.reconnectAttempt);
    const attempt = this.reconnectAttempt + 1;
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 9);
    this.notify("onReconnectScheduled", { attempt, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  resolvePresenceWaiters() {
    for (const [sequence, waiter] of this.presenceWaiters) {
      clearTimeout(waiter.timer);
      this.presenceWaiters.delete(sequence);
      waiter.resolve(null);
    }
  }

  resolveCommandAckWaiters() {
    for (const [key, waiter] of this.commandAckWaiters) {
      clearTimeout(waiter.timer);
      this.commandAckWaiters.delete(key);
      waiter.resolve(null);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    this.resolvePresenceWaiters();
    this.resolveCommandAckWaiters();
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }
}

class RunLogStream {
  constructor(api, runId, signal) {
    this.api = api;
    this.runId = runId;
    this.signal = signal;
    this.spoolPath = resolve(api.logOutboxDirectory, `${safePathPart(runId)}.jsonl`);
    this.ackPath = `${this.spoolPath}.ack`;
    this.pending = [];
    this.inflight = [];
    this.sequence = 0;
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.reconnectTimer = null;
    this.flushTimer = null;
    this.flushWaiters = [];
    this.persistQueue = Promise.resolve();
    this.acknowledgedSequence = 0;
    this.spoolAvailable = true;
    this.ready = this.loadOutbox().catch((error) => {
      this.spoolAvailable = false;
      console.error(JSON.stringify({
        event: "run_log_outbox_unavailable",
        runId: this.runId,
        message: String(error?.message || error)
      }));
    });
    this.onAbort = () => this.close(new Error("run log stream aborted"));
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  start() {
    this.connect();
    return this;
  }

  send(update) {
    if (this.closed) return Promise.reject(new Error("run log stream is closed"));
    const operation = this.persistQueue.then(async () => {
      await this.ready;
      const entry = {
        sequence: ++this.sequence,
        streamEventId: randomUUID(),
        update
      };
      this.pending.push(entry);
      if (this.spoolAvailable) {
        try {
          await mkdir(this.api.logOutboxDirectory, { recursive: true, mode: 0o700 });
          await appendFile(
            this.spoolPath,
            `${JSON.stringify(entry)}\n`,
            { encoding: "utf8", mode: 0o600 }
          );
        } catch (error) {
          this.spoolAvailable = false;
          console.error(JSON.stringify({
            event: "run_log_outbox_write_failed",
            runId: this.runId,
            sequence: entry.sequence,
            message: String(error?.message || error)
          }));
        }
      }
      this.scheduleFlush();
      return { ok: true };
    });
    this.persistQueue = operation.then(() => undefined);
    this.connect();
    return operation;
  }

  async flushAndWait(timeoutMs = 30_000) {
    await this.persistQueue;
    if (this.closed) {
      return Promise.reject(new Error("run log stream is closed"));
    }
    if (!this.pending.length && !this.inflight.length) {
      return Promise.resolve({ ok: true });
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(waiter.timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: setTimeout(() => {
          this.flushWaiters = this.flushWaiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`run log stream ACK timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      };
      this.flushWaiters.push(waiter);
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
      void this.ready
        .then(() => this.scheduleFlush())
        .catch((error) => this.failPending(error));
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
        this.inflight = this.inflight.filter(
          (entry) => entry.sequence > payload.sequence
        );
        this.acknowledgedSequence = Math.max(this.acknowledgedSequence, payload.sequence);
        this.persistQueue = this.persistQueue
          .then(() => this.persistAcknowledgement())
          .then(() => this.resolveFlushWaitersIfIdle())
          .then(() => this.scheduleFlush())
          .catch((error) => this.failPending(error));
      } else if (payload?.type === "error") {
        const message = new Error(`run log stream: ${payload.message || "server rejected update"}`);
        // A validation/database error is not recoverable by replaying the same
        // frame. Stop this stream so the task can finish through the control
        // plane without silently looping on a bad payload. Preserve the
        // rejected journal as a local dead letter instead of replaying it on
        // every later process start.
        this.close(message);
        this.pending = [];
        this.inflight = [];
        void this.persistQueue
          .catch(() => undefined)
          .then(() => this.archiveRejectedOutbox(payload.message || "server rejected update"))
          .catch(() => undefined);
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
    const waiters = this.flushWaiters.splice(0);
    waiters.forEach(({ reject }) => reject(error));
  }

  async loadOutbox() {
    await mkdir(this.api.logOutboxDirectory, { recursive: true, mode: 0o700 });
    const [journal, checkpoint] = await Promise.all([
      readFile(this.spoolPath, "utf8").catch((error) =>
        error?.code === "ENOENT" ? "" : Promise.reject(error)
      ),
      readFile(this.ackPath, "utf8").catch((error) =>
        error?.code === "ENOENT" ? "0" : Promise.reject(error)
      )
    ]);
    this.acknowledgedSequence = Math.max(0, Number(checkpoint.trim()) || 0);
    const recovered = journal.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return Number.isSafeInteger(entry?.sequence) &&
          entry.sequence > this.acknowledgedSequence &&
          typeof entry?.streamEventId === "string" &&
          entry.update && typeof entry.update === "object"
          ? [entry]
          : [];
      } catch {
        return [];
      }
    });
    this.pending.unshift(...recovered);
    this.sequence = Math.max(this.sequence, this.acknowledgedSequence);
    for (const entry of recovered) {
      this.sequence = Math.max(this.sequence, entry.sequence);
    }
  }

  async persistAcknowledgement() {
    await mkdir(this.api.logOutboxDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.ackPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${this.acknowledgedSequence}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.ackPath);
  }

  async cleanupOutboxIfIdle() {
    if (this.pending.length || this.inflight.length || this.flushWaiters.length) return;
    await Promise.all([
      unlink(this.spoolPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
      unlink(this.ackPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      })
    ]);
  }

  async archiveRejectedOutbox(reason) {
    const rejectedPath = `${this.spoolPath}.rejected-${Date.now()}`;
    await rename(this.spoolPath, rejectedPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await rename(this.ackPath, `${rejectedPath}.ack`).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await writeFile(`${rejectedPath}.reason`, `${String(reason)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
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
    if (!error && !this.pending.length && !this.inflight.length) {
      void this.persistQueue.then(() => this.cleanupOutboxIfIdle()).catch(() => undefined);
    }
  }
}

function safePathPart(value) {
  const result = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return result || "unknown-run";
}

export class AgentApi {
  constructor(config) {
    this.baseUrl = config.server.baseUrl.replace(/\/+$/, "");
    this.websocketBaseUrl = this.baseUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
    this.token = config.server.agentToken;
    this.agentId = config.server.agentId;
    this.displayName = config.server.agentName || this.agentId;
    this.logOutboxDirectory = resolve(
      homedir(),
      "Library/Application Support/Yume Life After Mac Agent/RunLogOutbox"
    );
    this.runStreams = new Map();
    this.controlStream = null;
  }

  async request(
    path,
    body,
    signal,
    { maximumAttempts = 1, timeoutMs = 30_000 } = {}
  ) {
    let response;
    let payload = {};
    let lastNetworkError;
    const attempts = Math.max(1, Math.min(4, Number(maximumAttempts) || 1));
    const requestTimeoutMs = Math.max(1_000, Number(timeoutMs) || 30_000);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason || new Error("Agent request aborted");

      const requestController = new AbortController();
      const forwardAbort = () => requestController.abort(signal.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      let requestTimedOut = false;
      const timeout = setTimeout(() => {
        requestTimedOut = true;
        requestController.abort(new Error(`Request timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      let shouldRetry = false;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal: requestController.signal
        });
        payload = await response.json().catch((error) => {
          if (requestTimedOut || signal?.aborted) throw error;
          return {};
        });
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastNetworkError = requestTimedOut
          ? Object.assign(
              new Error(`Request timed out after ${requestTimeoutMs}ms`),
              { code: "YUME_REQUEST_TIMEOUT", cause: error }
            )
          : error;
        response = null;
        shouldRetry = attempt < attempts && isTransientNetworkError(lastNetworkError);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", forwardAbort);
      }
      if (!shouldRetry) break;
      await delay(attempt * 500, signal);
    }
    if (!response) {
      throw new Error(formatNetworkError(path, lastNetworkError, attempts));
    }
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

  startControlStream(callbacks = {}) {
    this.closeControlStream();
    this.controlStream = new AgentControlStream(this, callbacks).start();
    return this.controlStream;
  }

  closeControlStream() {
    this.controlStream?.close();
    this.controlStream = null;
  }

  nextCommand(busy, localeOrSignal, maybeSignal) {
    // Keep the old two-argument shape working for diagnostic scripts and
    // third-party local callers while the Agent now sends its UI locale.
    const hasLocale = typeof localeOrSignal === "string";
    const locale = hasLocale ? localeOrSignal : undefined;
    const signal = hasLocale ? maybeSignal : localeOrSignal;
    return this.request(
      "/api/agent/next-command",
      { agentId: this.agentId, busy, locale },
      signal,
      { maximumAttempts: 2, timeoutMs: 15_000 }
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
  const code = error?.code || error?.cause?.code;
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_REQUEST_TIMEOUT",
    "UND_ERR_SOCKET",
    "YUME_REQUEST_TIMEOUT"
  ].includes(code) || error?.name === "TimeoutError";
}

function formatNetworkError(path, error, attempts) {
  const cause = error?.cause;
  const code = error?.code || cause?.code;
  const endpoint = cause?.hostname
    ? `${cause.hostname}${cause.port ? `:${cause.port}` : ""}`
    : null;
  const retry = attempts > 1 ? `，已自动尝试 ${attempts} 次` : "";
  if (code === "YUME_REQUEST_TIMEOUT") {
    return `${path}: 请求超过时限，${retry || "已等待"}`;
  }
  if (code === "ECONNRESET" && Number(cause?.port) === 443) {
    return `${path}: HTTPS 连接被远端临时重置${retry}（ECONNRESET，端口 443；这不是 HTTP 443 状态码）`;
  }
  const details = [code, endpoint].filter(Boolean).join("，");
  return `${path}: ${error?.message || "Network request failed"}${retry}${
    details ? `（${details}）` : ""
  }`;
}
