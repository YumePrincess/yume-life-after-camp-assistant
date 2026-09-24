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
      timezone: "America/New_York",
      tasks: { tech_switch: { time: "02:00" } }
    }
  })
}));

vi.mock("../src/mailer", () => ({
  identityMail: () => ({ subject: "", text: "" }),
  identityEmailChangeMail: () => ({ subject: "", text: "" }),
  identityApplicationVerificationMail: () => ({ subject: "", text: "" }),
  identityPasswordResetMail: () => ({ subject: "", text: "" }),
  identityCancellationMail: () => ({ subject: "", text: "" }),
  identityCancellationCompletedMail: () => ({ subject: "", text: "" }),
  identityProfileChangeMail: () => ({ subject: "", text: "" }),
  voteEligibilityMail: () => ({ subject: "", text: "" }),
  identityRecoveryMail: () => ({ subject: "", text: "" }),
  normalizeLocale: (value: unknown) =>
    typeof value === "string" ? value : "zh-cn",
  sendMail: async () => undefined
}));

import { submitReissue } from "../src/identity";

describe("identity-code reissue contact details", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses edited email and player name, and falls back to the existing values when blank", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    const application = {
      id: "application-1",
      application_number: "APP-1",
      request_type: "new",
      email: "old@example.com",
      player_name: "旧玩家",
      locale: "zh-cn",
      status: "approved",
      identity_code_id: "identity-1",
      submitted_at: "2026-01-01T00:00:00.000Z",
      reviewed_at: "2026-01-02T00:00:00.000Z",
      reviewed_by: "admin@example.com",
      rejection_reason: null,
      email_sent_at: null,
      last_email_error: null
    };
    const code = {
      id: "identity-1",
      code_hash: "hash",
      code_encrypted: "encrypted",
      player_name: "旧玩家",
      email: "old@example.com",
      locale: "zh-cn",
      application_id: "application-1",
      status: "active",
      expires_at: "2099-12-31T23:59:59.000Z",
      created_by: "admin@example.com",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      disabled_at: null,
      renewal_grace_vote_used_at: null,
      last_emailed_at: null,
      last_email_error: null,
      password_hash: null,
      password_set_at: null,
      password_updated_at: null,
      eligibility_override_votes: null,
      eligibility_override_expires_at: null,
      vote_permission_disabled: 0,
      vote_eligibility_bypass: 0
    };
    const batches: Array<Array<{ sql: string; params: unknown[] }>> = [];
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
              if (sql.includes("FROM identity_codes WHERE id = ?")) return code;
              if (
                sql.includes("FROM identity_code_applications WHERE application_number = ?") ||
                sql.includes("FROM identity_code_applications WHERE id = ?")
              ) return application;
              return null;
            },
            async all() {
              return { results: [] };
            }
          };
          return statement;
        },
        async batch(statements: Array<{ sql: string; params: unknown[] }>) {
          batches.push(statements);
          return statements.map(() => ({ meta: { changes: 1 } }));
        }
      }
    } as unknown as Env;

    await submitReissue(env, {
      identityCode: "",
      applicationNumber: "APP-1",
      lookupEmail: "old@example.com",
      email: " New@Example.com ",
      playerName: "新玩家",
      locale: "zh-cn"
    });
    expect(batches[0]?.[0]?.params.slice(0, 2)).toEqual([
      "new@example.com",
      "新玩家"
    ]);

    batches.length = 0;
    await submitReissue(env, {
      identityCode: "",
      applicationNumber: "APP-1",
      lookupEmail: "old@example.com",
      email: "",
      playerName: "   ",
      locale: "zh-cn"
    });
    expect(batches[0]?.[0]?.params.slice(0, 2)).toEqual([
      "old@example.com",
      "旧玩家"
    ]);
  });
});
