import { keyedHash } from "./crypto";

const MAX_SENDS_PER_HOUR = 5;
const MAX_SENDS_PER_MINUTE = 1;
const HOUR_WINDOW_MS = 60 * 60 * 1000;
const MINUTE_WINDOW_MS = 60 * 1000;

export const IDENTITY_VERIFICATION_SEND_LIMIT_MESSAGE =
  "验证码发送过于频繁：每分钟最多1次、每小时最多5次，请稍后重试。";

export class IdentityVerificationSendLimitError extends Error {
  constructor() {
    super(IDENTITY_VERIFICATION_SEND_LIMIT_MESSAGE);
    this.name = "IdentityVerificationSendLimitError";
  }
}

export async function reserveIdentityVerificationSend(
  env: Env,
  input: { identityCodeId?: string | null; email: string }
): Promise<void> {
  const subject = input.identityCodeId
    ? `identity-code:${input.identityCodeId}`
    : `email:${input.email.trim().toLowerCase()}`;
  const subjectHash = await keyedHash(
    env,
    "identity-verification-send-limit",
    subject
  );
  const timestamp = new Date().toISOString();
  const hourWindowStart = new Date(Date.parse(timestamp) - HOUR_WINDOW_MS).toISOString();
  const minuteWindowStart = new Date(Date.parse(timestamp) - MINUTE_WINDOW_MS).toISOString();

  const results = await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM identity_verification_send_events WHERE created_at <= ?"
    ).bind(hourWindowStart),
    env.DB.prepare(
      `INSERT INTO identity_verification_send_events(id, subject_hash, created_at)
       SELECT ?, ?, ?
       WHERE (
         SELECT COUNT(*)
         FROM identity_verification_send_events
         WHERE subject_hash = ? AND created_at > ?
       ) < ?
       AND (
         SELECT COUNT(*)
         FROM identity_verification_send_events
         WHERE subject_hash = ? AND created_at > ?
       ) < ?`
    ).bind(
      crypto.randomUUID(),
      subjectHash,
      timestamp,
      subjectHash,
      hourWindowStart,
      MAX_SENDS_PER_HOUR,
      subjectHash,
      minuteWindowStart,
      MAX_SENDS_PER_MINUTE
    )
  ]);

  if (results[1]?.meta.changes !== 1) {
    throw new IdentityVerificationSendLimitError();
  }
}
