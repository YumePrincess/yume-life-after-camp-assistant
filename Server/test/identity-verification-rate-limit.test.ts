import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IdentityVerificationSendLimitError,
  reserveIdentityVerificationSend
} from "../src/identity-verification-rate-limit";

function createEnv() {
  const counts = new Map<string, number>();
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
        const count = counts.get(subjectHash) || 0;
        const inserted = count < 5;
        if (inserted) counts.set(subjectHash, count + 1);
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
      await reserveIdentityVerificationSend(env, {
        identityCodeId: "identity-1",
        email: `address-${send}@example.test`
      });
    }
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

  it("uses a normalized email as the fallback subject for new applications", async () => {
    const { env, statements } = createEnv();
    await reserveIdentityVerificationSend(env, {
      email: " Player@Example.Test "
    });
    await reserveIdentityVerificationSend(env, {
      email: "player@example.test"
    });

    expect(statements[1]?.params[1]).toBe(statements[3]?.params[1]);
  });
});
