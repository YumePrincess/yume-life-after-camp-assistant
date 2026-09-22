import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  keyedHash,
  verifyPassword
} from "./crypto";
import {
  identityMail,
  identityEmailChangeMail,
  identityApplicationVerificationMail,
  identityPasswordResetMail,
  identityCancellationMail,
  identityCancellationCompletedMail,
  identityProfileChangeMail,
  voteEligibilityMail,
  identityRecoveryMail,
  normalizeLocale,
  sendMail,
  type SupportedLocale
} from "./mailer";
import {
  canUseExpiredRenewalGrace,
  identityPlayerNameKey,
  isIdentityCodeExpired,
  isIdentityRenewalWindowOpen,
  isSequentialIdentityCode
} from "./identity-code-utils";
import { getConfigBundle } from "./db";
import {
  addDaysToDateKey,
  nextTechnologyTargetDate,
  zonedDateKey,
  zonedDateTimeToIso
} from "./time";
import { getDailyVoteConfig } from "./daily-vote";
import { evaluateVoteEligibility, getVoteEligibilityStats } from "./vote-eligibility";
export { isSequentialIdentityCode } from "./identity-code-utils";

export interface IdentityApplicationRow {
  id: string;
  application_number: string;
  request_type: "new" | "renewal" | "reissue";
  email: string;
  player_name: string;
  locale: SupportedLocale;
  status: "pending" | "approved" | "rejected";
  identity_code_id: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  email_sent_at: string | null;
  last_email_error: string | null;
}

export interface IdentityReviewItem {
  id: string;
  record_type: "application" | "profile_change" | "eligibility_override";
  application_number: string | null;
  request_type: "new" | "renewal" | "reissue" | "profile_change" | "eligibility_override";
  email: string | null;
  player_name: string | null;
  locale: SupportedLocale;
  status: "pending" | "approved" | "rejected";
  identity_code_id: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  email_sent_at: string | null;
  last_email_error: string | null;
  profile_kind: "player_name" | "email" | null;
  current_player_name: string | null;
  current_email: string | null;
  requested_player_name: string | null;
  requested_email: string | null;
  eligibility_reason: string | null;
  eligibility_weekly_contribution: number | null;
  eligibility_technology_points: number | null;
  eligibility_material_contribution: number | null;
  eligibility_weekly_activity_points: number | null;
  approved_votes: number | null;
  approved_expires_at: string | null;
}

export interface VoteEligibilityApplicationRow {
  id: string;
  application_number: string;
  identity_code_id: string;
  email: string;
  player_name: string;
  locale: SupportedLocale;
  reason: string;
  weekly_contribution: number;
  technology_points: number;
  material_contribution: number;
  weekly_activity_points: number;
  status: "pending" | "approved" | "rejected";
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  approved_votes: number | null;
  approved_expires_at: string | null;
  email_sent_at: string | null;
  last_email_error: string | null;
}

export interface IdentityCodeRow {
  id: string;
  code_hash: string;
  code_encrypted: string;
  player_name: string | null;
  email: string | null;
  locale: SupportedLocale;
  application_id: string | null;
  status: "active" | "disabled";
  expires_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
  renewal_grace_vote_used_at: string | null;
  last_emailed_at: string | null;
  last_email_error: string | null;
  password_hash: string | null;
  password_set_at: string | null;
  password_updated_at: string | null;
  eligibility_override_votes: number | null;
  eligibility_override_expires_at: string | null;
}

export type IdentityVerification =
  | { ok: true; code: IdentityCodeRow; grace: boolean }
  | {
      ok: false;
      reason: "invalid" | "disabled" | "expired";
      canRenew: boolean;
      applicationNumber?: string;
    };

function now(): string {
  return new Date().toISOString();
}

async function currentVoteInvalidations(
  env: Env,
  identityCodeId: string,
  at = new Date()
): Promise<D1PreparedStatement[]> {
  // Public OTP cancellation and admin disabling must use this same statement
  // set: the active technology ballot, every still-open daily vote response,
  // and unresolved draw responses are all invalidated together with the code.
  const bundle = await getConfigBundle(env);
  const timezone = bundle.automationConfig.timezone;
  const pollDate = nextTechnologyTargetDate(
    at,
    timezone,
    bundle.automationConfig.tasks.tech_switch.time,
    bundle.campConfig.gameResetTime
  );
  const localDate = zonedDateKey(at, timezone);
  const localDayStart = zonedDateTimeToIso(localDate, "00:00", timezone);
  const localDayEnd = zonedDateTimeToIso(
    addDaysToDateKey(localDate, 1),
    "00:00",
    timezone
  );
  return [
    env.DB.prepare(
      `DELETE FROM tech_ballots
       WHERE voter_id = ?
         AND (poll_date = ? OR (updated_at >= ? AND updated_at < ?))`
    ).bind(identityCodeId, pollDate, localDayStart, localDayEnd),
    env.DB.prepare(
      `DELETE FROM daily_vote_responses
       WHERE identity_code_id = ?
         AND item_id IN (
           SELECT item.id
           FROM daily_vote_items item
           WHERE item.end_at > ?
              OR (
                item.kind = 'draw'
                AND NOT EXISTS (
                  SELECT 1
                  FROM daily_draw_winners winner
                  WHERE winner.item_id = item.id
                )
              )
         )`
    ).bind(identityCodeId, at.toISOString())
  ];
}

async function localizedExpiry(
  env: Env,
  value: string | null | undefined,
  locale: SupportedLocale
): Promise<string | null> {
  if (!value) return null;
  const bundle = await getConfigBundle(env);
  return new Intl.DateTimeFormat(
    {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      en: "en",
      fr: "fr",
      ja: "ja"
    }[locale],
    {
      timeZone: bundle.campConfig.timezone,
      dateStyle: "long",
      timeStyle: "short"
    }
  ).format(new Date(value));
}

function uuid(): string {
  return crypto.randomUUID();
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function generateInitialPassword(): string {
  const values = crypto.getRandomValues(new Uint8Array(10));
  const characters = Array.from(
    values,
    (value) => PASSWORD_ALPHABET.charAt(value % PASSWORD_ALPHABET.length)
  );
  if (!characters.some((value) => /[A-Za-z]/.test(value))) characters[0] = "A";
  if (!characters.some((value) => /\d/.test(value))) characters[1] = "7";
  return characters.join("");
}

function cleanPassword(value: unknown): string {
  const password = typeof value === "string" ? value.trim() : "";
  const normalized = password.toLowerCase();
  const weakPasswords = new Set([
    "passwordpassword",
    "password123456",
    "qwertyuiop123",
    "123456789012",
    "abcdefghijkl",
    "adminadmin12",
    "letmein12345",
    "iloveyou1234"
  ]);
  if (password.length < 12 || password.length > 64 || /\s/.test(password)) {
    throw new Error("密码必须为12至64位且不能包含空格");
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new Error("密码必须同时包含大写字母、小写字母、数字和特殊符号");
  }
  if (weakPasswords.has(normalized) || /(.)\1{3,}/.test(normalized)) {
    throw new Error("密码过于简单，请避免常见密码或重复字符");
  }
  let ascendingRun = 1;
  let descendingRun = 1;
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized.charCodeAt(index - 1);
    const current = normalized.charCodeAt(index);
    ascendingRun = current === previous + 1 ? ascendingRun + 1 : 1;
    descendingRun = current === previous - 1 ? descendingRun + 1 : 1;
    if (ascendingRun >= 4 || descendingRun >= 4) {
      throw new Error("密码过于简单，请避免连续字符");
    }
  }
  return password;
}

function cleanOtp(value: unknown): string {
  const otp = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!/^\d{6}$/.test(otp)) throw new Error("验证码必须为6位数字");
  return otp;
}

function cleanChallengeId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-f0-9-]{20,80}$/i.test(id)) {
    throw new Error("验证码申请已失效，请重新申请");
  }
  return id;
}

function cleanChallengeToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{32,160}$/.test(token)) {
    throw new Error("验证码验证已失效，请重新申请");
  }
  return token;
}

function cleanEmail(value: unknown, required = true): string {
  const result = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((!result && required) || (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))) {
    throw new Error("请输入有效的接收邮箱");
  }
  return result.slice(0, 254);
}

function cleanPlayerName(value: unknown, required = true): string {
  const result = typeof value === "string" ? value.trim() : "";
  if ((!result && required) || result.length > 80) throw new Error("玩家名称无效");
  return result;
}

const PENDING_IDENTITY_REQUEST_MESSAGE =
  "已有身份识别码申请待审批，请等待当前申请完成后再提交其他申请";

async function assertNoPendingIdentityApplication(
  env: Env,
  input: { email: string; playerName: string; excludeId?: string }
): Promise<void> {
  const pendingRows = await env.DB.prepare(
    `SELECT id, application_number, email, player_name
     FROM identity_code_applications
     WHERE status = 'pending'
     ORDER BY submitted_at DESC LIMIT 500`
  ).all<{
    id: string;
    application_number: string;
    email: string;
    player_name: string;
  }>();
  const playerNameKey = identityPlayerNameKey(input.playerName);
  const pending = pendingRows.results.find(
    (row) =>
      row.id !== input.excludeId &&
      (row.email.toLowerCase() === input.email.toLowerCase() ||
        (playerNameKey &&
          identityPlayerNameKey(row.player_name) === playerNameKey))
  );
  if (pending) {
    throw new Error(PENDING_IDENTITY_REQUEST_MESSAGE);
  }
}

async function assertNoPendingIdentityRequest(
  env: Env,
  identityCodeId: string,
  options: { excludeEmailChangeGroupId?: string } = {}
): Promise<void> {
  const application = await env.DB.prepare(
    `SELECT id FROM identity_code_applications
     WHERE identity_code_id = ? AND status = 'pending' LIMIT 1`
  ).bind(identityCodeId).first<{ id: string }>();
  if (application) throw new Error(PENDING_IDENTITY_REQUEST_MESSAGE);

  const challengeExclusion = options.excludeEmailChangeGroupId
    ? " AND group_id != ?"
    : "";
  const challengeBindings: unknown[] = [identityCodeId, now()];
  if (options.excludeEmailChangeGroupId) {
    challengeBindings.push(options.excludeEmailChangeGroupId);
  }
  const emailChange = await env.DB.prepare(
    `SELECT id FROM identity_verification_challenges
     WHERE identity_code_id = ? AND purpose = 'email_change'
       AND consumed_at IS NULL AND expires_at > ?${challengeExclusion}
     LIMIT 1`
  )
    .bind(...challengeBindings)
    .first<{ id: string }>();
  if (emailChange) throw new Error(PENDING_IDENTITY_REQUEST_MESSAGE);

  const profileChange = await env.DB.prepare(
    `SELECT id FROM identity_profile_change_requests
     WHERE identity_code_id = ? AND status = 'pending' LIMIT 1`
  ).bind(identityCodeId).first<{ id: string }>();
  if (profileChange) throw new Error(PENDING_IDENTITY_REQUEST_MESSAGE);

  const eligibilityApplication = await env.DB.prepare(
    `SELECT id FROM vote_eligibility_applications
     WHERE identity_code_id = ? AND status = 'pending' LIMIT 1`
  ).bind(identityCodeId).first<{ id: string }>();
  if (eligibilityApplication) throw new Error(PENDING_IDENTITY_REQUEST_MESSAGE);
}

async function assertNoOtherActiveIdentityCode(
  env: Env,
  input: {
    email: string | null;
    playerName: string | null;
    excludeId?: string;
    conflictMessage?: string;
  }
): Promise<void> {
  if (!input.email && !input.playerName) return;
  const activeRows = await env.DB.prepare(
    `SELECT id, email, player_name, expires_at FROM identity_codes
     WHERE status = 'active' ORDER BY updated_at DESC LIMIT 500`
  ).all<{
    id: string;
    email: string | null;
    player_name: string | null;
    expires_at: string | null;
  }>();
  const playerNameKey = identityPlayerNameKey(input.playerName);
  const active = activeRows.results.find(
    (row) =>
      row.id !== input.excludeId &&
      ((input.email &&
        row.email?.toLowerCase() === input.email.toLowerCase()) ||
        (playerNameKey &&
          identityPlayerNameKey(row.player_name) === playerNameKey))
  );
  if (active) {
    if (isIdentityCodeExpired(active.expires_at)) {
      throw new Error(
        "您提供的信息关联的身份识别码已过期，请通过“申请延长识别码有效期”功能申请延期。延期申请被拒绝后，该识别码将标记为失效，届时可以重新申请身份识别码。"
      );
    }
    throw new Error(
      input.conflictMessage ?? "相同邮箱或玩家名称已有状态为有效的身份识别码"
    );
  }
}

function cleanIdentityCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!/^\d{8}$/.test(code)) throw new Error("身份识别码必须为8位数字");
  return code;
}

async function generateCode(env: Env): Promise<{ code: string; hash: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const values = crypto.getRandomValues(new Uint32Array(2));
    const number = (((values[0] ?? 0) * 0x1_0000 + (values[1] ?? 0)) % 100_000_000)
      .toString()
      .padStart(8, "0");
    if (isSequentialIdentityCode(number)) continue;
    const hash = await keyedHash(env, "identity-code", number);
    const exists = await env.DB.prepare("SELECT id FROM identity_codes WHERE code_hash = ?")
      .bind(hash)
      .first();
    if (!exists) return { code: number, hash };
  }
  throw new Error("暂时无法生成唯一识别码，请重试");
}

async function generateApplicationNumber(env: Env): Promise<string> {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    const value = `LA${date}-${(random % 1_000_000).toString().padStart(6, "0")}`;
    const exists = await env.DB.prepare(
      "SELECT id FROM identity_code_applications WHERE application_number = ?"
    ).bind(value).first();
    if (exists) continue;
    const eligibilityExists = await env.DB.prepare(
      "SELECT id FROM vote_eligibility_applications WHERE application_number = ?"
    ).bind(value).first();
    if (!eligibilityExists) return value;
  }
  throw new Error("暂时无法生成申请编号，请重试");
}

export async function createIdentityApplication(
  env: Env,
  input: { email: unknown; playerName: unknown; locale: unknown }
): Promise<{ applicationNumber: string; status: string }> {
  const email = cleanEmail(input.email);
  const playerName = cleanPlayerName(input.playerName);
  await assertNoPendingIdentityApplication(env, { email, playerName });
  await assertNoOtherActiveIdentityCode(env, {
    email,
    playerName,
    conflictMessage:
      "您提供的信息可能已经成功申请身份识别码。如果您忘记了身份识别码，请通过“忘记识别码”功能找回。如果这不是您提交的申请，请联系市长处理。"
  });
  const id = uuid();
  const applicationNumber = await generateApplicationNumber(env);
  await env.DB.prepare(
    `INSERT INTO identity_code_applications(
      id, application_number, request_type, email, player_name, locale, status, submitted_at
    ) VALUES(?, ?, 'new', ?, ?, ?, 'pending', ?)`
  )
    .bind(id, applicationNumber, email, playerName, normalizeLocale(input.locale), now())
    .run();
  return { applicationNumber, status: "pending" };
}

async function codeByPlaintext(env: Env, input: unknown): Promise<IdentityCodeRow | null> {
  const code = cleanIdentityCode(input);
  const hash = await keyedHash(env, "identity-code", code);
  return env.DB.prepare("SELECT * FROM identity_codes WHERE code_hash = ?")
    .bind(hash)
    .first<IdentityCodeRow>();
}

async function applicationForCode(
  env: Env,
  code: IdentityCodeRow
): Promise<IdentityApplicationRow | null> {
  let application = code.application_id
    ? await env.DB.prepare(
        "SELECT * FROM identity_code_applications WHERE id = ?"
      )
        .bind(code.application_id)
        .first<IdentityApplicationRow>()
    : null;
  if (!application) {
    application = await env.DB.prepare(
      `SELECT * FROM identity_code_applications
       WHERE identity_code_id = ?
       ORDER BY reviewed_at DESC, submitted_at DESC LIMIT 1`
    )
      .bind(code.id)
      .first<IdentityApplicationRow>();
  }
  if (!application) return null;
  const repairs: D1PreparedStatement[] = [];
  if (code.application_id !== application.id) {
    repairs.push(
      env.DB.prepare(
        "UPDATE identity_codes SET application_id = ?, updated_at = ? WHERE id = ?"
      ).bind(application.id, now(), code.id)
    );
  }
  if (!application.identity_code_id) {
    repairs.push(
      env.DB.prepare(
        "UPDATE identity_code_applications SET identity_code_id = ? WHERE id = ?"
      ).bind(code.id, application.id)
    );
    application = { ...application, identity_code_id: code.id };
  }
  if (repairs.length) await env.DB.batch(repairs);
  return application;
}

async function codeForApplication(
  env: Env,
  application: IdentityApplicationRow
): Promise<IdentityCodeRow | null> {
  let code = application.identity_code_id
    ? await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
        .bind(application.identity_code_id)
        .first<IdentityCodeRow>()
    : null;
  if (!code) {
    code = await env.DB.prepare(
      `SELECT * FROM identity_codes WHERE application_id = ?
       ORDER BY updated_at DESC LIMIT 1`
    )
      .bind(application.id)
      .first<IdentityCodeRow>();
  }
  if (!code) return null;
  const repairs: D1PreparedStatement[] = [];
  if (code.application_id !== application.id) {
    repairs.push(
      env.DB.prepare(
        "UPDATE identity_codes SET application_id = ?, updated_at = ? WHERE id = ?"
      ).bind(application.id, now(), code.id)
    );
  }
  if (application.identity_code_id !== code.id) {
    repairs.push(
      env.DB.prepare(
        "UPDATE identity_code_applications SET identity_code_id = ? WHERE id = ?"
      ).bind(code.id, application.id)
    );
  }
  if (repairs.length) await env.DB.batch(repairs);
  return code;
}

async function ensureApplicationForCode(
  env: Env,
  code: IdentityCodeRow
): Promise<IdentityApplicationRow | null> {
  const existing = await applicationForCode(env, code);
  if (existing) return existing;
  if (!code.email || !code.player_name) return null;
  const id = uuid();
  const applicationNumber = await generateApplicationNumber(env);
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO identity_code_applications(
        id, application_number, request_type, email, player_name, locale,
        status, identity_code_id, submitted_at, reviewed_at, reviewed_by
      ) VALUES(?, ?, 'new', ?, ?, ?, 'approved', ?, ?, ?, ?)`
    ).bind(
      id,
      applicationNumber,
      code.email,
      code.player_name,
      code.locale,
      code.id,
      code.created_at,
      timestamp,
      code.created_by
    ),
    env.DB.prepare(
      "UPDATE identity_codes SET application_id = ?, updated_at = ? WHERE id = ?"
    ).bind(id, timestamp, code.id)
  ]);
  return env.DB.prepare(
    "SELECT * FROM identity_code_applications WHERE id = ?"
  )
    .bind(id)
    .first<IdentityApplicationRow>();
}

export async function verifyIdentityCode(
  env: Env,
  plaintext: unknown,
  options: { consumeRenewalGrace?: boolean } = {}
): Promise<IdentityVerification> {
  let code: IdentityCodeRow | null;
  try {
    code = await codeByPlaintext(env, plaintext);
  } catch {
    return { ok: false, reason: "invalid", canRenew: false };
  }
  if (!code) return { ok: false, reason: "invalid", canRenew: false };
  if (code.status === "disabled") {
    return { ok: false, reason: "disabled", canRenew: false };
  }
  const expired = isIdentityCodeExpired(code.expires_at);
  if (!expired) return { ok: true, code, grace: false };
  const application = await applicationForCode(env, code);
  const pendingRenewal =
    application?.request_type === "renewal" && application.status === "pending";
  if (
    canUseExpiredRenewalGrace({
      expiresAt: code.expires_at,
      pendingRenewal,
      graceVoteUsedAt: code.renewal_grace_vote_used_at
    })
  ) {
    if (!options.consumeRenewalGrace) return { ok: true, code, grace: true };
    const result = await env.DB.prepare(
      `UPDATE identity_codes SET renewal_grace_vote_used_at = ?, updated_at = ?
       WHERE id = ? AND renewal_grace_vote_used_at IS NULL`
    )
      .bind(now(), now(), code.id)
      .run();
    if (result.meta.changes > 0) return { ok: true, code, grace: true };
  }
  return {
    ok: false,
    reason: "expired",
    canRenew: application?.status !== "rejected",
    ...(application ? { applicationNumber: application.application_number } : {})
  };
}

export type IdentityPasswordVerification =
  | { ok: true; code: IdentityCodeRow; grace: boolean }
  | {
      ok: false;
      reason: "invalid" | "invalid_password" | "password_required" | "disabled" | "expired";
      canRenew: boolean;
      applicationNumber?: string;
    };

async function codeAndApplicationForRenewal(
  env: Env,
  input: { identityCode: unknown; applicationNumber: unknown }
): Promise<{ code: IdentityCodeRow; application: IdentityApplicationRow }> {
  const identityCode =
    typeof input.identityCode === "string" ? input.identityCode.trim() : "";
  const applicationNumber =
    typeof input.applicationNumber === "string"
      ? input.applicationNumber.trim().slice(0, 40)
      : "";
  if (!identityCode && !applicationNumber) {
    throw new Error("请填写申请编号或身份识别码");
  }
  let code: IdentityCodeRow | null = null;
  let application: IdentityApplicationRow | null = null;
  if (identityCode) {
    code = await codeByPlaintext(env, identityCode);
    if (!code) throw new Error("身份识别码无效");
    application = await ensureApplicationForCode(env, code);
  } else {
    application = await env.DB.prepare(
      "SELECT * FROM identity_code_applications WHERE application_number = ?"
    )
      .bind(applicationNumber)
      .first<IdentityApplicationRow>();
    if (application) code = await codeForApplication(env, application);
  }
  if (!code || !application) {
    throw new Error("没有找到可延期的识别码申请记录");
  }
  if (
    applicationNumber &&
    application.application_number !== applicationNumber
  ) {
    throw new Error("申请编号与身份识别码不匹配");
  }
  return { code, application };
}

export async function renewalPreview(
  env: Env,
  input: { identityCode: unknown; applicationNumber: unknown }
): Promise<{
  applicationNumber: string;
  email: string;
  playerName: string;
  status: string;
  canSubmit: boolean;
}> {
  const { code, application } = await codeAndApplicationForRenewal(env, input);
  await assertNoPendingIdentityRequest(env, code.id);
  if (code.status === "disabled") throw new Error("身份识别码已被禁用");
  if (!isIdentityRenewalWindowOpen(code.expires_at)) {
    throw new Error("仅可在识别码有效期届满前7天内申请延期");
  }
  if (application.status === "pending") {
    throw new Error(PENDING_IDENTITY_REQUEST_MESSAGE);
  }
  return {
    applicationNumber: application.application_number,
    email: application.email,
    playerName: application.player_name,
    status: application.status,
    canSubmit: application.status !== "rejected"
  };
}

export async function verifyIdentityPassword(
  env: Env,
  input: { identityCode: unknown; password: unknown },
  options: { consumeRenewalGrace?: boolean } = {}
): Promise<IdentityPasswordVerification> {
  const verification = await verifyIdentityCode(env, input.identityCode, options);
  if (!verification.ok) return verification;
  const password = typeof input.password === "string" ? input.password : "";
  if (!verification.code.password_hash) {
    const application = await applicationForCode(env, verification.code);
    return {
      ok: false,
      reason: "password_required",
      canRenew: verification.grace,
      ...(application ? { applicationNumber: application.application_number } : {})
    };
  }
  if (!(await verifyPassword(password, verification.code.password_hash))) {
    return { ok: false, reason: "invalid_password", canRenew: verification.grace };
  }
  return verification;
}

export async function identityAccount(
  env: Env,
  input: { identityCode: unknown; password: unknown }
): Promise<{
  identityCode: string;
  playerName: string;
  email: string;
  expiresAt: string | null;
  timezone: string;
  voteEligibility: Awaited<ReturnType<typeof evaluateVoteEligibility>>;
  passwordRequired: false;
}> {
  const verification = await verifyIdentityPassword(env, input);
  if (!verification.ok) {
    if (verification.reason === "password_required") {
      throw new Error("旧身份识别码尚未设置密码，请使用忘记密码功能设置密码");
    }
    if (verification.reason === "invalid_password") throw new Error("身份识别码或密码错误");
    if (verification.reason === "disabled") throw new Error("身份识别码已被禁用");
    if (verification.reason === "expired") throw new Error("身份识别码已过期");
    throw new Error("身份识别码无效");
  }
  const bundle = await getConfigBundle(env);
  const dailyVoteConfig = await getDailyVoteConfig(env);
  return {
    identityCode: await decryptSecret(env, "identity-code-value", verification.code.code_encrypted),
    playerName: verification.code.player_name ?? "",
    email: verification.code.email ?? "",
    expiresAt: verification.code.expires_at,
    timezone: bundle.campConfig.timezone,
    voteEligibility: await evaluateVoteEligibility(env, {
      playerName: verification.code.player_name,
      identityCodeId: verification.code.id,
      enabled: dailyVoteConfig.voteEligibilityEnabled,
      thresholds: dailyVoteConfig.voteEligibility,
      override: {
        votesRemaining: verification.code.eligibility_override_votes,
        expiresAt: verification.code.eligibility_override_expires_at
      }
    }),
    passwordRequired: false
  };
}

export async function submitRenewal(
  env: Env,
  input: {
    identityCode: unknown;
    applicationNumber?: unknown;
    email: unknown;
    playerName: unknown;
    locale: unknown;
  }
): Promise<{ applicationNumber: string; status: string; graceVoteAvailable: boolean }> {
  const { code, application } = await codeAndApplicationForRenewal(env, {
    identityCode: input.identityCode,
    applicationNumber: input.applicationNumber
  });
  const email = cleanEmail(input.email);
  const playerName = cleanPlayerName(input.playerName);
  await assertNoPendingIdentityRequest(env, code.id);
  if (code.status === "disabled") throw new Error("身份识别码已被禁用");
  if (!isIdentityRenewalWindowOpen(code.expires_at)) {
    throw new Error("仅可在识别码有效期届满前7天内申请延期");
  }
  if (application.request_type === "renewal" && application.status === "rejected") {
    throw new Error("该延期申请已被拒绝，不能再次申请");
  }
  await assertNoOtherActiveIdentityCode(env, {
    email,
    playerName,
    excludeId: code.id
  });
  await assertNoPendingIdentityApplication(env, {
    email,
    playerName,
    excludeId: application.id
  });
  const submittedAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE identity_code_applications SET
        request_type = 'renewal', email = ?, player_name = ?, status = 'pending',
        locale = ?, submitted_at = ?,
        reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL,
        email_sent_at = NULL, last_email_error = NULL
       WHERE id = ?`
    ).bind(
      email,
      playerName,
      normalizeLocale(input.locale),
      submittedAt,
      application.id
    ),
    env.DB.prepare(
      `UPDATE identity_codes SET renewal_grace_vote_used_at = NULL, updated_at = ?
       WHERE id = ?`
    ).bind(submittedAt, code.id)
  ]);
  return {
    applicationNumber: application.application_number,
    status: "pending",
    graceVoteAvailable: true
  };
}

async function codeForReissue(
  env: Env,
  input: {
    identityCode: unknown;
    applicationNumber: unknown;
    email: unknown;
  }
): Promise<IdentityCodeRow> {
  const identityCode =
    typeof input.identityCode === "string" ? input.identityCode.trim() : "";
  const applicationNumber =
    typeof input.applicationNumber === "string"
      ? input.applicationNumber.trim().slice(0, 40)
      : "";
  const email = cleanEmail(input.email, false);
  if (!applicationNumber && !identityCode && !email) {
    throw new Error(
      "请至少填写申请编号、申请时预留邮箱或旧识别码中的一项"
    );
  }
  let code: IdentityCodeRow | null = null;
  if (applicationNumber) {
    const application = await env.DB.prepare(
      `SELECT * FROM identity_code_applications WHERE application_number = ? LIMIT 1`
    )
      .bind(applicationNumber)
      .first<IdentityApplicationRow>();
    if (!application) throw new Error("未找到匹配的身份识别码申请记录");
    code = await codeForApplication(env, application);
    if (!code) throw new Error("该申请没有关联可更换的身份识别码");
  }
  if (identityCode) {
    const codeByValue = await codeByPlaintext(env, identityCode);
    if (!codeByValue) throw new Error("旧身份识别码无效");
    if (code && code.id !== codeByValue.id) {
      throw new Error("填写的信息未指向同一份识别码记录");
    }
    code = codeByValue;
  }
  if (code) {
    await assertNoPendingIdentityRequest(env, code.id);
    if (email && code.email?.toLowerCase() !== email) {
      throw new Error("填写的信息未指向同一份识别码记录");
    }
    if (code.status !== "active") {
      throw new Error("只有状态为有效的身份识别码可以申请更换");
    }
    if (isIdentityCodeExpired(code.expires_at)) {
      throw new Error("已过期的身份识别码不能申请更换，请申请延长有效期");
    }
    return code;
  }
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (email) {
    clauses.push("lower(email) = ?");
    bindings.push(email);
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM identity_codes
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY updated_at DESC
     LIMIT 500`
  )
    .bind(...bindings)
    .all<IdentityCodeRow>();
  const matches = rows.results;
  if (!matches.length) throw new Error("未找到匹配的身份识别码记录");
  const eligibleMatches = matches.filter(
    (row) => row.status === "active" && !isIdentityCodeExpired(row.expires_at)
  );
  if (eligibleMatches.length > 1) {
    throw new Error("匹配到多个识别码，请再填写另一项信息缩小范围");
  }
  if (eligibleMatches.length === 1) return eligibleMatches[0]!;
  if (matches.some((row) => row.status === "active")) {
    throw new Error("已过期的身份识别码不能申请更换，请申请延长有效期");
  }
  if (matches.length) {
    throw new Error("只有状态为有效的身份识别码可以申请更换");
  }
  throw new Error("未找到匹配的身份识别码记录");
}

export async function reissuePreview(
  env: Env,
  input: {
    identityCode: unknown;
    applicationNumber: unknown;
    email: unknown;
  }
): Promise<{
  applicationNumber: string;
  email: string;
  playerName: string;
  status: string;
  canSubmit: boolean;
}> {
  const code = await codeForReissue(env, input);
  const application = await ensureApplicationForCode(env, code);
  if (!application) throw new Error("该识别码没有完整申请记录，请联系市长处理");
  if (application.status === "pending") {
    throw new Error(PENDING_IDENTITY_REQUEST_MESSAGE);
  }
  if (application.status === "rejected") {
    throw new Error("该申请已被拒绝，请重新申请身份识别码");
  }
  return {
    applicationNumber: application.application_number,
    email: application.email,
    playerName: application.player_name,
    status: application.status,
    canSubmit: true
  };
}

export async function submitReissue(
  env: Env,
  input: {
    identityCode: unknown;
    applicationNumber: unknown;
    lookupEmail?: unknown;
    email?: unknown;
    locale: unknown;
  }
): Promise<{ applicationNumber: string; status: "pending" }> {
  const code = await codeForReissue(env, {
    identityCode: input.identityCode,
    applicationNumber: input.applicationNumber,
    email: input.lookupEmail ?? input.email
  });
  const application = await ensureApplicationForCode(env, code);
  if (!application) throw new Error("该识别码没有完整申请记录，请联系市长处理");
  if (
    application.request_type === "reissue" &&
    application.status === "rejected"
  ) {
    throw new Error("该申请已被拒绝，请重新申请身份识别码");
  }
  const email = application.email;
  const playerName = application.player_name;
  await assertNoOtherActiveIdentityCode(env, {
    email,
    playerName,
    excludeId: code.id
  });
  await assertNoPendingIdentityApplication(env, {
    email,
    playerName,
    excludeId: application.id
  });
  const submittedAt = now();
  const invalidateCurrentVotes = await currentVoteInvalidations(
    env,
    code.id,
    new Date(submittedAt)
  );
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE identity_code_applications SET
        request_type = 'reissue', email = ?, player_name = ?, status = 'pending',
        locale = ?, submitted_at = ?,
        identity_code_id = ?, reviewed_at = NULL, reviewed_by = NULL,
        rejection_reason = NULL, email_sent_at = NULL, last_email_error = NULL
       WHERE id = ?`
    ).bind(
      email,
      playerName,
      normalizeLocale(input.locale),
      submittedAt,
      code.id,
      application.id
    ),
    env.DB.prepare(
      `UPDATE identity_codes SET status = 'disabled', disabled_at = ?,
       eligibility_override_votes = NULL, eligibility_override_expires_at = NULL,
       updated_at = ? WHERE id = ?`
    ).bind(submittedAt, submittedAt, code.id),
    ...invalidateCurrentVotes
  ]);
  return {
    applicationNumber: application.application_number,
    status: "pending"
  };
}

export async function recoverIdentityCode(
  env: Env,
  input: { email: unknown; playerName: unknown; applicationNumber: unknown }
): Promise<{ status: "sent"; expired: boolean }> {
  const email = cleanEmail(input.email, false);
  const playerName = cleanPlayerName(input.playerName, false);
  const applicationNumber =
    typeof input.applicationNumber === "string"
      ? input.applicationNumber.trim().slice(0, 40)
      : "";
  if (!email && !playerName && !applicationNumber) {
    throw new Error("请至少填写邮箱、申请编号或玩家名称中的一项");
  }
  let candidates: IdentityCodeRow[] = [];
  if (applicationNumber) {
    const application = await env.DB.prepare(
      "SELECT * FROM identity_code_applications WHERE application_number = ?"
    )
      .bind(applicationNumber)
      .first<IdentityApplicationRow>();
    const code = application
      ? await codeForApplication(env, application)
      : null;
    if (code?.status === "active") candidates = [code];
  } else {
    const result = await env.DB.prepare(
      `SELECT * FROM identity_codes
       WHERE status = 'active' ${email ? "AND lower(email) = ?" : ""}
       ORDER BY created_at DESC LIMIT 500`
    )
      .bind(...(email ? [email] : []))
      .all<IdentityCodeRow>();
    candidates = result.results;
  }
  const playerNameKey = identityPlayerNameKey(playerName);
  const matches = candidates.filter(
    (row) =>
      (!email || row.email?.toLowerCase() === email) &&
      (!playerNameKey ||
        identityPlayerNameKey(row.player_name) === playerNameKey)
  );
  if (!matches.length) {
    throw new Error("没有找到符合条件的有效或过期识别码");
  }
  if (matches.length > 1) {
    throw new Error("匹配到多个识别码，请补充更多申请信息后重试");
  }
  const code = matches[0];
  if (!code?.email) {
    throw new Error("申请预留信息不足，请联系市长处理");
  }
  const application = await ensureApplicationForCode(env, code);
  if (!application) {
    throw new Error("申请预留信息不足，请联系市长处理");
  }
  const expired = Boolean(code.expires_at && Date.parse(code.expires_at) <= Date.now());
  const message = identityRecoveryMail({
    locale: code.locale,
    applicationNumber: application.application_number,
    playerName: code.player_name,
    code: await decryptSecret(env, "identity-code-value", code.code_encrypted),
    expiresAt: await localizedExpiry(env, code.expires_at, code.locale),
    expired
  });
  await sendMail(env, { to: code.email, ...message });
  await env.DB.prepare(
    `UPDATE identity_codes SET last_emailed_at = ?, last_email_error = NULL,
     updated_at = ? WHERE id = ?`
  )
    .bind(now(), now(), code.id)
    .run();
  return { status: "sent", expired };
}

export async function requestIdentityCancellation(
  env: Env,
  input: {
    applicationNumber: unknown;
    email: unknown;
    identityCode: unknown;
  }
): Promise<{ challengeId: string; expiresAt: string }> {
  const code = await codeForReissue(env, {
    applicationNumber: input.applicationNumber,
    identityCode: input.identityCode,
    email: input.email
  });
  if (!code.email) throw new Error("申请预留信息不足，请联系市长处理");
  const challengeId = uuid();
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO identity_cancellation_challenges(
      id, identity_code_id, email, code_hash, expires_at, created_at
    ) VALUES(?, ?, ?, ?, ?, ?)`
  ).bind(
    challengeId,
    code.id,
    code.email,
    await challengeHash(env, challengeId, "primary", otp),
    expiresAt,
    now()
  ).run();
  await sendMail(env, {
    to: code.email,
    ...identityCancellationMail({ locale: code.locale, otp })
  });
  return { challengeId, expiresAt };
}

export async function confirmIdentityCancellation(
  env: Env,
  input: { challengeId: unknown; otp: unknown }
): Promise<{ status: "cancelled"; emailSent: boolean; emailError: string | null }> {
  const challengeId = cleanChallengeId(input.challengeId);
  const otp = cleanOtp(input.otp);
  const challenge = await env.DB.prepare(
    `SELECT * FROM identity_cancellation_challenges WHERE id = ?`
  ).bind(challengeId).first<{
    id: string;
    identity_code_id: string;
    code_hash: string;
    attempts: number;
    expires_at: string;
    verified_at: string | null;
    consumed_at: string | null;
  }>();
  if (
    !challenge ||
    challenge.consumed_at ||
    challenge.verified_at ||
    Date.parse(challenge.expires_at) <= Date.now() ||
    challenge.attempts >= 5
  ) {
    throw new Error("验证码已失效，请重新申请");
  }
  const matches = challenge.code_hash === await challengeHash(env, challenge.id, "primary", otp);
  if (!matches) {
    await env.DB.prepare(
      "UPDATE identity_cancellation_challenges SET attempts = attempts + 1 WHERE id = ?"
    ).bind(challenge.id).run();
    throw new Error("验证码错误，请重新输入");
  }
  const code = await env.DB.prepare(
    "SELECT * FROM identity_codes WHERE id = ? AND status = 'active'"
  ).bind(challenge.identity_code_id).first<IdentityCodeRow>();
  if (!code) throw new Error("身份识别码已失效，无法重复注销");
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE identity_cancellation_challenges
       SET verified_at = ?, consumed_at = ? WHERE id = ? AND consumed_at IS NULL`
    ).bind(timestamp, timestamp, challenge.id),
    env.DB.prepare(
      `UPDATE identity_codes SET status = 'disabled', disabled_at = ?,
       eligibility_override_votes = NULL, eligibility_override_expires_at = NULL,
       updated_at = ? WHERE id = ? AND status = 'active'`
    ).bind(timestamp, timestamp, challenge.identity_code_id),
    ...(await currentVoteInvalidations(env, challenge.identity_code_id, new Date(timestamp)))
  ]);
  let emailSent = false;
  let emailError: string | null = null;
  try {
    if (!code.email) throw new Error("识别码没有可用邮箱");
    await sendMail(env, {
      to: code.email,
      ...identityCancellationCompletedMail({
        locale: normalizeLocale(code.locale),
        playerName: code.player_name
      })
    });
    emailSent = true;
  } catch (error) {
    emailError = error instanceof Error ? error.message : String(error);
  }
  await env.DB.prepare(
    `UPDATE identity_cancellation_challenges
     SET email_sent_at = ?, last_email_error = ? WHERE id = ?`
  ).bind(emailSent ? timestamp : null, emailError, challenge.id).run();
  return { status: "cancelled", emailSent, emailError };
}

const PASSWORD_RECOVERY_PROMPT =
  "申请找回密码请输入申请编号、申请时预留的邮箱、身份识别码的其中一项。如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。";

async function findPasswordResetIdentity(
  env: Env,
  input: {
    applicationNumber: unknown;
    email: unknown;
    identityCode: unknown;
  }
): Promise<{ code: IdentityCodeRow; application: IdentityApplicationRow }> {
  const applicationNumber =
    typeof input.applicationNumber === "string"
      ? input.applicationNumber.trim().slice(0, 40)
      : "";
  const email = cleanEmail(input.email, false);
  const identityCode =
    typeof input.identityCode === "string" ? input.identityCode.trim() : "";
  if (!applicationNumber && !email && !identityCode) {
    throw new Error(PASSWORD_RECOVERY_PROMPT);
  }
  let code: IdentityCodeRow | null = null;
  if (applicationNumber) {
    const application = await env.DB.prepare(
      "SELECT * FROM identity_code_applications WHERE application_number = ?"
    )
      .bind(applicationNumber)
      .first<IdentityApplicationRow>();
    if (application) code = await codeForApplication(env, application);
  }
  if (identityCode) {
    const fromValue = await codeByPlaintext(env, identityCode).catch(() => null);
    if (code && fromValue && code.id !== fromValue.id) {
      throw new Error("填写的信息未指向同一份识别码记录");
    }
    code = fromValue;
  }
  if (!code && email) {
    const rows = await env.DB.prepare(
      `SELECT * FROM identity_codes
       WHERE status = 'active' AND lower(email) = ?
       ORDER BY updated_at DESC LIMIT 20`
    )
      .bind(email)
      .all<IdentityCodeRow>();
    if (rows.results.length > 1) {
      throw new Error("匹配到多个识别码，请再填写另一项信息缩小范围");
    }
    code = rows.results[0] ?? null;
  }
  if (!code || code.status !== "active") {
    throw new Error("没有找到符合条件的身份识别码，请核对申请信息");
  }
  if (email && code.email?.toLowerCase() !== email) {
    throw new Error("填写的信息未指向同一份识别码记录");
  }
  if (!code.email) throw new Error("申请预留信息不足，请联系市长人工处理");
  const application = await ensureApplicationForCode(env, code);
  if (!application || application.status !== "approved") {
    throw new Error("申请预留信息不足，请联系市长人工处理");
  }
  return { code, application };
}

function generateOtp(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(value % 1_000_000).padStart(6, "0");
}

async function challengeHash(
  env: Env,
  groupId: string,
  channel: string,
  value: string
): Promise<string> {
  return keyedHash(env, "identity-verification", `${groupId}:${channel}:${value}`);
}

type IdentityApplicationChallengeRow = {
  id: string;
  purpose: "new" | "reissue";
  email: string;
  player_name: string;
  locale: SupportedLocale;
  identity_code_id: string | null;
  application_id: string | null;
  code_hash: string;
  verification_token_hash: string | null;
  attempts: number;
  expires_at: string;
  verified_at: string | null;
  consumed_at: string | null;
};

export async function requestIdentityApplicationVerification(
  env: Env,
  input: {
    purpose: unknown;
    email: unknown;
    playerName?: unknown;
    identityCode?: unknown;
    applicationNumber?: unknown;
    locale: unknown;
  }
): Promise<{ challengeId: string; expiresAt: string }> {
  const purpose = input.purpose === "reissue" ? "reissue" : input.purpose === "new" ? "new" : "";
  if (!purpose) throw new Error("申请验证码用途无效");
  const emailInput = cleanEmail(input.email, false);
  let email = emailInput;
  let playerName = cleanPlayerName(input.playerName, false);
  let identityCodeId: string | null = null;
  let applicationId: string | null = null;
  if (purpose === "new") {
    email = cleanEmail(input.email);
    playerName = cleanPlayerName(input.playerName);
    await assertNoPendingIdentityApplication(env, { email, playerName });
    await assertNoOtherActiveIdentityCode(env, {
      email,
      playerName,
      conflictMessage:
        "您提供的信息可能已经成功申请身份识别码。如果您忘记了身份识别码，请通过“忘记识别码”功能找回。如果这不是您提交的申请，请联系市长处理。"
    });
  } else {
    const code = await codeForReissue(env, {
      identityCode: input.identityCode,
      applicationNumber: input.applicationNumber,
      email: emailInput
    });
    const application = await ensureApplicationForCode(env, code);
    if (!application) throw new Error("该识别码没有完整申请记录，请联系市长处理");
    email = application.email;
    playerName = application.player_name;
    identityCodeId = code.id;
    applicationId = application.id;
  }
  const challengeId = uuid();
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const locale = normalizeLocale(input.locale);
  await env.DB.prepare(
    `INSERT INTO identity_application_challenges(
      id, purpose, email, player_name, locale, identity_code_id, application_id,
      code_hash, expires_at, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      challengeId,
      purpose,
      email,
      playerName,
      locale,
      identityCodeId,
      applicationId,
      await challengeHash(env, challengeId, "application", otp),
      expiresAt,
      now()
    )
    .run();
  await sendMail(env, {
    to: email,
    ...identityApplicationVerificationMail({ locale, otp, purpose })
  });
  return { challengeId, expiresAt };
}

export async function verifyIdentityApplicationVerification(
  env: Env,
  input: { challengeId: unknown; otp: unknown; purpose?: unknown }
): Promise<{ verificationToken: string; expiresAt: string }> {
  const challengeId = cleanChallengeId(input.challengeId);
  const otp = cleanOtp(input.otp);
  const challenge = await env.DB.prepare(
    "SELECT * FROM identity_application_challenges WHERE id = ?"
  )
    .bind(challengeId)
    .first<IdentityApplicationChallengeRow>();
  if (
    !challenge ||
    (input.purpose && challenge.purpose !== input.purpose) ||
    challenge.consumed_at ||
    challenge.verified_at ||
    Date.parse(challenge.expires_at) <= Date.now() ||
    challenge.attempts >= 5
  ) {
    throw new Error("验证码已失效，请重新申请");
  }
  if (challenge.code_hash !== await challengeHash(env, challengeId, "application", otp)) {
    await env.DB.prepare(
      "UPDATE identity_application_challenges SET attempts = attempts + 1 WHERE id = ?"
    ).bind(challenge.id).run();
    throw new Error("验证码错误，请重新输入");
  }
  const verificationToken = `${uuid()}${uuid().replaceAll("-", "")}`;
  await env.DB.prepare(
    `UPDATE identity_application_challenges
     SET verified_at = ?, verification_token_hash = ? WHERE id = ?`
  )
    .bind(now(), await keyedHash(env, "identity-application-token", verificationToken), challenge.id)
    .run();
  return { verificationToken, expiresAt: challenge.expires_at };
}

export async function consumeIdentityApplicationVerification(
  env: Env,
  input: {
    challengeId: unknown;
    verificationToken: unknown;
    purpose: "new" | "reissue";
    email: unknown;
    playerName?: unknown;
    identityCode?: unknown;
  }
): Promise<void> {
  const challengeId = cleanChallengeId(input.challengeId);
  const verificationToken = cleanChallengeToken(input.verificationToken);
  const challenge = await env.DB.prepare(
    "SELECT * FROM identity_application_challenges WHERE id = ?"
  )
    .bind(challengeId)
    .first<IdentityApplicationChallengeRow>();
  const email = cleanEmail(input.email);
  const playerName = cleanPlayerName(input.playerName, false);
  if (
    !challenge ||
    challenge.purpose !== input.purpose ||
    challenge.consumed_at ||
    !challenge.verified_at ||
    !challenge.verification_token_hash ||
    Date.parse(challenge.expires_at) <= Date.now() ||
    challenge.verification_token_hash !== await keyedHash(env, "identity-application-token", verificationToken) ||
    challenge.email !== email ||
    (input.purpose === "new" && challenge.player_name !== playerName)
  ) {
    throw new Error("邮箱验证码验证已失效，请重新申请");
  }
  if (input.purpose === "reissue" && input.identityCode) {
    const code = await codeByPlaintext(env, input.identityCode);
    if (!code || code.id !== challenge.identity_code_id) {
      throw new Error("验证码与旧身份识别码不匹配");
    }
  }
  await env.DB.prepare(
    "UPDATE identity_application_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL"
  ).bind(now(), challenge.id).run();
}

export async function requestIdentityPasswordReset(
  env: Env,
  input: {
    applicationNumber: unknown;
    email: unknown;
    identityCode: unknown;
  }
): Promise<{ challengeId: string; expiresAt: string }> {
  const { code } = await findPasswordResetIdentity(env, input);
  const challengeId = uuid();
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO identity_verification_challenges(
      id, group_id, identity_code_id, purpose, channel, code_hash,
      expires_at, created_at
    ) VALUES(?, ?, ?, 'password_reset', 'primary', ?, ?, ?)`
  )
    .bind(
      challengeId,
      challengeId,
      code.id,
      await challengeHash(env, challengeId, "primary", otp),
      expiresAt,
      now()
    )
    .run();
  const message = identityPasswordResetMail({
    locale: code.locale,
    playerName: code.player_name,
    code: await decryptSecret(env, "identity-code-value", code.code_encrypted),
    otp
  });
  await sendMail(env, { to: code.email!, ...message });
  return { challengeId, expiresAt };
}

export async function verifyIdentityPasswordReset(
  env: Env,
  input: { challengeId: unknown; otp: unknown }
): Promise<{ resetToken: string; expiresAt: string }> {
  const challengeId = cleanChallengeId(input.challengeId);
  const otp = cleanOtp(input.otp);
  const challenge = await env.DB.prepare(
    `SELECT * FROM identity_verification_challenges
     WHERE id = ? AND purpose = 'password_reset' AND channel = 'primary'`
  )
    .bind(challengeId)
    .first<{
      id: string;
      group_id: string;
      code_hash: string;
      reset_token_hash: string | null;
      attempts: number;
      expires_at: string;
      verified_at: string | null;
      consumed_at: string | null;
    }>();
  if (
    !challenge ||
    challenge.consumed_at ||
    challenge.verified_at ||
    Date.parse(challenge.expires_at) <= Date.now() ||
    challenge.attempts >= 5
  ) {
    throw new Error("验证码已失效，请重新申请");
  }
  const matches =
    challenge.code_hash === await challengeHash(env, challenge.group_id, "primary", otp);
  if (!matches) {
    await env.DB.prepare(
      "UPDATE identity_verification_challenges SET attempts = attempts + 1 WHERE id = ?"
    )
      .bind(challenge.id)
      .run();
    throw new Error("验证码错误，请重新输入");
  }
  const resetToken = `${uuid()}${uuid().replaceAll("-", "")}`;
  await env.DB.prepare(
    `UPDATE identity_verification_challenges
     SET verified_at = ?, reset_token_hash = ? WHERE id = ?`
  )
    .bind(now(), await keyedHash(env, "identity-reset-token", resetToken), challenge.id)
    .run();
  return { resetToken, expiresAt: challenge.expires_at };
}

export async function setIdentityPassword(
  env: Env,
  input: { challengeId: unknown; resetToken: unknown; password: unknown }
): Promise<void> {
  const challengeId = cleanChallengeId(input.challengeId);
  const resetToken = cleanChallengeToken(input.resetToken);
  const password = cleanPassword(input.password);
  const challenge = await env.DB.prepare(
    `SELECT * FROM identity_verification_challenges
     WHERE id = ? AND purpose = 'password_reset' AND channel = 'primary'`
  )
    .bind(challengeId)
    .first<{
      id: string;
      identity_code_id: string;
      reset_token_hash: string | null;
      expires_at: string;
      verified_at: string | null;
      consumed_at: string | null;
    }>();
  if (
    !challenge ||
    !challenge.verified_at ||
    challenge.consumed_at ||
    !challenge.reset_token_hash ||
    Date.parse(challenge.expires_at) <= Date.now() ||
    challenge.reset_token_hash !== await keyedHash(env, "identity-reset-token", resetToken)
  ) {
    throw new Error("验证码验证已失效，请重新申请");
  }
  const identity = await env.DB.prepare(
    "SELECT code_encrypted, player_name, email FROM identity_codes WHERE id = ?"
  ).bind(challenge.identity_code_id).first<{
    code_encrypted: string;
    player_name: string | null;
    email: string | null;
  }>();
  if (!identity) throw new Error("身份识别码不存在");
  const plaintextCode = await decryptSecret(env, "identity-code-value", identity.code_encrypted);
  const passwordLower = password.toLowerCase();
  if (
    passwordLower.includes(plaintextCode.toLowerCase()) ||
    (identity.player_name && passwordLower.includes(identity.player_name.toLowerCase())) ||
    (identity.email && passwordLower.includes(identity.email.split("@")[0]!.toLowerCase()))
  ) {
    throw new Error("密码不能包含身份识别码、玩家名称或邮箱用户名");
  }
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE identity_codes SET password_hash = ?, password_set_at = COALESCE(password_set_at, ?),
       password_updated_at = ?, updated_at = ? WHERE id = ?`
    ).bind(await hashPassword(password), timestamp, timestamp, timestamp, challenge.identity_code_id),
    env.DB.prepare(
      "UPDATE identity_verification_challenges SET consumed_at = ? WHERE id = ?"
    ).bind(timestamp, challenge.id)
  ]);
}

async function authenticatedCode(
  env: Env,
  input: { identityCode: unknown; password: unknown }
): Promise<IdentityCodeRow> {
  const verification = await verifyIdentityPassword(env, input);
  if (verification.ok) return verification.code;
  if (verification.reason === "password_required") {
    throw new Error("旧身份识别码尚未设置密码，请使用忘记密码功能设置密码");
  }
  if (verification.reason === "invalid_password") throw new Error("身份识别码或密码错误");
  if (verification.reason === "disabled" || verification.reason === "expired") {
    // A pending reissue temporarily disables the current code. Check the
    // request state first so follow-up profile changes are blocked by the
    // same pending-request rule instead of reporting a misleading status.
    if (typeof input.identityCode === "string" && input.identityCode.trim()) {
      const code = await codeByPlaintext(env, input.identityCode);
      if (code) await assertNoPendingIdentityRequest(env, code.id);
    }
  }
  if (verification.reason === "disabled") throw new Error("身份识别码已被禁用");
  if (verification.reason === "expired") throw new Error("身份识别码已过期");
  throw new Error("身份识别码无效");
}

export async function updateIdentityPlayerName(
  env: Env,
  input: { identityCode: unknown; password: unknown; playerName: unknown }
): Promise<{ playerName: string; status: "pending" }> {
  const code = await authenticatedCode(env, input);
  const playerName = cleanPlayerName(input.playerName);
  await assertNoPendingIdentityRequest(env, code.id);
  if (identityPlayerNameKey(playerName) === identityPlayerNameKey(code.player_name)) {
    throw new Error("新的玩家名称不能与当前名称相同");
  }
  await assertNoOtherActiveIdentityCode(env, {
    email: code.email,
    playerName,
    excludeId: code.id
  });
  await env.DB.prepare(
    `INSERT INTO identity_profile_change_requests(
      id, identity_code_id, kind, requested_player_name, status, submitted_at
    ) VALUES(?, ?, 'player_name', ?, 'pending', ?)`
  ).bind(uuid(), code.id, playerName, now()).run();
  return { playerName, status: "pending" };
}

export async function requestIdentityEmailChange(
  env: Env,
  input: { identityCode: unknown; password: unknown; newEmail: unknown }
): Promise<{ changeId: string; expiresAt: string }> {
  const code = await authenticatedCode(env, input);
  if (!code.email) throw new Error("当前识别码没有绑定邮箱，请联系市长人工处理");
  await assertNoPendingIdentityRequest(env, code.id);
  const newEmail = cleanEmail(input.newEmail);
  if (newEmail === code.email.toLowerCase()) throw new Error("新邮箱不能与当前邮箱相同");
  await assertNoOtherActiveIdentityCode(env, {
    email: newEmail,
    playerName: null,
    excludeId: code.id
  });
  const changeId = uuid();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const oldOtp = generateOtp();
  const newOtp = generateOtp();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO identity_verification_challenges(
        id, group_id, identity_code_id, purpose, channel, code_hash,
        new_email, expires_at, created_at
      ) VALUES(?, ?, ?, 'email_change', 'old_email', ?, ?, ?, ?)`
    ).bind(
      uuid(), changeId, code.id,
      await challengeHash(env, changeId, "old_email", oldOtp),
      newEmail, expiresAt, now()
    ),
    env.DB.prepare(
      `INSERT INTO identity_verification_challenges(
        id, group_id, identity_code_id, purpose, channel, code_hash,
        new_email, expires_at, created_at
      ) VALUES(?, ?, ?, 'email_change', 'new_email', ?, ?, ?, ?)`
    ).bind(
      uuid(), changeId, code.id,
      await challengeHash(env, changeId, "new_email", newOtp),
      newEmail, expiresAt, now()
    )
  ]);
  await Promise.all([
    sendMail(env, {
      to: code.email,
      ...identityEmailChangeMail({ locale: code.locale, otp: oldOtp, newEmail })
    }),
    sendMail(env, {
      to: newEmail,
      ...identityEmailChangeMail({ locale: code.locale, otp: newOtp, newEmail })
    })
  ]);
  return { changeId, expiresAt };
}

export async function confirmIdentityEmailChange(
  env: Env,
  input: { changeId: unknown; oldOtp: unknown; newOtp: unknown }
): Promise<{ email: string; status: "pending" }> {
  const changeId = cleanChallengeId(input.changeId);
  const oldOtp = cleanOtp(input.oldOtp);
  const newOtp = cleanOtp(input.newOtp);
  const rows = await env.DB.prepare(
    `SELECT * FROM identity_verification_challenges
     WHERE group_id = ? AND purpose = 'email_change'`
  )
    .bind(changeId)
    .all<{
      id: string;
      identity_code_id: string;
      channel: "old_email" | "new_email";
      code_hash: string;
      new_email: string;
      attempts: number;
      expires_at: string;
      consumed_at: string | null;
    }>();
  const oldRow = rows.results.find((row) => row.channel === "old_email");
  const newRow = rows.results.find((row) => row.channel === "new_email");
  if (!oldRow || !newRow || oldRow.consumed_at || newRow.consumed_at || Date.parse(oldRow.expires_at) <= Date.now()) {
    throw new Error("邮箱验证码已失效，请重新申请");
  }
  if (oldRow.attempts >= 5 || newRow.attempts >= 5) throw new Error("验证码尝试次数过多，请重新申请");
  const oldMatches = oldRow.code_hash === await challengeHash(env, changeId, "old_email", oldOtp);
  const newMatches = newRow.code_hash === await challengeHash(env, changeId, "new_email", newOtp);
  if (!oldMatches || !newMatches) {
    await env.DB.batch([
      ...(oldMatches ? [] : [env.DB.prepare("UPDATE identity_verification_challenges SET attempts = attempts + 1 WHERE id = ?").bind(oldRow.id)]),
      ...(newMatches ? [] : [env.DB.prepare("UPDATE identity_verification_challenges SET attempts = attempts + 1 WHERE id = ?").bind(newRow.id)])
    ]);
    throw new Error("邮箱验证码错误，请重新输入");
  }
  const timestamp = now();
  const code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
    .bind(oldRow.identity_code_id).first<IdentityCodeRow>();
  if (!code) throw new Error("识别码不存在");
  await assertNoPendingIdentityRequest(env, code.id, {
    excludeEmailChangeGroupId: changeId
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO identity_profile_change_requests(
        id, identity_code_id, kind, requested_email, status, submitted_at
      ) VALUES(?, ?, 'email', ?, 'pending', ?)`
    ).bind(uuid(), code.id, newRow.new_email, timestamp),
    env.DB.prepare("UPDATE identity_verification_challenges SET consumed_at = ? WHERE group_id = ?")
      .bind(timestamp, changeId)
  ]);
  return { email: newRow.new_email, status: "pending" };
}

export interface IdentityProfileChangeRequestRow {
  id: string;
  identity_code_id: string;
  kind: "player_name" | "email";
  requested_player_name: string | null;
  requested_email: string | null;
  status: "pending" | "approved" | "rejected";
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  email_sent_at: string | null;
  last_email_error: string | null;
  current_player_name: string | null;
  current_email: string | null;
}

export async function listIdentityProfileChangeRequests(
  env: Env,
  input: { page: number; status: string }
): Promise<{ items: IdentityProfileChangeRequestRow[]; page: number; pageSize: 20; total: number }> {
  const page = Math.max(1, Math.floor(input.page));
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (["pending", "approved", "rejected"].includes(input.status)) {
    clauses.push("r.status = ?");
    bindings.push(input.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM identity_profile_change_requests r ${where}`
  ).bind(...bindings).first<{ total: number }>();
  const rows = await env.DB.prepare(
    `SELECT r.*, c.player_name AS current_player_name, c.email AS current_email
     FROM identity_profile_change_requests r
     JOIN identity_codes c ON c.id = r.identity_code_id
     ${where}
     ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.submitted_at DESC
     LIMIT 20 OFFSET ?`
  ).bind(...bindings, (page - 1) * 20).all<IdentityProfileChangeRequestRow>();
  return { items: rows.results, page, pageSize: 20, total: total?.total ?? 0 };
}

type IdentityReviewMailResult = {
  emailSent: boolean;
  emailError: string | null;
};

async function sendIdentityProfileChangeMail(
  env: Env,
  request: IdentityProfileChangeRequestRow,
  code: IdentityCodeRow,
  approved: boolean,
  reason: string | null
): Promise<IdentityReviewMailResult> {
  const requestedValue = request.kind === "player_name"
    ? request.requested_player_name
    : request.requested_email;
  const recipient = approved && request.kind === "email"
    ? request.requested_email
    : code.email;
  if (!recipient || !requestedValue) {
    return { emailSent: false, emailError: "资料变更邮件缺少收件邮箱或变更内容" };
  }
  let applicationNumber: string | null = null;
  let locale = normalizeLocale(code.locale);
  if (code.application_id) {
    const application = await env.DB.prepare(
      "SELECT application_number, locale FROM identity_code_applications WHERE id = ?"
    ).bind(code.application_id).first<{
      application_number: string;
      locale: SupportedLocale;
    }>();
    applicationNumber = application?.application_number ?? null;
    locale = normalizeLocale(application?.locale ?? code.locale);
  }
  try {
    await sendMail(env, {
      to: recipient,
      ...identityProfileChangeMail({
        locale,
        approved,
        kind: request.kind,
        applicationNumber,
        currentValue: request.kind === "player_name" ? code.player_name : code.email,
        requestedValue,
        reason
      })
    });
    return { emailSent: true, emailError: null };
  } catch (error) {
    return {
      emailSent: false,
      emailError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function recordIdentityProfileChangeMailResult(
  env: Env,
  requestId: string,
  result: IdentityReviewMailResult
): Promise<void> {
  await env.DB.prepare(
    `UPDATE identity_profile_change_requests
     SET email_sent_at = ?, last_email_error = ? WHERE id = ?`
  ).bind(result.emailSent ? now() : null, result.emailError, requestId).run();
}

export async function reviewIdentityProfileChangeRequest(
  env: Env,
  input: { id: string; action: "approve" | "reject"; reviewedBy: string; reason?: string }
): Promise<IdentityReviewMailResult> {
  const request = await env.DB.prepare(
    "SELECT * FROM identity_profile_change_requests WHERE id = ?"
  ).bind(input.id).first<IdentityProfileChangeRequestRow>();
  if (!request) throw new Error("资料变更申请不存在");
  if (request.status !== "pending") throw new Error("资料变更申请已处理");
  const code = await env.DB.prepare(
    "SELECT * FROM identity_codes WHERE id = ?"
  ).bind(request.identity_code_id).first<IdentityCodeRow>();
  if (!code) throw new Error("识别码不存在");
  const timestamp = now();
  if (input.action === "reject") {
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "管理员拒绝了本次资料变更申请";
    await env.DB.prepare(
      `UPDATE identity_profile_change_requests
       SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, rejection_reason = ? WHERE id = ?`
    ).bind(timestamp, input.reviewedBy, reason, request.id).run();
    const mailResult = await sendIdentityProfileChangeMail(env, request, code, false, reason);
    await recordIdentityProfileChangeMailResult(env, request.id, mailResult);
    return mailResult;
  }
  const statements: D1PreparedStatement[] = [];
  if (request.kind === "player_name" && request.requested_player_name) {
    statements.push(
      env.DB.prepare("UPDATE identity_codes SET player_name = ?, updated_at = ? WHERE id = ?")
        .bind(request.requested_player_name, timestamp, request.identity_code_id),
      env.DB.prepare(
        "UPDATE identity_code_applications SET player_name = ? WHERE identity_code_id = ? AND status = 'approved'"
      ).bind(request.requested_player_name, request.identity_code_id)
    );
  } else if (request.kind === "email" && request.requested_email) {
    statements.push(
      env.DB.prepare("UPDATE identity_codes SET email = ?, updated_at = ? WHERE id = ?")
        .bind(request.requested_email, timestamp, request.identity_code_id),
      env.DB.prepare(
        "UPDATE identity_code_applications SET email = ? WHERE identity_code_id = ? AND status = 'approved'"
      ).bind(request.requested_email, request.identity_code_id)
    );
  } else {
    throw new Error("资料变更内容无效");
  }
  statements.push(
    env.DB.prepare(
      `UPDATE identity_profile_change_requests
       SET status = 'approved', reviewed_at = ?, reviewed_by = ?, rejection_reason = NULL WHERE id = ?`
    ).bind(timestamp, input.reviewedBy, request.id)
  );
  await env.DB.batch(statements);
  const mailResult = await sendIdentityProfileChangeMail(env, request, code, true, null);
  await recordIdentityProfileChangeMailResult(env, request.id, mailResult);
  return mailResult;
}

export async function listIdentityApplications(
  env: Env,
  input: { page: number; search: string; status: string }
): Promise<{ items: IdentityReviewItem[]; page: number; pageSize: 10; total: number }> {
  const page = Math.max(1, Math.floor(input.page));
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (input.search) {
    clauses.push(
      "(application_number LIKE ? OR player_name LIKE ? OR lower(email) LIKE ?)"
    );
    const search = `%${input.search.slice(0, 80).toLowerCase()}%`;
    bindings.push(search, search, search);
  }
  if (["pending", "approved", "rejected"].includes(input.status)) {
    clauses.push("status = ?");
    bindings.push(input.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const reviewItems = `
    WITH review_items AS (
      SELECT
        'application' AS record_type,
        a.id,
        a.application_number,
        a.request_type,
        a.email,
        a.player_name,
        a.locale,
        a.status,
        a.identity_code_id,
        a.submitted_at,
        a.reviewed_at,
        a.reviewed_by,
        a.rejection_reason,
        a.email_sent_at,
        a.last_email_error,
        NULL AS profile_kind,
        NULL AS current_player_name,
        NULL AS current_email,
        NULL AS requested_player_name,
        NULL AS requested_email,
        NULL AS eligibility_reason,
        NULL AS eligibility_weekly_contribution,
        NULL AS eligibility_technology_points,
        NULL AS eligibility_material_contribution,
        NULL AS eligibility_weekly_activity_points,
        NULL AS approved_votes,
        NULL AS approved_expires_at
      FROM identity_code_applications a
      UNION ALL
      SELECT
        'profile_change' AS record_type,
        r.id,
        a.application_number,
        'profile_change' AS request_type,
        CASE WHEN r.kind = 'email' THEN COALESCE(r.requested_email, c.email) ELSE c.email END AS email,
        CASE WHEN r.kind = 'player_name' THEN COALESCE(r.requested_player_name, c.player_name) ELSE c.player_name END AS player_name,
        COALESCE(a.locale, c.locale, 'zh-cn') AS locale,
        r.status,
        r.identity_code_id,
        r.submitted_at,
        r.reviewed_at,
        r.reviewed_by,
        r.rejection_reason,
        r.email_sent_at,
        r.last_email_error,
        r.kind AS profile_kind,
        c.player_name AS current_player_name,
        c.email AS current_email,
        r.requested_player_name,
        r.requested_email,
        NULL AS eligibility_reason,
        NULL AS eligibility_weekly_contribution,
        NULL AS eligibility_technology_points,
        NULL AS eligibility_material_contribution,
        NULL AS eligibility_weekly_activity_points,
        NULL AS approved_votes,
        NULL AS approved_expires_at
      FROM identity_profile_change_requests r
      JOIN identity_codes c ON c.id = r.identity_code_id
      LEFT JOIN identity_code_applications a ON a.id = c.application_id
      UNION ALL
      SELECT
        'eligibility_override' AS record_type,
        v.id,
        v.application_number,
        'eligibility_override' AS request_type,
        v.email,
        v.player_name,
        v.locale,
        v.status,
        v.identity_code_id,
        v.submitted_at,
        v.reviewed_at,
        v.reviewed_by,
        v.rejection_reason,
        v.email_sent_at,
        v.last_email_error,
        NULL AS profile_kind,
        NULL AS current_player_name,
        NULL AS current_email,
        NULL AS requested_player_name,
        NULL AS requested_email,
        v.reason AS eligibility_reason,
        v.weekly_contribution AS eligibility_weekly_contribution,
        v.technology_points AS eligibility_technology_points,
        v.material_contribution AS eligibility_material_contribution,
        v.weekly_activity_points AS eligibility_weekly_activity_points,
        v.approved_votes,
        v.approved_expires_at
      FROM vote_eligibility_applications v
    )
  `;
  const totalRow = await env.DB.prepare(
    `${reviewItems} SELECT COUNT(*) AS total FROM review_items ${where}`
  )
    .bind(...bindings)
    .first<{ total: number }>();
  const result = await env.DB.prepare(
    `${reviewItems} SELECT * FROM review_items ${where}
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, submitted_at DESC
     LIMIT 10 OFFSET ?`
  )
    .bind(...bindings, (page - 1) * 10)
    .all<IdentityReviewItem>();
  const items = await Promise.all(result.results.map(async (item) => {
    if (item.record_type !== "eligibility_override" || !item.identity_code_id) return item;
    const current = await getVoteEligibilityStats(env, item.player_name, item.identity_code_id);
    return {
      ...item,
      eligibility_weekly_contribution: current.weeklyContribution,
      eligibility_technology_points: current.technologyPoints,
      eligibility_material_contribution: current.materialContribution,
      eligibility_weekly_activity_points: current.weeklyActivityPoints
    };
  }));
  return { items, page, pageSize: 10, total: totalRow?.total ?? 0 };
}

export async function submitVoteEligibilityApplication(
  env: Env,
  input: {
    identityCode: unknown;
    password: unknown;
    locale: unknown;
    reason: unknown;
  }
): Promise<{ applicationNumber: string; status: "pending" }> {
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1_000) : "";
  if (!reason) throw new Error("请填写申请理由");
  const verification = await verifyIdentityPassword(env, {
    identityCode: input.identityCode,
    password: input.password
  });
  if (!verification.ok) {
    if (verification.reason === "invalid_password") throw new Error("身份识别码或密码错误");
    if (verification.reason === "password_required") throw new Error("该身份识别码尚未设置密码，请先使用忘记密码功能");
    if (verification.reason === "disabled") throw new Error("身份识别码已被禁用");
    if (verification.reason === "expired") throw new Error("身份识别码已过期");
    throw new Error("身份识别码无效");
  }
  if (!verification.code.email) throw new Error("当前识别码未绑定邮箱，无法提交投票资格申请");
  const config = await getDailyVoteConfig(env);
  if (!config.voteEligibilityEnabled) throw new Error("管理员已关闭投票资格校验，无需申请破格资格");
  await assertNoPendingIdentityRequest(env, verification.code.id);
  const eligibility = await evaluateVoteEligibility(env, {
    playerName: verification.code.player_name,
    identityCodeId: verification.code.id,
    enabled: true,
    thresholds: config.voteEligibility,
    override: {
      votesRemaining: verification.code.eligibility_override_votes,
      expiresAt: verification.code.eligibility_override_expires_at
    }
  });
  if (eligibility.eligible) throw new Error("当前身份识别码已满足投票资格，无需申请破格资格");
  const pending = await env.DB.prepare(
    `SELECT id FROM vote_eligibility_applications
     WHERE identity_code_id = ? AND status = 'pending' LIMIT 1`
  ).bind(verification.code.id).first();
  if (pending) throw new Error("已有待审核的投票资格申请，请等待管理员审核完成");
  const id = uuid();
  const applicationNumber = await generateApplicationNumber(env);
  await env.DB.prepare(
    `INSERT INTO vote_eligibility_applications(
      id, application_number, identity_code_id, email, player_name, locale, reason,
      weekly_contribution, technology_points, material_contribution, weekly_activity_points,
      status, submitted_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(
    id,
    applicationNumber,
    verification.code.id,
    verification.code.email ?? "",
    verification.code.player_name ?? "",
    normalizeLocale(input.locale),
    reason,
    eligibility.current.weeklyContribution,
    eligibility.current.technologyPoints,
    eligibility.current.materialContribution,
    eligibility.current.weeklyActivityPoints,
    now()
  ).run();
  return { applicationNumber, status: "pending" };
}

async function voteEligibilityApplicationById(
  env: Env,
  id: string
): Promise<VoteEligibilityApplicationRow | null> {
  return env.DB.prepare(
    "SELECT * FROM vote_eligibility_applications WHERE id = ?"
  ).bind(id).first<VoteEligibilityApplicationRow>();
}

function parseVoteEligibilityApproval(input: {
  mode: unknown;
  votes: unknown;
  expiresAt: unknown;
}): { votes: number | null; expiresAt: string | null } {
  const mode = input.mode === "date" ? "date" : input.mode === "votes" ? "votes" : "";
  if (mode === "votes") {
    const votes = Number(input.votes);
    if (!Number.isInteger(votes) || votes < 1 || votes > 10_000 || input.expiresAt) {
      throw new Error("破格投票次数与破格有效日期只能选择一种批准方式");
    }
    return { votes, expiresAt: null };
  }
  if (mode === "date") {
    const value = typeof input.expiresAt === "string" ? input.expiresAt.trim() : "";
    const parsed = new Date(value);
    if (!value || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now() || input.votes !== null && input.votes !== undefined && input.votes !== "") {
      throw new Error("破格投票次数与破格有效日期只能选择一种批准方式");
    }
    return { votes: null, expiresAt: parsed.toISOString() };
  }
  throw new Error("请选择破格投票次数或破格有效日期中的一种批准方式");
}

export async function approveVoteEligibilityApplication(
  env: Env,
  input: {
    id: string;
    mode: unknown;
    votes: unknown;
    expiresAt: unknown;
    reviewedBy: string;
  }
): Promise<{ emailSent: boolean; emailError: string | null }> {
  const application = await voteEligibilityApplicationById(env, input.id);
  if (!application) throw new Error("申请不存在");
  if (application.status !== "pending") throw new Error("申请已处理");
  const approval = parseVoteEligibilityApproval(input);
  const current = await getVoteEligibilityStats(env, application.player_name, application.identity_code_id);
  const currentApplication = {
    ...application,
    weekly_contribution: current.weeklyContribution,
    technology_points: current.technologyPoints,
    material_contribution: current.materialContribution,
    weekly_activity_points: current.weeklyActivityPoints
  };
  const reviewedAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE identity_codes SET eligibility_override_votes = ?,
       eligibility_override_expires_at = ?, updated_at = ? WHERE id = ?`
    ).bind(approval.votes, approval.expiresAt, reviewedAt, application.identity_code_id),
    env.DB.prepare(
      `UPDATE vote_eligibility_applications SET status = 'approved', reviewed_at = ?,
       reviewed_by = ?, rejection_reason = NULL, approved_votes = ?,
       approved_expires_at = ? WHERE id = ?`
    ).bind(
      reviewedAt,
      input.reviewedBy,
      approval.votes,
      approval.expiresAt,
      application.id
    )
  ]);
  try {
    await sendVoteEligibilityApplicationMail(env, currentApplication, {
      approved: true,
      votes: approval.votes,
      expiresAt: approval.expiresAt
    });
    await recordVoteEligibilityMailResult(env, application.id, null);
    return { emailSent: true, emailError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordVoteEligibilityMailResult(env, application.id, message);
    return { emailSent: false, emailError: message };
  }
}

export async function rejectVoteEligibilityApplication(
  env: Env,
  input: { id: string; reason: string; reviewedBy: string }
): Promise<{ emailSent: boolean; emailError: string | null }> {
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (!reason) throw new Error("请填写拒绝理由");
  const application = await voteEligibilityApplicationById(env, input.id);
  if (!application) throw new Error("申请不存在");
  if (application.status !== "pending") throw new Error("申请已处理");
  const current = await getVoteEligibilityStats(env, application.player_name, application.identity_code_id);
  const currentApplication = {
    ...application,
    weekly_contribution: current.weeklyContribution,
    technology_points: current.technologyPoints,
    material_contribution: current.materialContribution,
    weekly_activity_points: current.weeklyActivityPoints
  };
  const reviewedAt = now();
  await env.DB.prepare(
    `UPDATE vote_eligibility_applications SET status = 'rejected', reviewed_at = ?,
     reviewed_by = ?, rejection_reason = ? WHERE id = ?`
  ).bind(reviewedAt, input.reviewedBy, reason, application.id).run();
  try {
    await sendVoteEligibilityApplicationMail(env, currentApplication, { approved: false, reason });
    await recordVoteEligibilityMailResult(env, application.id, null);
    return { emailSent: true, emailError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordVoteEligibilityMailResult(env, application.id, message);
    return { emailSent: false, emailError: message };
  }
}

async function sendVoteEligibilityApplicationMail(
  env: Env,
  application: VoteEligibilityApplicationRow,
  input: { approved: boolean; votes?: number | null; expiresAt?: string | null; reason?: string }
): Promise<void> {
  const locale = normalizeLocale(application.locale);
  const message = voteEligibilityMail({
    locale,
    approved: input.approved,
    applicationNumber: application.application_number,
    playerName: application.player_name,
    reason: application.reason,
    rejectionReason: input.approved ? null : input.reason ?? null,
    weeklyContribution: application.weekly_contribution,
    technologyPoints: application.technology_points,
    materialContribution: application.material_contribution,
    weeklyActivityPoints: application.weekly_activity_points,
    votes: input.votes ?? null,
    expiresAt: await localizedExpiry(env, input.expiresAt ?? null, locale)
  });
  await sendMail(env, { to: application.email, ...message });
}

async function recordVoteEligibilityMailResult(
  env: Env,
  applicationId: string,
  error: string | null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE vote_eligibility_applications SET email_sent_at = ?, last_email_error = ? WHERE id = ?`
  ).bind(error ? null : now(), error, applicationId).run();
}

function parseExpiry(input: { permanent: unknown; expiresAt: unknown }): string | null {
  if (input.permanent === true) return null;
  const value = typeof input.expiresAt === "string" ? input.expiresAt.trim() : "";
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new Error("有效期必须晚于当前时间，或选择永久有效");
  }
  return date.toISOString();
}

async function sendApplicationMail(
  env: Env,
  application: IdentityApplicationRow,
  input: {
    approved: boolean;
    code?: IdentityCodeRow | null;
    initialPassword?: string;
    expiresAt?: string | null;
    reason?: string | null;
  }
): Promise<void> {
  let plaintext: string | undefined;
  if (input.code) {
    plaintext = await decryptSecret(env, "identity-code-value", input.code.code_encrypted);
  }
  const message = identityMail({
    locale: normalizeLocale(application.locale),
    approved: input.approved,
    requestType: application.request_type,
    applicationNumber: application.application_number,
    playerName: application.player_name,
    ...(plaintext ? { code: plaintext } : {}),
    ...(input.initialPassword ? { password: input.initialPassword } : {}),
    expiresAt: await localizedExpiry(
      env,
      input.expiresAt,
      normalizeLocale(application.locale)
    ),
    reason: input.reason
  });
  await sendMail(env, { to: application.email, ...message });
}

export async function approveIdentityApplication(
  env: Env,
  input: { id: string; permanent: unknown; expiresAt: unknown; reviewedBy: string }
): Promise<{ emailSent: boolean; emailError: string | null }> {
  const application = await env.DB.prepare(
    "SELECT * FROM identity_code_applications WHERE id = ?"
  )
    .bind(input.id)
    .first<IdentityApplicationRow>();
  if (!application) throw new Error("申请不存在");
  if (application.status !== "pending") throw new Error("申请已处理");
  const expiresAt = parseExpiry(input);
  const reviewedAt = now();
  let code: IdentityCodeRow | null = null;
  let initialPassword: string | undefined;
  if (application.request_type === "renewal") {
    if (!application.identity_code_id) throw new Error("延期申请未关联识别码");
    await assertNoOtherActiveIdentityCode(env, {
      email: application.email,
      playerName: application.player_name,
      excludeId: application.identity_code_id
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE identity_codes SET
         email = ?, player_name = ?, locale = ?, expires_at = ?, status = 'active',
         disabled_at = NULL, renewal_grace_vote_used_at = NULL, updated_at = ?
         WHERE id = ?`
      ).bind(
        application.email,
        application.player_name,
        application.locale,
        expiresAt,
        reviewedAt,
        application.identity_code_id
      ),
      env.DB.prepare(
        `UPDATE identity_code_applications SET status = 'approved', reviewed_at = ?,
         reviewed_by = ?, rejection_reason = NULL WHERE id = ?`
      ).bind(reviewedAt, input.reviewedBy, application.id)
    ]);
    code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
      .bind(application.identity_code_id)
      .first<IdentityCodeRow>();
  } else if (application.request_type === "reissue") {
    if (!application.identity_code_id) throw new Error("更换申请未关联识别码");
    await assertNoOtherActiveIdentityCode(env, {
      email: application.email,
      playerName: application.player_name,
      excludeId: application.identity_code_id
    });
    const generated = await generateCode(env);
    initialPassword = generateInitialPassword();
    const invalidateCurrentVotes = await currentVoteInvalidations(
      env,
      application.identity_code_id,
      new Date(reviewedAt)
    );
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE identity_codes SET
           code_hash = ?, code_encrypted = ?, player_name = ?, email = ?,
           locale = ?, status = 'active', expires_at = ?, disabled_at = NULL,
           renewal_grace_vote_used_at = NULL, eligibility_override_votes = NULL,
           eligibility_override_expires_at = NULL, password_hash = ?,
           password_set_at = ?, password_updated_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(
        generated.hash,
        await encryptSecret(env, "identity-code-value", generated.code),
        application.player_name,
        application.email,
        application.locale,
        expiresAt,
        await hashPassword(initialPassword),
        reviewedAt,
        reviewedAt,
        reviewedAt,
        application.identity_code_id
      ),
      env.DB.prepare(
        `UPDATE identity_code_applications SET status = 'approved',
         reviewed_at = ?, reviewed_by = ?, rejection_reason = NULL WHERE id = ?`
      ).bind(reviewedAt, input.reviewedBy, application.id),
      ...invalidateCurrentVotes
    ]);
    code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
      .bind(application.identity_code_id)
      .first<IdentityCodeRow>();
  } else {
    await assertNoOtherActiveIdentityCode(env, {
      email: application.email,
      playerName: application.player_name
    });
    const generated = await generateCode(env);
    initialPassword = generateInitialPassword();
    const codeId = uuid();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO identity_codes(
          id, code_hash, code_encrypted, player_name, email, locale, application_id,
          status, expires_at, created_by, created_at, updated_at,
          password_hash, password_set_at, password_updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        codeId,
        generated.hash,
        await encryptSecret(env, "identity-code-value", generated.code),
        application.player_name,
        application.email,
        application.locale,
        application.id,
        expiresAt,
        input.reviewedBy,
        reviewedAt,
        reviewedAt,
        await hashPassword(initialPassword),
        reviewedAt,
        reviewedAt
      ),
      env.DB.prepare(
        `UPDATE identity_code_applications SET status = 'approved',
         identity_code_id = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?`
      ).bind(codeId, reviewedAt, input.reviewedBy, application.id)
    ]);
    code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
      .bind(codeId)
      .first<IdentityCodeRow>();
  }
  try {
    await sendApplicationMail(env, application, {
      approved: true,
      code,
      expiresAt,
      initialPassword
    });
    await recordMailResult(env, application.id, code?.id ?? null, null);
    return { emailSent: true, emailError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordMailResult(
      env,
      application.id,
      code?.id ?? null,
      message
    );
    return { emailSent: false, emailError: message };
  }
}

export async function rejectIdentityApplication(
  env: Env,
  input: { id: string; reason: string; reviewedBy: string }
): Promise<{ emailSent: boolean; emailError: string | null }> {
  const reason =
    typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (!reason) throw new Error("请填写拒绝理由");
  const application = await env.DB.prepare(
    "SELECT * FROM identity_code_applications WHERE id = ?"
  )
    .bind(input.id)
    .first<IdentityApplicationRow>();
  if (!application) throw new Error("申请不存在");
  if (application.status !== "pending") throw new Error("申请已处理");
  const reviewedAt = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE identity_code_applications SET status = 'rejected', reviewed_at = ?,
       reviewed_by = ?, rejection_reason = ? WHERE id = ?`
    ).bind(
      reviewedAt,
      input.reviewedBy,
      reason,
      input.id
    )
  ];
  if (
    application.identity_code_id &&
    (application.request_type === "renewal" ||
      application.request_type === "reissue")
  ) {
    statements.push(
      env.DB.prepare(
        `UPDATE identity_codes SET status = 'disabled', disabled_at = ?,
         eligibility_override_votes = NULL, eligibility_override_expires_at = NULL,
         updated_at = ? WHERE id = ?`
      ).bind(reviewedAt, reviewedAt, application.identity_code_id)
    );
    statements.push(
      ...(await currentVoteInvalidations(
        env,
        application.identity_code_id,
        new Date(reviewedAt)
      ))
    );
  }
  await env.DB.batch(statements);
  try {
    await sendApplicationMail(env, application, {
      approved: false,
      reason
    });
    await recordMailResult(env, application.id, application.identity_code_id, null);
    return { emailSent: true, emailError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordMailResult(
      env,
      application.id,
      application.identity_code_id,
      message
    );
    return { emailSent: false, emailError: message };
  }
}

async function recordMailResult(
  env: Env,
  applicationId: string | null,
  codeId: string | null,
  error: string | null
): Promise<void> {
  const timestamp = now();
  const statements: D1PreparedStatement[] = [];
  if (applicationId) {
    statements.push(
      env.DB.prepare(
        `UPDATE identity_code_applications SET email_sent_at = ?,
         last_email_error = ? WHERE id = ?`
      ).bind(error ? null : timestamp, error, applicationId)
    );
  }
  if (codeId) {
    statements.push(
      env.DB.prepare(
        `UPDATE identity_codes SET last_emailed_at = ?,
         last_email_error = ? WHERE id = ?`
      ).bind(error ? null : timestamp, error, codeId)
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function listIdentityCodes(
  env: Env,
  input: { page: number; search: string; status: string; includeCode?: boolean }
): Promise<{
  items: Array<
    IdentityCodeRow & { code: string; application_number: string | null }
  >;
  page: number;
  pageSize: 10;
  total: number;
}> {
  const page = Math.max(1, Math.floor(input.page));
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  const search = input.search.slice(0, 80).trim();
  if (search) {
    const textSearch = `%${search.toLowerCase()}%`;
    if (/^\d{8}$/.test(search)) {
      clauses.push(
        "(c.code_hash = ? OR lower(c.player_name) LIKE ? OR lower(c.email) LIKE ?)"
      );
      bindings.push(
        await keyedHash(env, "identity-code", search),
        textSearch,
        textSearch
      );
    } else {
      clauses.push(
        `(lower(c.player_name) LIKE ? OR lower(c.email) LIKE ? OR EXISTS (
          SELECT 1 FROM identity_code_applications search_application
          WHERE (
            search_application.id = c.application_id
            OR search_application.identity_code_id = c.id
          ) AND lower(search_application.application_number) LIKE ?
        ))`
      );
      bindings.push(textSearch, textSearch, textSearch);
    }
  }
  const timestamp = now();
  if (input.status === "active") {
    clauses.push(
      "c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > ?)"
    );
    bindings.push(timestamp);
  } else if (input.status === "expired") {
    clauses.push(
      "c.status = 'active' AND c.expires_at IS NOT NULL AND c.expires_at <= ?"
    );
    bindings.push(timestamp);
  } else if (input.status === "disabled") {
    clauses.push("c.status = 'disabled'");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM identity_codes c ${where}`
  )
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await env.DB.prepare(
    `SELECT c.*,
      COALESCE(
        (
          SELECT direct_application.application_number
          FROM identity_code_applications direct_application
          WHERE direct_application.id = c.application_id
          LIMIT 1
        ),
        (
          SELECT inverse_application.application_number
          FROM identity_code_applications inverse_application
          WHERE inverse_application.identity_code_id = c.id
          ORDER BY inverse_application.reviewed_at DESC,
                   inverse_application.submitted_at DESC
          LIMIT 1
        )
      ) AS application_number
     FROM identity_codes c ${where}
     ORDER BY c.created_at DESC LIMIT 10 OFFSET ?`
  )
    .bind(...bindings, (page - 1) * 10)
    .all<IdentityCodeRow & { application_number: string | null }>();
  return {
    items: await Promise.all(
      rows.results.map(async (row) => ({
        ...row,
        code: input.includeCode === false
          ? "••••••••"
          : await decryptSecret(env, "identity-code-value", row.code_encrypted)
      }))
    ),
    page,
    pageSize: 10,
    total: total?.total ?? 0
  };
}

export async function listActiveIdentityCodeOptions(
  env: Env
): Promise<Array<{ id: string; code: string; playerName: string }>> {
  const rows = await env.DB.prepare(
    `SELECT id, code_encrypted, player_name
     FROM identity_codes
     WHERE status = 'active'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY player_name ASC`
  ).bind(now()).all<{
    id: string;
    code_encrypted: string;
    player_name: string | null;
  }>();
  return Promise.all(rows.results.map(async (row) => ({
    id: row.id,
    code: await decryptSecret(env, "identity-code-value", row.code_encrypted),
    playerName: row.player_name?.trim() || ""
  })));
}

export async function listVoteBallotDetails(
  env: Env,
  pollDate: string
): Promise<
  Array<{
    voterId: string;
    identityCode: string;
    playerName: string;
    selections: string[];
    votedAt: string;
  }>
> {
  const rows = await env.DB.prepare(
    `SELECT b.voter_id, b.voter_name, b.selections_json, b.updated_at,
            c.code_encrypted
     FROM tech_ballots b
     LEFT JOIN identity_codes c ON c.id = b.voter_id
     WHERE b.poll_date = ?
     ORDER BY b.updated_at DESC`
  )
    .bind(pollDate)
    .all<{
      voter_id: string;
      voter_name: string | null;
      selections_json: string;
      updated_at: string;
      code_encrypted: string | null;
    }>();
 const validRows = rows.results.filter((row) => {
    try {
      const selections = JSON.parse(row.selections_json);
      return Array.isArray(selections) && selections.length > 0;
    } catch {
      return false;
    }
 });
  return Promise.all(
    validRows.map(async (row) => {
      let identityCode = "—";
      if (row.code_encrypted) {
        try {
          identityCode = await decryptSecret(
            env,
            "identity-code-value",
            row.code_encrypted
          );
        } catch {
          identityCode = "—";
        }
      }
      let selections: string[] = [];
      try {
        const parsed = JSON.parse(row.selections_json);
        if (Array.isArray(parsed)) selections = parsed.map(String);
      } catch {
        selections = [];
      }
      return {
        voterId: row.voter_id,
        identityCode,
        playerName: row.voter_name?.trim() || "—",
        selections,
        votedAt: row.updated_at
      };
    })
  );
}

export async function createManualIdentityCode(
  env: Env,
  input: {
    playerName: unknown;
    email: unknown;
    locale: unknown;
    permanent: unknown;
    expiresAt: unknown;
    createdBy: string;
  }
): Promise<{ id: string; code: string; initialPassword: string; emailSent: boolean }> {
  const playerName = cleanPlayerName(input.playerName, false) || null;
  const email = cleanEmail(input.email, false) || null;
  await assertNoOtherActiveIdentityCode(env, { email, playerName });
  const generated = await generateCode(env);
  const initialPassword = generateInitialPassword();
  const id = uuid();
  const timestamp = now();
  const locale = normalizeLocale(input.locale);
  const expiresAt = parseExpiry(input);
  const applicationId = playerName && email ? uuid() : null;
  const applicationNumber =
    applicationId ? await generateApplicationNumber(env) : null;
  const statements: D1PreparedStatement[] = [];
  if (applicationId && applicationNumber && playerName && email) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO identity_code_applications(
          id, application_number, request_type, email, player_name, locale,
          status, identity_code_id, submitted_at, reviewed_at, reviewed_by
        ) VALUES(?, ?, 'new', ?, ?, ?, 'approved', ?, ?, ?, ?)`
      ).bind(
        applicationId,
        applicationNumber,
        email,
        playerName,
        locale,
        id,
        timestamp,
        timestamp,
        input.createdBy
      )
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO identity_codes(
        id, code_hash, code_encrypted, player_name, email, locale, application_id,
          status, expires_at, created_by, created_at, updated_at,
          password_hash, password_set_at, password_updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      generated.hash,
      await encryptSecret(env, "identity-code-value", generated.code),
      playerName,
      email,
      locale,
      applicationId,
      expiresAt,
      input.createdBy,
      timestamp,
      timestamp,
      await hashPassword(initialPassword),
      timestamp,
      timestamp
    )
  );
  await env.DB.batch(statements);
  let emailSent = false;
  if (email && playerName) {
    const application = await env.DB.prepare(
      "SELECT * FROM identity_code_applications WHERE id = ?"
    ).bind(applicationId).first<IdentityApplicationRow>();
    if (application) {
      try {
        const created = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
          .bind(id).first<IdentityCodeRow>();
        await sendApplicationMail(env, application, {
          approved: true,
          code: created,
          expiresAt,
          initialPassword
        });
        await recordMailResult(env, application.id, id, null);
        emailSent = true;
      } catch (error) {
        await recordMailResult(
          env,
          applicationId,
          id,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }
  return { id, code: generated.code, initialPassword, emailSent };
}

export async function updateIdentityCode(
  env: Env,
  input: {
    id: string;
    status: unknown;
    permanent: unknown;
    expiresAt: unknown;
  }
): Promise<IdentityReviewMailResult> {
  const status = input.status === "disabled" ? "disabled" : "active";
  const code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
    .bind(input.id)
    .first<IdentityCodeRow>();
  if (!code) throw new Error("识别码不存在");
  if (status === "active") {
    await assertNoOtherActiveIdentityCode(env, {
      email: code.email,
      playerName: code.player_name,
      excludeId: code.id
    });
  }
  const expiresAt =
    input.permanent === true
      ? null
      : (() => {
          const value = typeof input.expiresAt === "string" ? input.expiresAt.trim() : "";
          const date = new Date(value);
          if (!value || Number.isNaN(date.getTime())) throw new Error("有效期格式无效");
          return date.toISOString();
        })();
  const timestamp = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE identity_codes SET status = ?, expires_at = ?, disabled_at = ?,
       eligibility_override_votes = CASE WHEN ? = 'disabled' THEN NULL ELSE eligibility_override_votes END,
       eligibility_override_expires_at = CASE WHEN ? = 'disabled' THEN NULL ELSE eligibility_override_expires_at END,
       updated_at = ? WHERE id = ?`
    ).bind(
      status,
      expiresAt,
      status === "disabled" ? timestamp : null,
      status,
      status,
      timestamp,
      input.id
    )
  ];
  if (status === "disabled") {
    statements.push(
      ...(await currentVoteInvalidations(env, input.id, new Date(timestamp)))
    );
  }
  await env.DB.batch(statements);
  if (status !== "disabled" || code.status !== "active") {
    return { emailSent: false, emailError: null };
  }
  let result: IdentityReviewMailResult;
  try {
    if (!code.email) throw new Error("识别码没有可用邮箱");
    await sendMail(env, {
      to: code.email,
      ...identityCancellationCompletedMail({
        locale: normalizeLocale(code.locale),
        playerName: code.player_name
      })
    });
    result = { emailSent: true, emailError: null };
  } catch (error) {
    result = {
      emailSent: false,
      emailError: error instanceof Error ? error.message : String(error)
    };
  }
  return result;
}

export async function updateIdentityCodeInformation(
  env: Env,
  input: {
    id: string;
    playerName: unknown;
    email: unknown;
    locale: unknown;
    permanent: unknown;
    expiresAt: unknown;
  }
): Promise<void> {
  const code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
    .bind(input.id)
    .first<IdentityCodeRow>();
  if (!code) throw new Error("识别码不存在");
  const playerName = cleanPlayerName(input.playerName, false) || null;
  const email = cleanEmail(input.email, false) || null;
  const locale = normalizeLocale(input.locale);
  const expiresAt = parseExpiry(input);
  if (code.status === "active") {
    await assertNoOtherActiveIdentityCode(env, {
      email,
      playerName,
      excludeId: code.id
    });
  }
  const application = await applicationForCode(env, code);
  const timestamp = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE identity_codes SET player_name = ?, email = ?, locale = ?,
       expires_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(playerName, email, locale, expiresAt, timestamp, code.id)
  ];
  if (application) {
    if (!playerName || !email) {
      throw new Error("有关联申请的识别码必须保留玩家名称和邮箱");
    }
    statements.push(
      env.DB.prepare(
        `UPDATE identity_code_applications SET player_name = ?, email = ?, locale = ?
         WHERE id = ?`
      ).bind(playerName, email, locale, application.id)
    );
  }
  await env.DB.batch(statements);
  if (!application && playerName && email) {
    await ensureApplicationForCode(env, {
      ...code,
      player_name: playerName,
      email,
      locale,
      expires_at: expiresAt,
      updated_at: timestamp
    });
  }
}

export async function reissueIdentityCode(
  env: Env,
  input: {
    id: string;
    permanent: unknown;
    expiresAt: unknown;
    reissuedBy: string;
  }
): Promise<{ emailSent: boolean; emailError: string | null }> {
  const code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
    .bind(input.id)
    .first<IdentityCodeRow>();
  if (!code) throw new Error("识别码不存在");
  if (!code.email || !code.player_name) {
    throw new Error("更换识别码前必须先补全玩家名称和邮箱");
  }
  await assertNoOtherActiveIdentityCode(env, {
    email: code.email,
    playerName: code.player_name,
    excludeId: code.id
  });
  const generated = await generateCode(env);
  const initialPassword = generateInitialPassword();
  const expiresAt = parseExpiry(input);
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE identity_codes SET
         code_hash = ?, code_encrypted = ?, status = 'active', expires_at = ?,
         disabled_at = NULL, renewal_grace_vote_used_at = NULL, updated_at = ?,
         created_by = ?, password_hash = ?, password_set_at = ?, password_updated_at = ?
       WHERE id = ?`
    ).bind(
      generated.hash,
      await encryptSecret(env, "identity-code-value", generated.code),
      expiresAt,
      timestamp,
      input.reissuedBy,
      await hashPassword(initialPassword),
      timestamp,
      timestamp,
      code.id
    ),
    ...(await currentVoteInvalidations(env, code.id, new Date(timestamp)))
  ]);
  const updated = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
    .bind(code.id)
    .first<IdentityCodeRow>();
  if (!updated) throw new Error("更换身份识别码失败");
  const application = code.application_id
    ? await env.DB.prepare("SELECT * FROM identity_code_applications WHERE id = ?")
        .bind(code.application_id)
        .first<IdentityApplicationRow>()
    : null;
  const mailApplication: IdentityApplicationRow = {
    id: application?.id ?? "",
    application_number:
      application?.application_number ?? `MANUAL-${code.id.slice(0, 8)}`,
    request_type: "reissue",
    email: code.email,
    player_name: code.player_name,
    locale: code.locale,
    status: "approved",
    identity_code_id: code.id,
    submitted_at: application?.submitted_at ?? code.created_at,
    reviewed_at: timestamp,
    reviewed_by: input.reissuedBy,
    rejection_reason: null,
    email_sent_at: null,
    last_email_error: null
  };
  try {
    await sendApplicationMail(env, mailApplication, {
      approved: true,
      code: updated,
      expiresAt,
      initialPassword
    });
    await recordMailResult(env, application?.id ?? null, code.id, null);
    return { emailSent: true, emailError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordMailResult(env, application?.id ?? null, code.id, message);
    return { emailSent: false, emailError: message };
  }
}

export async function resetIdentityCodePassword(
  env: Env,
  id: string
): Promise<{ emailSent: boolean; emailError: string | null }> {
  const code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
    .bind(id)
    .first<IdentityCodeRow>();
  if (!code) throw new Error("识别码不存在");
  if (!code.email) throw new Error("识别码没有绑定邮箱，无法发送密码");
  const initialPassword = generateInitialPassword();
  const timestamp = now();
  await env.DB.prepare(
    `UPDATE identity_codes SET password_hash = ?,
       password_set_at = COALESCE(password_set_at, ?),
       password_updated_at = ?, updated_at = ?, last_email_error = NULL
     WHERE id = ?`
  )
    .bind(
      await hashPassword(initialPassword),
      timestamp,
      timestamp,
      timestamp,
      code.id
    )
    .run();
  const plaintext = await decryptSecret(env, "identity-code-value", code.code_encrypted);
  const message = identityPasswordResetMail({
    locale: code.locale,
    playerName: code.player_name,
    code: plaintext,
    initialPassword
  });
  try {
    await sendMail(env, { to: code.email, ...message });
    await recordMailResult(env, null, code.id, null);
    return { emailSent: true, emailError: null };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await recordMailResult(env, null, code.id, messageText);
    throw new Error(`密码已重置，但邮件发送失败：${messageText}`);
  }
}

export async function resendIdentityCode(env: Env, id: string): Promise<void> {
  const code = await env.DB.prepare("SELECT * FROM identity_codes WHERE id = ?")
    .bind(id)
    .first<IdentityCodeRow>();
  if (!code) throw new Error("识别码不存在");
  if (!code.email || !code.player_name) throw new Error("识别码没有完整邮件信息");
  const application = code.application_id
    ? await env.DB.prepare("SELECT * FROM identity_code_applications WHERE id = ?")
        .bind(code.application_id)
        .first<IdentityApplicationRow>()
    : null;
  const fallback: IdentityApplicationRow = {
    id: "",
    application_number: application?.application_number ?? `MANUAL-${code.id.slice(0, 8)}`,
    request_type: application?.request_type ?? "new",
    email: code.email,
    player_name: code.player_name,
    locale: code.locale,
    status: "approved",
    identity_code_id: code.id,
    submitted_at: code.created_at,
    reviewed_at: code.updated_at,
    reviewed_by: code.created_by,
    rejection_reason: null,
    email_sent_at: null,
    last_email_error: null
  };
  try {
    await sendApplicationMail(env, application ?? fallback, {
      approved: true,
      code,
      expiresAt: code.expires_at
    });
    await recordMailResult(env, application?.id ?? null, code.id, null);
  } catch (error) {
    await recordMailResult(
      env,
      application?.id ?? null,
      code.id,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}
