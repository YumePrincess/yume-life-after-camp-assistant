import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }
}));

vi.mock("../src/db", () => ({
  appendRunEvent: vi.fn(),
  getConfigBundle: vi.fn(),
  getHeartbeat: vi.fn(),
  getRun: vi.fn(),
  hasAvailableCommand: vi.fn(async () => true),
  touchHeartbeat: vi.fn(),
  updateRun: vi.fn()
}));

vi.mock("../src/agent-command-dispatch", () => ({
  claimAgentCommand: vi.fn(async () => ({
    command: {
      id: "command-1",
      runId: null,
      type: "interrupt_task",
      payload: { runId: "run-1" },
      leaseToken: "lease-1",
      attemptCount: 1
    }
  }))
}));

import { AgentLogStream } from "../src/agent-log-stream";

describe("Agent command WebSocket notifications", () => {
  it("wakes only control sockets belonging to the targeted Agent", async () => {
    const activeAgentSocket = {
      deserializeAttachment: () => ({ channel: "control", agentId: "mac-main" }),
      serializeAttachment: vi.fn(),
      send: vi.fn()
    };
    const standbyAgentSocket = {
      deserializeAttachment: () => ({ channel: "control", agentId: "mac-standby" }),
      serializeAttachment: vi.fn(),
      send: vi.fn()
    };
    const taskLogSocket = {
      deserializeAttachment: () => ({ channel: "logs", agentId: "mac-main" }),
      serializeAttachment: vi.fn(),
      send: vi.fn()
    };
    const ctx = {
      getWebSockets: () => [activeAgentSocket, standbyAgentSocket, taskLogSocket],
      storage: {
        setAlarm: vi.fn(async () => undefined),
        deleteAlarm: vi.fn(async () => undefined)
      }
    };
    const stream = new AgentLogStream(ctx as never, {} as never);

    const response = await stream.fetch(new Request("https://agent.internal/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "command-available", agentId: "mac-main" })
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, notified: 1 });
    expect(activeAgentSocket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "command",
      command: {
        id: "command-1",
        runId: null,
        type: "interrupt_task",
        payload: { runId: "run-1" },
        leaseToken: "lease-1",
        attemptCount: 1
      }
    }));
    expect(standbyAgentSocket.send).not.toHaveBeenCalled();
    expect(taskLogSocket.send).not.toHaveBeenCalled();
  });
});
