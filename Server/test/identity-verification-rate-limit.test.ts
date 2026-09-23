import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IdentityVerificationSendLimitError,
  reserveIdentityVerificationSend
} from "../src/identity-verification-rate-limit";

function createEnv() {
  const events = new Map<string, string[]>();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const env = {
    SESSION_SECRET: "verification-send-limit-test-secret-at-least-32-characters",
    DB: {
      prepare(sql: string) {
        const statement = {
          sql,
          params: [] as unknown[],
          bind(...params: unknown[]) {
            this.params = params;
            return this;
          }
        };
        return statement;
      },
      async batch(batchStatements: typeof statements) {
        statements.push(...batchStatements);
        const insert = batchStatements[1];
        const subjectHash = String(insert?.params[1] || "");
        const timestamp = String(insert?.params[2] || "");
        const hourWindowStart = String(insert?.params[4] || "");
        const hourLimit = Number(insert?.params[5]);
        const minuteWindowStart = String(insert?.params[7] || "");
        const minuteLimit = Number(insert?.params[8]);
        const subjectEvents = events.get(subjectHash) || [];
        const recentHourEvents = subjectEvents.filter(time => time > hourWindowStart);
        const recentMinuteEvents = subjectEvents.filter(time => time > minuteWindowStart);
        const inserted = recentHourEvents.length < hourLimit && recentMinuteEvents.length < minuteLimit;
        if (inserted) {
          subjectEvents.push(timestamp);
          events.set(subjectHash, subjectEvents);
        }
        return [{ meta: { changes: 0 } }, { meta: { changes: inserted ? 1 : 0 } }];
      }
    }
  } as unknown as Env;
  return { env, statements };
}

describe("identity verification send limit", () => {
  afterEach(() => vi.useRealTimers());

  it("allows five sends per identity across verification flows and rejects the sixth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    const { env, statements } = createEnv();

    for (let send = 0; send < 5; send += 1) {
      if (send > 0) vi.advanceTimersByTime(60 * 1000);
      await reserveIdentityVerificationSend(env, {
        identityCodeId: "identity-1",
        email: `address-${send}@example.test`
      });
    }
    vi.advanceTimersByTime(60 * 1000);
    await expect(reserveIdentityVerificationSend(env, {
      identityCodeId: "identity-1",
      email: "new-address@example.test"
    })).rejects.toBeInstanceOf(IdentityVerificationSendLimitError);

    expect(statements).toHaveLength(12);
    expect(statements[1]?.sql).toContain("SELECT ?, ?, ?");
    expect(statements[1]?.params[1]).not.toBe("identity-1");
    expect(new Set(statements.filter((_, index) => index % 2 === 1).map(
      statement => statement.params[1]
    )).size).toBe(1);
  });

  it("allows at most one send per identity in a rolling minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    const { env } = createEnv();
    const send = () => reserveIdentityVerificationSend(env, {
      identityCodeId: "identity-1",
      email: "player@example.test"
    });

    await send();
    await expect(send()).rejects.toBeInstanceOf(IdentityVerificationSendLimitError);
    vi.advanceTimersByTime(59 * 1000);
    await expect(send()).rejects.toBeInstanceOf(IdentityVerificationSendLimitError);
    vi.advanceTimersByTime(1000);
    await expect(send()).resolves.toBeUndefined();
  });

  it("uses a normalized email as the fallback subject for new applications", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    const { env, statements } = createEnv();
    await reserveIdentityVerificationSend(env, {
      email: " Player@Example.Test "
    });
    vi.advanceTimersByTime(60 * 1000);
    await reserveIdentityVerificationSend(env, {
      email: "player@example.test"
    });

    expect(statements[1]?.params[1]).toBe(statements[3]?.params[1]);
  });
});
