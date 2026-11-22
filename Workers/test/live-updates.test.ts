import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) {
      this.ctx = ctx;
    }
  }
}));

import { LiveUpdates } from "../src/live-updates";

describe("Durable Object live transition alarms", () => {
  afterEach(() => vi.useRealTimers());

  it("broadcasts at a scheduled boundary and retains later alarms", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-09-22T19:19:00.000Z");
    vi.setSystemTime(start);
    const values = new Map<string, unknown>();
    let alarmAt: number | null = null;
    const storage = {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      delete: vi.fn(async (key: string) => values.delete(key)),
      getAlarm: vi.fn(async () => alarmAt),
      setAlarm: vi.fn(async (value: number) => { alarmAt = value; }),
      deleteAlarm: vi.fn(async () => { alarmAt = null; })
    };
    const publicSocket = {
      deserializeAttachment: () => ({ scope: "public" }),
      send: vi.fn(),
      close: vi.fn()
    };
    const adminSocket = {
      deserializeAttachment: () => ({ scope: "admin" }),
      send: vi.fn(),
      close: vi.fn()
    };
    const ctx = {
      storage,
      getWebSockets: () => [publicSocket, adminSocket]
    };
    const durable = new LiveUpdates(ctx as never, {} as never);
    const first = start + 60_000;
    const second = start + 120_000;

    const response = await durable.fetch(new Request(
      "https://live.internal/schedule-transitions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ times: [second, first] })
      }
    ));
    expect(response.status).toBe(204);
    expect(alarmAt).toBe(first);

    vi.setSystemTime(first);
    await durable.alarm();

    expect(publicSocket.send).toHaveBeenCalledOnce();
    expect(adminSocket.send).toHaveBeenCalledOnce();
    const message = JSON.parse(String(publicSocket.send.mock.calls[0]?.[0]));
    expect(message).toMatchObject({
      type: "data-changed",
      scopes: ["public", "admin"],
      reason: "time_boundary",
      at: new Date(first).toISOString()
    });
    expect(alarmAt).toBe(second);
  });
});
