import { decryptSecret, encryptSecret, keyedHash } from "./crypto";
import {
  identityMail,
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
    throw new Error("相同邮箱或玩家名称已有待审批申请，不能重复提交或申请其他类型");
  }
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
    )
      .bind(value)
      .first();
    if (!exists) return value;
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
  if (code.status === "disabled") throw new Error("身份识别码已被禁用");
  if (!isIdentityRenewalWindowOpen(code.expires_at)) {
    throw new Error("仅可在识别码有效期届满前7天内申请延期");
  }
  if (application.status === "pending") {
    throw new Error("相同邮箱或玩家名称已有待审批申请，不能重复提交或申请其他类型");
  }
  return {
    applicationNumber: application.application_number,
    email: application.email,
    playerName: application.player_name,
    status: application.status,
    canSubmit: application.status !== "rejected"
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
  if (code.status === "disabled") throw new Error("身份识别码已被禁用");
  if (!isIdentityRenewalWindowOpen(code.expires_at)) {
    throw new Error("仅可在识别码有效期届满前7天内申请延期");
  }
  if (application.request_type === "renewal" && application.status === "rejected") {
    throw new Error("该延期申请已被拒绝，不能再次申请");
  }
  if (
    cleanEmail(input.email) !== application.email.toLowerCase() ||
    cleanPlayerName(input.playerName) !== application.player_name
  ) {
    throw new Error("核对信息与原申请不一致");
  }
  await assertNoPendingIdentityApplication(env, {
    email: application.email,
    playerName: application.player_name,
    excludeId: application.id
  });
  if (application.request_type === "renewal" && application.status === "pending") {
    throw new Error("相同邮箱或玩家名称已有待审批申请，不能重复提交或申请其他类型");
  }
  const submittedAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE identity_code_applications SET
        request_type = 'renewal', status = 'pending', locale = ?, submitted_at = ?,
        reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL,
        email_sent_at = NULL, last_email_error = NULL
       WHERE id = ?`
    ).bind(normalizeLocale(input.locale), submittedAt, application.id),
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
    playerName: unknown;
  }
): Promise<IdentityCodeRow> {
  const identityCode =
    typeof input.identityCode === "string" ? input.identityCode.trim() : "";
  const applicationNumber =
    typeof input.applicationNumber === "string"
      ? input.applicationNumber.trim().slice(0, 40)
      : "";
  const email = cleanEmail(input.email, false);
  const playerName = cleanPlayerName(input.playerName, false);
  if (!applicationNumber && !identityCode && !email && !playerName) {
    throw new Error(
      "请至少填写申请编号、玩家名称、申请时预留邮箱或旧识别码中的一项"
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
    if (
      (email && code.email?.toLowerCase() !== email) ||
      (playerName &&
        identityPlayerNameKey(code.player_name) !==
          identityPlayerNameKey(playerName))
    ) {
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
  const playerNameKey = identityPlayerNameKey(playerName);
  const matches = rows.results.filter(
    (row) =>
      !playerNameKey ||
      identityPlayerNameKey(row.player_name) === playerNameKey
  );
  if (!matches.length) throw new Error("未找到匹配的身份识别码记录");
  if (matches.length > 1) {
    throw new Error("匹配到多个识别码，请再填写另一项信息缩小范围");
  }
  const matchedCode = matches[0]!;
  if (matchedCode.status !== "active") {
    throw new Error("只有状态为有效的身份识别码可以申请更换");
  }
  if (isIdentityCodeExpired(matchedCode.expires_at)) {
    throw new Error("已过期的身份识别码不能申请更换，请申请延长有效期");
  }
  return matchedCode;
}

export async function reissuePreview(
  env: Env,
  input: {
    identityCode: unknown;
    applicationNumber: unknown;
    email: unknown;
    playerName: unknown;
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
    throw new Error("相同邮箱或玩家名称已有待审批申请，不能重复提交或申请其他类型");
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
    email: unknown;
    playerName: unknown;
    locale: unknown;
  }
): Promise<{ applicationNumber: string; status: "pending" }> {
  const code = await codeForReissue(env, input);
  const application = await ensureApplicationForCode(env, code);
  if (!application) throw new Error("该识别码没有完整申请记录，请联系市长处理");
  if (
    application.request_type === "reissue" &&
    application.status === "pending"
  ) {
    throw new Error("相同邮箱或玩家名称已有待审批申请，不能重复提交或申请其他类型");
  }
  if (
    application.request_type === "reissue" &&
    application.status === "rejected"
  ) {
    throw new Error("该申请已被拒绝，请重新申请身份识别码");
  }
  await assertNoPendingIdentityApplication(env, {
    email: application.email,
    playerName: application.player_name,
    excludeId: application.id
  });
  const submittedAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE identity_code_applications SET
        request_type = 'reissue', status = 'pending', locale = ?, submitted_at = ?,
        identity_code_id = ?, reviewed_at = NULL, reviewed_by = NULL,
        rejection_reason = NULL, email_sent_at = NULL, last_email_error = NULL
       WHERE id = ?`
    ).bind(
      normalizeLocale(input.locale),
      submittedAt,
      code.id,
      application.id
    ),
    env.DB.prepare(
      `UPDATE identity_codes SET status = 'disabled', disabled_at = ?,
       updated_at = ? WHERE id = ?`
    ).bind(submittedAt, submittedAt, code.id)
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

export async function listIdentityApplications(
  env: Env,
  input: { page: number; search: string; status: string }
): Promise<{ items: IdentityApplicationRow[]; page: number; pageSize: 10; total: number }> {
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
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM identity_code_applications ${where}`
  )
    .bind(...bindings)
    .first<{ total: number }>();
  const result = await env.DB.prepare(
    `SELECT * FROM identity_code_applications ${where}
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, submitted_at DESC
     LIMIT 10 OFFSET ?`
  )
    .bind(...bindings, (page - 1) * 10)
    .all<IdentityApplicationRow>();
  return { items: result.results, page, pageSize: 10, total: totalRow?.total ?? 0 };
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
  if (application.request_type === "renewal") {
    if (!application.identity_code_id) throw new Error("延期申请未关联识别码");
    await assertNoOtherActiveIdentityCode(env, {
      email: application.email,
      playerName: application.player_name,
      excludeId: application.identity_code_id
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE identity_codes SET expires_at = ?, status = 'active', disabled_at = NULL,
         renewal_grace_vote_used_at = NULL, updated_at = ? WHERE id = ?`
      ).bind(expiresAt, reviewedAt, application.identity_code_id),
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
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE identity_codes SET
           code_hash = ?, code_encrypted = ?, player_name = ?, email = ?,
           locale = ?, status = 'active', expires_at = ?, disabled_at = NULL,
           renewal_grace_vote_used_at = NULL, updated_at = ?
         WHERE id = ?`
      ).bind(
        generated.hash,
        await encryptSecret(env, "identity-code-value", generated.code),
        application.player_name,
        application.email,
        application.locale,
        expiresAt,
        reviewedAt,
        application.identity_code_id
      ),
      env.DB.prepare(
        `UPDATE identity_code_applications SET status = 'approved',
         reviewed_at = ?, reviewed_by = ?, rejection_reason = NULL WHERE id = ?`
      ).bind(reviewedAt, input.reviewedBy, application.id)
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
    const codeId = uuid();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO identity_codes(
          id, code_hash, code_encrypted, player_name, email, locale, application_id,
          status, expires_at, created_by, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
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
      expiresAt
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
      input.reason.slice(0, 500) || null,
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
         updated_at = ? WHERE id = ?`
      ).bind(reviewedAt, reviewedAt, application.identity_code_id)
    );
  }
  await env.DB.batch(statements);
  try {
    await sendApplicationMail(env, application, {
      approved: false,
      reason: input.reason
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
  input: { page: number; search: string; status: string }
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
        code: await decryptSecret(env, "identity-code-value", row.code_encrypted)
      }))
    ),
    page,
    pageSize: 10,
    total: total?.total ?? 0
  };
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
  return Promise.all(
    rows.results.map(async (row) => {
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
): Promise<{ id: string; code: string }> {
  const playerName = cleanPlayerName(input.playerName, false) || null;
  const email = cleanEmail(input.email, false) || null;
  await assertNoOtherActiveIdentityCode(env, { email, playerName });
  const generated = await generateCode(env);
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
        status, expires_at, created_by, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
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
      timestamp
    )
  );
  await env.DB.batch(statements);
  return { id, code: generated.code };
}

export async function updateIdentityCode(
  env: Env,
  input: {
    id: string;
    status: unknown;
    permanent: unknown;
    expiresAt: unknown;
  }
): Promise<void> {
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
  await env.DB.prepare(
    `UPDATE identity_codes SET status = ?, expires_at = ?, disabled_at = ?,
     updated_at = ? WHERE id = ?`
  )
    .bind(status, expiresAt, status === "disabled" ? now() : null, now(), input.id)
    .run();
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
  const expiresAt = parseExpiry(input);
  const timestamp = now();
  await env.DB.prepare(
    `UPDATE identity_codes SET
       code_hash = ?, code_encrypted = ?, status = 'active', expires_at = ?,
       disabled_at = NULL, renewal_grace_vote_used_at = NULL, updated_at = ?,
       created_by = ?
     WHERE id = ?`
  )
    .bind(
      generated.hash,
      await encryptSecret(env, "identity-code-value", generated.code),
      expiresAt,
      timestamp,
      input.reissuedBy,
      code.id
    )
    .run();
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
      expiresAt
    });
    await recordMailResult(env, application?.id ?? null, code.id, null);
    return { emailSent: true, emailError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordMailResult(env, application?.id ?? null, code.id, message);
    return { emailSent: false, emailError: message };
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
