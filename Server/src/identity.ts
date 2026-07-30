import { decryptSecret, encryptSecret, keyedHash } from "./crypto";
import {
  identityMail,
  identityRecoveryMail,
  normalizeLocale,
  sendMail,
  type SupportedLocale
} from "./mailer";
import {
  isIdentityRenewalWindowOpen,
  isSequentialIdentityCode
} from "./identity-code-utils";
import { getConfigBundle } from "./db";
export { isSequentialIdentityCode } from "./identity-code-utils";

export interface IdentityApplicationRow {
  id: string;
  application_number: string;
  request_type: "new" | "renewal";
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
  const existing = await env.DB.prepare(
    `SELECT application_number, status FROM identity_code_applications
     WHERE lower(email) = ? AND player_name = ? AND request_type = 'new'
     ORDER BY submitted_at DESC LIMIT 1`
  )
    .bind(email, playerName)
    .first<{ application_number: string; status: string }>();
  if (existing?.status === "pending") {
    return { applicationNumber: existing.application_number, status: existing.status };
  }
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
  if (!code.application_id) return null;
  return env.DB.prepare("SELECT * FROM identity_code_applications WHERE id = ?")
    .bind(code.application_id)
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
  const expired = Boolean(code.expires_at && Date.parse(code.expires_at) <= Date.now());
  if (!expired) return { ok: true, code, grace: false };
  const application = await applicationForCode(env, code);
  const pendingRenewal =
    application?.request_type === "renewal" && application.status === "pending";
  if (pendingRenewal && !code.renewal_grace_vote_used_at) {
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

export async function renewalPreview(
  env: Env,
  plaintext: unknown
): Promise<{
  applicationNumber: string;
  email: string;
  playerName: string;
  status: string;
  canSubmit: boolean;
}> {
  const code = await codeByPlaintext(env, plaintext);
  if (!code) throw new Error("身份识别码无效");
  if (code.status === "disabled") throw new Error("身份识别码已被禁用");
  if (!isIdentityRenewalWindowOpen(code.expires_at)) {
    throw new Error("仅可在识别码有效期届满前7天内申请延期");
  }
  const application = await applicationForCode(env, code);
  if (!application) throw new Error("该识别码没有可延期的申请记录");
  return {
    applicationNumber: application.application_number,
    email: application.email,
    playerName: application.player_name,
    status: application.status,
    canSubmit: application.status !== "rejected" && application.status !== "pending"
  };
}

export async function submitRenewal(
  env: Env,
  input: {
    identityCode: unknown;
    email: unknown;
    playerName: unknown;
    locale: unknown;
  }
): Promise<{ applicationNumber: string; status: string; graceVoteAvailable: boolean }> {
  const code = await codeByPlaintext(env, input.identityCode);
  if (!code) throw new Error("身份识别码无效");
  if (code.status === "disabled") throw new Error("身份识别码已被禁用");
  if (!isIdentityRenewalWindowOpen(code.expires_at)) {
    throw new Error("仅可在识别码有效期届满前7天内申请延期");
  }
  const application = await applicationForCode(env, code);
  if (!application) throw new Error("该识别码没有可延期的申请记录");
  if (application.request_type === "renewal" && application.status === "rejected") {
    throw new Error("该延期申请已被拒绝，不能再次申请");
  }
  if (
    cleanEmail(input.email) !== application.email.toLowerCase() ||
    cleanPlayerName(input.playerName) !== application.player_name
  ) {
    throw new Error("核对信息与原申请不一致");
  }
  if (application.request_type === "renewal" && application.status === "pending") {
    return {
      applicationNumber: application.application_number,
      status: "pending",
      graceVoteAvailable: !code.renewal_grace_vote_used_at
    };
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
  const clauses = ["c.status = 'active'"];
  const bindings: unknown[] = [];
  if (email) {
    clauses.push("lower(c.email) = ?");
    bindings.push(email);
  }
  if (playerName) {
    clauses.push("c.player_name = ?");
    bindings.push(playerName);
  }
  if (applicationNumber) {
    clauses.push("a.application_number = ?");
    bindings.push(applicationNumber);
  }
  const result = await env.DB.prepare(
    `SELECT c.*, a.application_number
     FROM identity_codes c
     LEFT JOIN identity_code_applications a ON a.id = c.application_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY c.created_at DESC LIMIT 2`
  )
    .bind(...bindings)
    .all<IdentityCodeRow & { application_number: string | null }>();
  if (!result.results.length) {
    throw new Error("没有找到符合条件的有效或过期识别码");
  }
  if (result.results.length > 1) {
    throw new Error("匹配到多个识别码，请补充更多申请信息后重试");
  }
  const code = result.results[0];
  if (!code?.email) {
    throw new Error("申请预留信息不足，请联系市长处理");
  }
  const expired = Boolean(code.expires_at && Date.parse(code.expires_at) <= Date.now());
  const message = identityRecoveryMail({
    locale: code.locale,
    applicationNumber: code.application_number,
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
    renewal: application.request_type === "renewal",
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
  } else {
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
  await env.DB.prepare(
    `UPDATE identity_code_applications SET status = 'rejected', reviewed_at = ?,
     reviewed_by = ?, rejection_reason = ? WHERE id = ?`
  )
    .bind(now(), input.reviewedBy, input.reason.slice(0, 500) || null, input.id)
    .run();
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
): Promise<{ items: Array<IdentityCodeRow & { code: string }>; page: number; pageSize: 10; total: number }> {
  const page = Math.max(1, Math.floor(input.page));
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  const search = input.search.slice(0, 80).trim();
  if (search) {
    const textSearch = `%${search.toLowerCase()}%`;
    if (/^\d{8}$/.test(search)) {
      clauses.push("(code_hash = ? OR lower(player_name) LIKE ? OR lower(email) LIKE ?)");
      bindings.push(
        await keyedHash(env, "identity-code", search),
        textSearch,
        textSearch
      );
    } else {
      clauses.push("(lower(player_name) LIKE ? OR lower(email) LIKE ?)");
      bindings.push(textSearch, textSearch);
    }
  }
  const timestamp = now();
  if (input.status === "active") {
    clauses.push("status = 'active' AND (expires_at IS NULL OR expires_at > ?)");
    bindings.push(timestamp);
  } else if (input.status === "expired") {
    clauses.push("status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?");
    bindings.push(timestamp);
  } else if (input.status === "disabled") {
    clauses.push("status = 'disabled'");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = await env.DB.prepare(`SELECT COUNT(*) AS total FROM identity_codes ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await env.DB.prepare(
    `SELECT * FROM identity_codes ${where} ORDER BY created_at DESC LIMIT 10 OFFSET ?`
  )
    .bind(...bindings, (page - 1) * 10)
    .all<IdentityCodeRow>();
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
  const generated = await generateCode(env);
  const id = uuid();
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO identity_codes(
      id, code_hash, code_encrypted, player_name, email, locale, status,
      expires_at, created_by, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
  )
    .bind(
      id,
      generated.hash,
      await encryptSecret(env, "identity-code-value", generated.code),
      cleanPlayerName(input.playerName, false) || null,
      cleanEmail(input.email, false) || null,
      normalizeLocale(input.locale),
      parseExpiry(input),
      input.createdBy,
      timestamp,
      timestamp
    )
    .run();
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
