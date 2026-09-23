import { describe, expect, it, vi } from "vitest";
import { keyedHash, verifyPassword } from "../src/crypto";

vi.mock("../src/db", () => ({
  getConfigBundle: async () => ({
    campConfig: { gameResetTime: "03:00" },
    automationConfig: { timezone: "Asia/Shanghai", tasks: { tech_switch: { time: "02:00" } } }
  })
}));

vi.mock("../src/mailer", () => ({
  identityMail: () => ({ subject: "", text: "" }),
  identityRecoveryMail: () => ({ subject: "", text: "" }),
  normalizeLocale: (value: unknown) => typeof value === "string" ? value : "zh-cn",
  sendMail: async () => undefined
}));

import { setIdentityPassword } from "../src/identity";

const SESSION_SECRET = "identity-password-test-secret-at-least-32-characters";
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000001";
const RESET_TOKEN = "12345678901234567890123456789012";

async function passwordTestEnv() {
  const challenge = {
    id: CHALLENGE_ID,
    identity_code_id: "identity-1",
    reset_token_hash: await keyedHash(
      { SESSION_SECRET } as Env,
      "identity-reset-token",
      RESET_TOKEN
    ),
    expires_at: "2099-01-01T00:00:00.000Z",
    verified_at: "2026-01-01T00:00:00.000Z",
    consumed_at: null
  };
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const env = {
    SESSION_SECRET,
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
            if (sql.includes("identity_verification_challenges")) return challenge;
            if (sql.includes("FROM identity_codes")) return { id: "identity-1" };
            return null;
          }
        };
        return statement;
      },
      async batch(batchStatements: typeof statements) {
        statements.push(...batchStatements);
        return [];
      }
    }
  } as unknown as Env;
  return { env, statements };
}

describe("identity-code password rules", () => {
  it.each(["123456", "a".repeat(32)])(
    "accepts any password from 6 through 32 characters (%s)",
    async (password) => {
      const { env, statements } = await passwordTestEnv();
      await setIdentityPassword(env, {
        challengeId: CHALLENGE_ID,
        resetToken: RESET_TOKEN,
        password
      });

      const passwordHash = statements[0]?.params[0];
      expect(typeof passwordHash).toBe("string");
      await expect(verifyPassword(password, passwordHash as string)).resolves.toBe(true);
    }
  );

  it.each(["12345", "a".repeat(33)])(
    "rejects passwords outside the 6–32 character range (%s)",
    async (password) => {
      const { env } = await passwordTestEnv();
      await expect(setIdentityPassword(env, {
        challengeId: CHALLENGE_ID,
        resetToken: RESET_TOKEN,
        password
      })).rejects.toThrow("密码必须为6至32位");
    }
  );
});
