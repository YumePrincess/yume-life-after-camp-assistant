import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, recordRateLimitAttempt } from "../src/rate-limit";

const request = new Request("https://example.test/api", {
  headers: { "CF-Connecting-IP": "203.0.113.9" }
});
const policy = {
  scope: "test-limit",
  maximum: 5,
  windowSeconds: 6 * 60 * 60,
  blockSeconds: 6 * 60 * 60
};

function fakeEnv(row: { attempts: number; window_started_at: string; blocked_until: string | null }) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const env = {
    SESSION_SECRET: "rate-limit-test-secret-at-least-32-characters-long",
    DB: {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            this.params = params;
            return this;
          },
          async first() {
            return row;
          },
          async run() {
            writes.push({ sql, params: this.params });
            return {};
          }
        };
        return statement;
      }
    }
  } as unknown as Env;
  return { env, writes };
}

describe("rate-limit lockout bounds", () => {
  afterEach(() => vi.useRealTimers());

  it("shortens persisted six-hour blocks to at most 15 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    const now = Date.now();
    const { env, writes } = fakeEnv({
      attempts: 5,
      window_started_at: new Date(now).toISOString(),
      blocked_until: new Date(now + 6 * 60 * 60 * 1000).toISOString()
    });

    await expect(checkRateLimit(request, env, policy)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 15 * 60
    });
    expect(writes[0]?.sql).toContain("UPDATE public_rate_limits SET blocked_until");
    expect(writes[0]?.params[0]).toBe(
      new Date(now + 15 * 60 * 1000).toISOString()
    );
  });

  it("does not retain legacy six-hour attempt windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    const now = Date.now();
    const { env } = fakeEnv({
      attempts: 5,
      window_started_at: new Date(now - 16 * 60 * 1000).toISOString(),
      blocked_until: null
    });

    await expect(checkRateLimit(request, env, policy)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0
    });
  });

  it("caps newly recorded blocks and windows to 15 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    const now = Date.now();
    const { env, writes } = fakeEnv({
      attempts: 4,
      window_started_at: new Date(now).toISOString(),
      blocked_until: null
    });

    await expect(recordRateLimitAttempt(request, env, policy)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 15 * 60
    });
    expect(writes[0]?.params[4]).toBe(
      new Date(now + 15 * 60 * 1000).toISOString()
    );
  });
});
