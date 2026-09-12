import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db", () => ({
  getConfigBundle: async () => ({
    campConfig: {
      gameResetTime: "03:00"
    },
    automationConfig: {
      timezone: "Asia/Shanghai",
      tasks: {
        tech_switch: {
          time: "02:00"
        }
      }
    }
  })
}));

vi.mock("../src/mailer", () => ({
  identityMail: () => ({ subject: "", text: "" }),
  identityRecoveryMail: () => ({ subject: "", text: "" }),
  normalizeLocale: (value: unknown) =>
    typeof value === "string" ? value : "zh-cn",
  sendMail: async () => undefined
}));

import { updateIdentityCode } from "../src/identity";

describe("identity-code vote invalidation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels current technology and every unfinished daily vote in the same D1 batch as the code", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T04:00:00.000Z"));

    const batched: Array<{ sql: string; params: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            sql,
            params: [] as unknown[],
            bind(...params: unknown[]) {
              this.params = params;
              return this;
            },
            async first() {
              return sql.includes("FROM identity_codes")
                ? {
                    id: "identity-1",
                    email: "member@example.com",
                    player_name: "Member",
                    status: "active"
                  }
                : null;
            }
          };
          return statement;
        },
        async batch(
          statements: Array<{ sql: string; params: unknown[] }>
        ) {
          batched.push(...statements);
          return statements.map(() => ({ meta: { changes: 1 } }));
        }
      }
    } as unknown as Env;

    await updateIdentityCode(env, {
      id: "identity-1",
      status: "disabled",
      permanent: true,
      expiresAt: null
    });

    expect(batched).toHaveLength(3);
    expect(batched[0]?.sql).toContain("UPDATE identity_codes");
    expect(batched[1]?.sql).toContain("DELETE FROM tech_ballots");
    expect(batched[1]?.params).toEqual([
      "identity-1",
      "2026-08-01",
      "2026-07-30T16:00:00.000Z",
      "2026-07-31T16:00:00.000Z"
    ]);
    expect(batched[2]?.sql).toContain("DELETE FROM daily_vote_responses");
    expect(batched[2]?.sql).toContain("FROM daily_vote_items");
    expect(batched[2]?.sql).toContain("item.end_at > ?");
    expect(batched[2]?.sql).toContain("daily_draw_winners");
    expect(batched[2]?.params).toEqual([
      "identity-1",
      "2026-07-31T04:00:00.000Z"
    ]);
  });
});
