import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { AgentApi } from "../src/api.mjs";

test("heartbeat retries a transient HTTPS reset", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new TypeError("fetch failed", {
        cause: { code: "ECONNRESET", hostname: "lifeafter.example.com", port: 443 }
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const api = new AgentApi({
      server: {
        baseUrl: "https://lifeafter.example.com",
        agentToken: "test",
        agentId: "mac-test",
        agentName: "Test Mac"
      }
    });
    assert.deepEqual(await api.heartbeat({ status: "idle" }), { ok: true });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run updates retry transient HTTPS resets instead of interrupting a task", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 4) {
      throw new TypeError("fetch failed", {
        cause: { code: "ECONNRESET", hostname: "lifeafter.example.com", port: 443 }
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const api = new AgentApi({
      server: {
        baseUrl: "https://lifeafter.example.com",
        agentToken: "test",
        agentId: "mac-test",
        agentName: "Test Mac"
      }
    });
    assert.deepEqual(
      await api.updateRun("run-test", { currentStep: "openCampPanel" }),
      { ok: true }
    );
    assert.equal(attempts, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persistent port 443 resets are described as HTTPS transport failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: { code: "ECONNRESET", hostname: "lifeafter.example.com", port: 443 }
    });
  };
  try {
    const api = new AgentApi({
      server: {
        baseUrl: "https://lifeafter.example.com",
        agentToken: "test",
        agentId: "mac-test",
        agentName: "Test Mac"
      }
    });
    await assert.rejects(
      api.heartbeat({ status: "idle" }),
      /这不是 HTTP 443 状态码/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the run log stream stays open after task cancellation so cleanup updates reach the backend", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const sent = [];
  let httpRequests = 0;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    send(value) {
      const payload = JSON.parse(value);
      sent.push(payload);
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ type: "ack", sequence: payload.sequence })
      }));
    }

    close() {
      this.readyState = 3;
    }

    emit(type, event) {
      this.listeners.get(type)?.(event);
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async () => {
    httpRequests += 1;
    throw new Error("HTTP log fallback must not be used");
  };
  let api;
  let outboxDirectory;
  try {
    api = new AgentApi({
      server: {
        baseUrl: "https://lifeafter.example.com",
        agentToken: "agent-secret",
        agentId: "mac-test",
        agentName: "Test Mac"
      }
    });
    outboxDirectory = await mkdtemp(resolve(tmpdir(), "yla-agent-runlog-test-"));
    api.logOutboxDirectory = outboxDirectory;
    const cancellation = new AbortController();
    api.startRunStream("run-test", cancellation.signal);
    cancellation.abort(new Error("administrator requested cancellation"));
    const result = await api.updateRun("run-test", {
      currentStep: "scan",
      event: { level: "info", step: "scan", message: "扫描中" }
    });
    assert.deepEqual(result, { ok: true });
    await api.updateRun("run-test", { currentStep: "scan:page-2", progress: 0.2 });
    await api.updateRun("run-test", { currentStep: "scan:page-3", progress: 0.3 });
    await api.flushRunStream("run-test");
    assert.equal(httpRequests, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "run-update-batch");
    assert.equal(sent[0].runId, "run-test");
    assert.equal(sent[0].updates.length, 3);
    assert.equal(sent[0].updates[0].event.message, "扫描中");
  } finally {
    api?.closeRunStream("run-test");
    if (outboxDirectory) {
      await rm(outboxDirectory, { recursive: true, force: true });
    }
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("the persistent control stream authenticates, sends presence, and wakes command checks", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  const events = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url, protocols) {
      this.url = String(url);
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open", {});
        this.emit("message", { data: JSON.stringify({ type: "ready", channel: "control" }) });
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close() {
      this.readyState = 3;
      this.emit("close", {});
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const api = new AgentApi({
      server: {
        baseUrl: "https://lifeafter.example.com",
        agentToken: "agent-secret",
        agentId: "mac-test",
        agentName: "Test Mac"
      }
    });
    const stream = api.startControlStream({
      onOpen: () => events.push("open"),
      onReady: ({ channel }) => events.push(channel),
      onCommandAvailable: () => events.push("wake"),
      onPresenceAck: ({ enabled }) => events.push(enabled ? "enabled" : "disabled")
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1);
    assert.match(sockets[0].url, /channel=control/);
    assert.match(sockets[0].url, /agentId=mac-test/);
    assert.deepEqual(sockets[0].protocols, [
      "mrzh-agent-stream",
      `mrzh-agent-token.${Buffer.from("agent-secret").toString("base64url")}`
    ]);
    assert.equal(stream.sendPresence({
      agentId: "mac-test",
      status: "idle",
      activeRunId: null
    }), true);
    assert.deepEqual(sockets[0].sent[0], {
      type: "presence",
      sequence: 1,
      agentId: "mac-test",
      status: "idle",
      activeRunId: null
    });
    sockets[0].emit("message", { data: JSON.stringify({ type: "command-available" }) });
    sockets[0].emit("message", { data: JSON.stringify({
      type: "presence-ack",
      sequence: 1,
      enabled: true
    }) });
    assert.deepEqual(events, ["open", "control", "wake", "enabled"]);
    api.closeControlStream();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
