import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db", () => ({
  getConfigBundle: async () => ({
    campConfig: {
      gameResetTime: "03:00",
      timezone: "Asia/Taipei",
      voteWindowStart: "00:30",
      voteWindowEnd: "03:00"
    },
    automationConfig: {
      // Legacy task timezone intentionally differs. Site/admin timezone wins.
      timezone: "America/New_York",
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

import {
  deleteIdentityCodeRecord,
  updateIdentityCode,
  updateIdentityCodeVoteEligibility
} from "../src/identity";

describe("identity-code vote invalidation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves archived technology ballots and ended daily vote data when an identity is canceled", async () => {
    vi.useFakeTimers();
    // New York 15:19 is Taipei 03:19 the next day: daily reset and archive
    // have already happened in the administrator-configured timezone.
    vi.setSystemTime(new Date("2026-09-22T19:19:00.000Z"));

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

    expect(batched).toHaveLength(2);
    expect(batched[0]?.sql).toContain("UPDATE identity_codes");
    expect(batched.some(({ sql }) => sql.includes("DELETE FROM tech_ballots"))).toBe(false);
    expect(batched[1]?.sql).toContain("DELETE FROM daily_vote_responses");
    expect(batched[1]?.sql).toContain("item.start_at <= ? AND item.end_at > ?");
    expect(batched[1]?.params).toEqual([
      "identity-1",
      "2026-09-22T19:19:00.000Z",
      "2026-09-22T19:19:00.000Z"
    ]);
  });

  it("only invalidates the active technology poll while the configured vote window is open", async () => {
    vi.useFakeTimers();
    // New York is still on the prior afternoon while Taipei is 01:00 on
    // the active vote date; only the administrator timezone decides.
    vi.setSystemTime(new Date("2026-09-22T17:00:00.000Z"));

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
        async batch(statements: Array<{ sql: string; params: unknown[] }>) {
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
    expect(batched[1]?.sql).toContain("DELETE FROM tech_ballots");
    expect(batched[1]?.sql).not.toContain("updated_at");
    expect(batched[1]?.params).toEqual(["identity-1", "2026-09-23"]);
    expect(batched[2]?.sql).toContain("item.start_at <= ? AND item.end_at > ?");
  });

  it("deletes all historical voting records before deleting the identity code", async () => {
    const batched: Array<{ sql: string; params: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            params: [] as unknown[],
            bind(...params: unknown[]) {
              this.params = params;
              return this;
            },
            async first() {
              return { id: "identity-1" };
            }
          };
        },
        async batch(statements: Array<{ sql: string; params: unknown[] }>) {
          batched.push(...statements);
          return statements.map(() => ({ meta: { changes: 1 } }));
        }
      }
    } as unknown as Env;

    await deleteIdentityCodeRecord(env, "identity-1");

    expect(batched.map(({ sql }) => sql)).toEqual([
      "DELETE FROM daily_draw_winners WHERE identity_code_id = ?",
      "DELETE FROM daily_vote_responses WHERE identity_code_id = ?",
      "DELETE FROM tech_ballots WHERE voter_id = ?",
      "UPDATE identity_code_applications SET identity_code_id = NULL WHERE identity_code_id = ?",
      "DELETE FROM identity_codes WHERE id = ?"
    ]);
    expect(batched.every(({ params }) => params[0] === "identity-1")).toBe(true);
  });

  it("persists exception settings, prohibition, and eligibility exemption independently", async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
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
              return { id: "identity-1" };
            },
            async run() {
              updates.push({ sql: this.sql, params: this.params });
              return { meta: { changes: 1 } };
            }
          };
          return statement;
        }
      }
    } as unknown as Env;

    await updateIdentityCodeVoteEligibility(env, {
      id: "identity-1",
      mode: "none",
      votes: null,
      expiresAt: null,
      prohibited: true,
      bypassed: true
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain("vote_permission_disabled = ?");
    expect(updates[0]?.sql).toContain("vote_eligibility_bypass = ?");
    expect(updates[0]?.params.slice(0, 4)).toEqual([null, null, 1, 1]);
    expect(updates[0]?.params.at(-1)).toBe("identity-1");
  });
});
