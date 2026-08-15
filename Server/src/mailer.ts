import { WorkerMailer, type AuthType } from "worker-mailer";
import { decryptSecret, encryptSecret } from "./crypto";
import type { SupportedLocale } from "./locale";
export { normalizeLocale, type SupportedLocale } from "./locale";

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  startTls: boolean;
  authType: AuthType;
  username: string;
  passwordEncrypted: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
}

export interface PublicSmtpConfig extends Omit<SmtpConfig, "passwordEncrypted"> {
  passwordConfigured: boolean;
}

const DEFAULT_SMTP: SmtpConfig = {
  enabled: false,
  host: "",
  port: 587,
  secure: false,
  startTls: true,
  authType: "login",
  username: "",
  passwordEncrypted: "",
  fromEmail: "",
  fromName: "明日之后“愿”营地助手",
  replyTo: ""
};

function parseConfig(value: string): SmtpConfig {
  const raw = JSON.parse(value) as Partial<SmtpConfig>;
  return { ...DEFAULT_SMTP, ...raw };
}

export async function getSmtpConfig(env: Env): Promise<SmtpConfig> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind("smtp_config")
    .first<{ value: string }>();
  return row ? parseConfig(row.value) : { ...DEFAULT_SMTP };
}

export function publicSmtpConfig(config: SmtpConfig): PublicSmtpConfig {
  const { passwordEncrypted, ...safe } = config;
  return { ...safe, passwordConfigured: Boolean(passwordEncrypted) };
}

export function demoSmtpConfig(): PublicSmtpConfig {
  return {
    enabled: false,
    host: "smtp.test.demo.com",
    port: 587,
    secure: false,
    startTls: true,
    authType: "login",
    username: "demo",
    fromEmail: "test@demo.com",
    fromName: "Demo SMTP",
    replyTo: "test@demo.com",
    passwordConfigured: false
  };
}

function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function email(value: unknown): string {
  const result = text(value, 254);
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) {
    throw new Error("邮箱地址格式无效");
  }
  return result;
}

export async function updateSmtpConfig(
  env: Env,
  raw: Record<string, unknown>
): Promise<PublicSmtpConfig> {
  const current = await getSmtpConfig(env);
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 25) {
    throw new Error("SMTP 端口必须为 1–65535，且 Workers 不支持端口 25");
  }
  const authType =
    raw.authType === "plain" || raw.authType === "cram-md5" ? raw.authType : "login";
  const password = typeof raw.password === "string" ? raw.password : "";
  const next: SmtpConfig = {
    enabled: raw.enabled === true,
    host: text(raw.host, 253),
    port,
    secure: raw.secure === true,
    startTls: raw.startTls === true,
    authType,
    username: text(raw.username, 254),
    passwordEncrypted:
      raw.clearPassword === true
        ? ""
        : password
          ? await encryptSecret(env, "smtp-password", password)
          : current.passwordEncrypted,
    fromEmail: email(raw.fromEmail),
    fromName: text(raw.fromName, 120),
    replyTo: email(raw.replyTo)
  };
  if (next.enabled && (!next.host || !next.fromEmail)) {
    throw new Error("启用 SMTP 前必须填写服务器与发件邮箱");
  }
  await env.DB.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES('smtp_config', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(JSON.stringify(next), new Date().toISOString())
    .run();
  return publicSmtpConfig(next);
}

export async function sendMail(
  env: Env,
  input: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }
): Promise<void> {
  const config = await getSmtpConfig(env);
  if (!config.enabled) throw new Error("SMTP 发信尚未启用");
  const password = config.passwordEncrypted
    ? await decryptSecret(env, "smtp-password", config.passwordEncrypted)
    : "";
  await WorkerMailer.send(
    {
      host: config.host,
      port: config.port,
      secure: config.secure,
      startTls: config.startTls,
      authType: config.authType,
      ...(config.username
        ? { credentials: { username: config.username, password } }
        : {}),
      socketTimeoutMs: 20_000,
      responseTimeoutMs: 20_000
    },
    {
      from: { email: config.fromEmail, name: config.fromName || undefined },
      to: input.to,
      ...(config.replyTo ? { reply: config.replyTo } : {}),
      subject: input.subject,
      text: input.text,
      html: input.html
    }
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character
  );
}

const COPY = {
  "zh-cn": {
    approved: "身份识别码申请已通过",
    renewed: "身份识别码延期申请已通过",
    reissued: "身份识别码重新发行申请已通过",
    rejected: "身份识别码申请未通过",
    application: "申请编号",
    player: "玩家名称",
    code: "身份识别码",
    expiry: "有效期",
    permanent: "永久有效",
    reason: "原因",
    recovered: "身份识别码找回",
    renew: "该识别码已经过期，可在网页或小程序中申请延期。",
    keep: "请妥善保管识别码，并仅由本人用于科技投票。"
  },
  "zh-tw": {
    approved: "身分識別碼申請已通過",
    renewed: "身分識別碼延期申請已通過",
    reissued: "身分識別碼重新發行申請已通過",
    rejected: "身分識別碼申請未通過",
    application: "申請編號",
    player: "玩家名稱",
    code: "身分識別碼",
    expiry: "有效期",
    permanent: "永久有效",
    reason: "原因",
    recovered: "身分識別碼找回",
    renew: "該識別碼已經過期，可在網頁或小程式中申請延期。",
    keep: "請妥善保管識別碼，並僅由本人用於科技投票。"
  },
  en: {
    approved: "Identity code application approved",
    renewed: "Identity code renewal approved",
    reissued: "Identity code reissue approved",
    rejected: "Identity code application rejected",
    application: "Application number",
    player: "Player name",
    code: "Identity code",
    expiry: "Valid until",
    permanent: "No expiration",
    reason: "Reason",
    recovered: "Identity code recovery",
    renew: "This code has expired. You may request an extension on the website or mini program.",
    keep: "Keep this code secure and use it only for your own technology votes."
  },
  fr: {
    approved: "Demande de code d’identité approuvée",
    renewed: "Prolongation du code d’identité approuvée",
    reissued: "Réémission du code d’identité approuvée",
    rejected: "Demande de code d’identité refusée",
    application: "Numéro de demande",
    player: "Nom du joueur",
    code: "Code d’identité",
    expiry: "Valable jusqu’au",
    permanent: "Validité permanente",
    reason: "Motif",
    recovered: "Récupération du code d’identité",
    renew: "Ce code a expiré. Vous pouvez demander une prolongation sur le site ou le mini-programme.",
    keep: "Conservez ce code en sécurité et utilisez-le uniquement pour vos votes."
  },
  ja: {
    approved: "本人確認コード申請が承認されました",
    renewed: "本人確認コードの延長が承認されました",
    reissued: "本人確認コードの再発行申請が承認されました",
    rejected: "本人確認コード申請が却下されました",
    application: "申請番号",
    player: "プレイヤー名",
    code: "本人確認コード",
    expiry: "有効期限",
    permanent: "無期限",
    reason: "理由",
    recovered: "本人確認コードの再送",
    renew: "このコードは期限切れです。ウェブサイトまたはミニプログラムから延長を申請できます。",
    keep: "コードを安全に保管し、ご本人の技術投票にのみ使用してください。"
  }
} as const;

export function identityMail(input: {
  locale: SupportedLocale;
  approved: boolean;
  requestType: "new" | "renewal" | "reissue";
  applicationNumber: string;
  playerName: string;
  code?: string;
  expiresAt?: string | null;
  reason?: string | null;
}): { subject: string; text: string; html: string } {
  const copy = COPY[input.locale];
  const subject = input.approved
    ? input.requestType === "renewal"
      ? copy.renewed
      : input.requestType === "reissue"
        ? copy.reissued
        : copy.approved
    : copy.rejected;
  const rows: Array<[string, string]> = [
    [copy.application, input.applicationNumber],
    [copy.player, input.playerName]
  ];
  if (input.approved && input.code) {
    rows.push([copy.code, input.code]);
    rows.push([copy.expiry, input.expiresAt ?? copy.permanent]);
  }
  if (!input.approved && input.reason) rows.push([copy.reason, input.reason]);
  const plain = [subject, "", ...rows.map(([key, value]) => `${key}: ${value}`)];
  if (input.approved) plain.push("", copy.keep);
  const htmlRows = rows
    .map(
      ([key, value]) =>
        `<tr><th style="text-align:left;padding:8px">${escapeHtml(key)}</th><td style="padding:8px">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  return {
    subject,
    text: plain.join("\n"),
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.6"><h1>${escapeHtml(subject)}</h1><table>${htmlRows}</table>${input.approved ? `<p>${escapeHtml(copy.keep)}</p>` : ""}</div>`
  };
}

export function identityRecoveryMail(input: {
  locale: SupportedLocale;
  applicationNumber: string | null;
  playerName: string | null;
  code: string;
  expiresAt: string | null;
  expired: boolean;
}): { subject: string; text: string; html: string } {
  const copy = COPY[input.locale];
  const rows: Array<[string, string]> = [];
  if (input.applicationNumber) rows.push([copy.application, input.applicationNumber]);
  if (input.playerName) rows.push([copy.player, input.playerName]);
  rows.push([copy.code, input.code]);
  rows.push([copy.expiry, input.expiresAt ?? copy.permanent]);
  const notes = [copy.keep, ...(input.expired ? [copy.renew] : [])];
  return {
    subject: copy.recovered,
    text: [
      copy.recovered,
      "",
      ...rows.map(([key, value]) => `${key}: ${value}`),
      "",
      ...notes
    ].join("\n"),
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.6"><h1>${escapeHtml(copy.recovered)}</h1><table>${rows
      .map(
        ([key, value]) =>
          `<tr><th style="text-align:left;padding:8px">${escapeHtml(key)}</th><td style="padding:8px">${escapeHtml(value)}</td></tr>`
      )
      .join("")}</table>${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}</div>`
  };
}
