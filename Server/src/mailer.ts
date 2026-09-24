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

const EMAIL_LOGO_URL = "https://www.yume.zone/img/logo.png";

const EMAIL_BRAND_NAMES: Record<SupportedLocale, string> = {
  "zh-cn": "明日之后“愿”营地助手",
  "zh-tw": "明日之後「願」營地助手",
  en: "LifeAfter “Wish” Camp Assistant",
  fr: "Assistant du camp « Vœu » LifeAfter",
  ja: "ライフアフター「願」野営地アシスタント"
};

function renderYumeEmail(input: {
  locale: SupportedLocale;
  title: string;
  rows: Array<[string, string]>;
  notes?: string[];
}): string {
  const brand = EMAIL_BRAND_NAMES[input.locale];
  const copyrightYear = new Date().getUTCFullYear();
  const footerCompany = input.locale === "zh-cn" ? "美国雨梦互联网有限公司" : "Yume Internet LLC";
  const footerPrefix = input.locale === "zh-cn" ? `版权所有 © ${copyrightYear} ` : `Copyright © ${copyrightYear} `;
  const footerSuffix = input.locale === "zh-cn" ? " 保留所有权利。" : ". All Rights Reserved.";
  const rowMarkup = input.rows
    .map(
      ([key, value]) =>
        `<tr><td style="padding:14px 16px;border-bottom:1px solid #334155;color:#94a3b8;font-size:13px;vertical-align:top;width:38%;">${escapeHtml(key)}</td><td style="padding:14px 16px;border-bottom:1px solid #334155;color:#f8fafc;font-size:14px;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  const notesMarkup = (input.notes ?? [])
    .map(
      (note) =>
        `<p style="margin:12px 0 0;color:#cbd5e1;font-size:13px;line-height:1.7;">${escapeHtml(note)}</p>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.locale)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body bgcolor="#0f172a" style="margin:0;padding:0;background-color:#0f172a;font-family:Arial,'Helvetica Neue',sans-serif;color:#f8fafc;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f172a" style="width:100%;background-color:#0f172a;">
      <tr>
        <td align="center" valign="top" bgcolor="#0f172a" style="vertical-align:top;background-color:#0f172a;padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background-color:#1e293b;border:1px solid #334155;border-radius:20px;overflow:hidden;">
            <tr>
              <td align="center" style="padding:32px 28px 24px;background-color:#172235;">
                <img src="${EMAIL_LOGO_URL}" alt="${escapeHtml(brand)}" width="48" height="48" style="display:block;width:48px;height:48px;border:0;border-radius:14px;object-fit:cover;">
                <p style="margin:14px 0 0;color:#cbd5e1;font-size:13px;letter-spacing:.03em;">${escapeHtml(brand)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 22px;color:#f8fafc;font-size:24px;line-height:1.3;font-weight:700;text-align:center;">${escapeHtml(input.title)}</h1>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #475569;border-radius:14px;overflow:hidden;background-color:#172235;">${rowMarkup}</table>
                ${notesMarkup}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:18px 28px 24px;border-top:1px solid #334155;">
                <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;text-align:center;">${escapeHtml(footerPrefix)}<a href="https://www.yume.zone/" style="color:#94a3b8;text-decoration:underline;">${escapeHtml(footerCompany)}</a>${escapeHtml(footerSuffix)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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
    password: "初始密码",
    passwordReset: "身份识别码密码重置",
    emailChange: "身份识别码邮箱变更验证",
    verificationCode: "验证码",
    renew: "该识别码已经过期，可在网页或小程序中申请延期。",
    usage: "此身份识别码用于日常投票，包括科技投票、投票事项和抽签事项。",
    keep: "请妥善保管识别码，并仅由本人用于日常投票。",
    profileApproved: "身份资料变更申请已通过",
    profileRejected: "身份资料变更申请未通过",
    changeType: "变更项目",
    oldValue: "原信息",
    newValue: "申请信息",
    name: "玩家名称",
    email: "邮箱",
    profileApprovedNote: "资料变更已审核通过并生效。",
    profileRejectedNote: "本次资料未发生变更。",
    cancelled: "身份识别码注销成功",
    cancelledStatus: "状态",
    cancelledStatusValue: "已注销",
    cancelledNote: "该身份识别码已立即失效，注销流程无法撤回。",
    eligibilityApproved: "破格投票资格申请已批准",
    eligibilityRejected: "破格投票资格申请未通过",
    eligibilityReason: "申请理由",
    eligibilityRejectionReason: "管理员拒绝理由",
    eligibilityStats: "提交时当前数值",
    eligibilityContribution: "本周贡献",
    eligibilityTechnology: "科技点",
    eligibilityMaterials: "物资",
    eligibilityActivity: "周活跃点",
    eligibilityVotes: "允许破格投票次数",
    eligibilityExpiry: "破格投票有效期至",
    eligibilityApprovedNote: "管理员已批准破格投票资格，请在有效次数或有效期内使用。",
    eligibilityRejectedNote: "管理员已拒绝本次破格投票资格申请。"
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
    password: "初始密碼",
    passwordReset: "身分識別碼密碼重置",
    emailChange: "身分識別碼信箱變更驗證",
    verificationCode: "驗證碼",
    renew: "該識別碼已經過期，可在網頁或小程式中申請延期。",
    usage: "此身分識別碼用於日常投票，包括科技投票、投票事項和抽籤事項。",
    keep: "請妥善保管識別碼，並僅由本人用於日常投票。",
    profileApproved: "身分資料變更申請已通過",
    profileRejected: "身分資料變更申請未通過",
    changeType: "變更項目",
    oldValue: "原資訊",
    newValue: "申請資訊",
    name: "玩家名稱",
    email: "信箱",
    profileApprovedNote: "資料變更已審核通過並生效。",
    profileRejectedNote: "本次資料未發生變更。",
    cancelled: "身分識別碼註銷成功",
    cancelledStatus: "狀態",
    cancelledStatusValue: "已註銷",
    cancelledNote: "該身分識別碼已立即失效，註銷流程無法撤回。",
    eligibilityApproved: "破格投票資格申請已批准",
    eligibilityRejected: "破格投票資格申請未通過",
    eligibilityReason: "申請理由",
    eligibilityRejectionReason: "管理員拒絕理由",
    eligibilityStats: "提交時目前數值",
    eligibilityContribution: "本週貢獻",
    eligibilityTechnology: "科技點",
    eligibilityMaterials: "物資",
    eligibilityActivity: "週活躍點",
    eligibilityVotes: "允許破格投票次數",
    eligibilityExpiry: "破格投票有效期至",
    eligibilityApprovedNote: "管理員已批准破格投票資格，請在有效次數或有效期內使用。",
    eligibilityRejectedNote: "管理員已拒絕本次破格投票資格申請。"
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
    password: "Initial password",
    passwordReset: "Identity code password reset",
    emailChange: "Identity code email change verification",
    verificationCode: "Verification code",
    renew: "This code has expired. You may request an extension on the website or mini program.",
    usage: "This identity code is used for daily voting, including technology votes, polls, and draws.",
    keep: "Keep this code secure and use it only for your own daily votes.",
    profileApproved: "Identity profile change approved",
    profileRejected: "Identity profile change rejected",
    changeType: "Change type",
    oldValue: "Previous value",
    newValue: "Requested value",
    name: "Player name",
    email: "Email",
    profileApprovedNote: "The profile change was approved and is now active.",
    profileRejectedNote: "No profile information was changed.",
    cancelled: "Identity code cancellation completed",
    cancelledStatus: "Status",
    cancelledStatusValue: "Cancelled",
    cancelledNote: "The identity code is now invalid. This cancellation cannot be undone.",
    eligibilityApproved: "Exceptional voting eligibility approved",
    eligibilityRejected: "Exceptional voting eligibility rejected",
    eligibilityReason: "Application reason",
    eligibilityRejectionReason: "Administrator's rejection reason",
    eligibilityStats: "Current values at submission",
    eligibilityContribution: "Weekly contribution",
    eligibilityTechnology: "Technology points",
    eligibilityMaterials: "Materials",
    eligibilityActivity: "Weekly activity points",
    eligibilityVotes: "Allowed exceptional votes",
    eligibilityExpiry: "Exceptional eligibility valid until",
    eligibilityApprovedNote: "The administrator approved exceptional voting eligibility. Use it within the allowed count or validity period.",
    eligibilityRejectedNote: "The administrator rejected this exceptional voting eligibility request."
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
    password: "Mot de passe initial",
    passwordReset: "Réinitialisation du mot de passe du code d’identité",
    emailChange: "Vérification du changement d’adresse e-mail",
    verificationCode: "Code de vérification",
    renew: "Ce code a expiré. Vous pouvez demander une prolongation sur le site ou le mini-programme.",
    usage: "Ce code d’identité sert aux votes du jour, notamment aux votes technologiques, sondages et tirages au sort.",
    keep: "Conservez ce code en sécurité et utilisez-le uniquement pour vos votes du jour.",
    profileApproved: "Modification du profil approuvée",
    profileRejected: "Modification du profil refusée",
    changeType: "Type de modification",
    oldValue: "Valeur précédente",
    newValue: "Valeur demandée",
    name: "Nom du joueur",
    email: "E-mail",
    profileApprovedNote: "La modification du profil a été approuvée et est active.",
    profileRejectedNote: "Aucune information du profil n’a été modifiée.",
    cancelled: "Résiliation du code d’identité terminée",
    cancelledStatus: "État",
    cancelledStatusValue: "Résilié",
    cancelledNote: "Le code d’identité est maintenant invalide. Cette résiliation est irréversible.",
    eligibilityApproved: "Éligibilité exceptionnelle au vote approuvée",
    eligibilityRejected: "Éligibilité exceptionnelle au vote refusée",
    eligibilityReason: "Motif de la demande",
    eligibilityRejectionReason: "Motif du refus de l’administrateur",
    eligibilityStats: "Valeurs au moment de la demande",
    eligibilityContribution: "Contribution hebdomadaire",
    eligibilityTechnology: "Points technologiques",
    eligibilityMaterials: "Ressources",
    eligibilityActivity: "Points d’activité hebdomadaire",
    eligibilityVotes: "Votes exceptionnels autorisés",
    eligibilityExpiry: "Éligibilité exceptionnelle valable jusqu’au",
    eligibilityApprovedNote: "L’administrateur a approuvé l’éligibilité exceptionnelle. Utilisez-la dans la limite ou la période autorisée.",
    eligibilityRejectedNote: "L’administrateur a refusé cette demande d’éligibilité exceptionnelle."
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
    password: "初期パスワード",
    passwordReset: "本人確認コードのパスワード再設定",
    emailChange: "本人確認コードのメールアドレス変更確認",
    verificationCode: "確認コード",
    renew: "このコードは期限切れです。ウェブサイトまたはミニプログラムから延長を申請できます。",
    usage: "この本人確認コードは、技術投票、投票案件、抽選を含む日常投票に使用します。",
    keep: "コードを安全に保管し、ご本人の日常投票にのみ使用してください。",
    profileApproved: "本人確認コードのプロフィール変更が承認されました",
    profileRejected: "本人確認コードのプロフィール変更が却下されました",
    changeType: "変更項目",
    oldValue: "変更前",
    newValue: "申請内容",
    name: "プレイヤー名",
    email: "メールアドレス",
    profileApprovedNote: "プロフィール変更が承認され、反映されました。",
    profileRejectedNote: "プロフィール情報は変更されていません。",
    cancelled: "本人確認コードの解約が完了しました",
    cancelledStatus: "状態",
    cancelledStatusValue: "解約済み",
    cancelledNote: "本人確認コードは無効になりました。この解約は取り消せません。",
    eligibilityApproved: "特例投票資格申請が承認されました",
    eligibilityRejected: "特例投票資格申請が却下されました",
    eligibilityReason: "申請理由",
    eligibilityRejectionReason: "管理者の却下理由",
    eligibilityStats: "申請時の現在値",
    eligibilityContribution: "週間貢献度",
    eligibilityTechnology: "技術ポイント",
    eligibilityMaterials: "物資",
    eligibilityActivity: "週間アクティブポイント",
    eligibilityVotes: "許可された特例投票回数",
    eligibilityExpiry: "特例投票資格の有効期限",
    eligibilityApprovedNote: "管理者が特例投票資格を承認しました。許可された回数または期間内にご利用ください。",
    eligibilityRejectedNote: "管理者がこの特例投票資格申請を却下しました。"
  }
} as const;

export function identityMail(input: {
  locale: SupportedLocale;
  approved: boolean;
  requestType: "new" | "renewal" | "reissue";
  applicationNumber: string;
  playerName: string;
  code?: string;
  password?: string;
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
    if (input.password) rows.push([copy.password, input.password]);
    rows.push([copy.expiry, input.expiresAt ?? copy.permanent]);
  }
  if (!input.approved && input.reason) rows.push([copy.reason, input.reason]);
  const notes = input.approved ? [copy.usage, copy.keep] : [];
  const plain = [
    subject,
    "",
    ...rows.map(([key, value]) => `${key}: ${value}`),
    ...(notes.length ? ["", ...notes] : []),
    "",
    input.locale === "zh-cn"
      ? `版权所有 © ${new Date().getUTCFullYear()} 美国雨梦互联网有限公司 保留所有权利。`
      : `Copyright © ${new Date().getUTCFullYear()} Yume Internet LLC. All Rights Reserved.`
  ];
  return {
    subject,
    text: plain.join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: subject, rows, notes })
  };
}

export function voteEligibilityMail(input: {
  locale: SupportedLocale;
  approved: boolean;
  applicationNumber: string;
  playerName: string;
  reason: string;
  rejectionReason?: string | null;
  weeklyContribution: number;
  technologyPoints: number;
  materialContribution: number;
  weeklyActivityPoints: number;
  votes: number | null;
  expiresAt: string | null;
}): { subject: string; text: string; html: string } {
  const copy = COPY[input.locale];
  const subject = input.approved ? copy.eligibilityApproved : copy.eligibilityRejected;
  const rows: Array<[string, string]> = [
    [copy.application, input.applicationNumber],
    [copy.player, input.playerName],
    [copy.eligibilityReason, input.reason],
    [copy.eligibilityStats, `${copy.eligibilityContribution}: ${input.weeklyContribution}; ${copy.eligibilityTechnology}: ${input.technologyPoints}; ${copy.eligibilityMaterials}: ${input.materialContribution}; ${copy.eligibilityActivity}: ${input.weeklyActivityPoints}`]
  ];
  if (!input.approved && input.rejectionReason) {
    rows.splice(3, 0, [copy.eligibilityRejectionReason, input.rejectionReason]);
  }
  if (input.approved) {
    if (input.votes !== null) rows.push([copy.eligibilityVotes, String(input.votes)]);
    if (input.expiresAt) rows.push([copy.eligibilityExpiry, input.expiresAt]);
  }
  const notes = [input.approved ? copy.eligibilityApprovedNote : copy.eligibilityRejectedNote];
  const plain = [
    subject,
    "",
    ...rows.map(([key, value]) => `${key}: ${value}`),
    "",
    ...notes,
    "",
    input.locale === "zh-cn"
      ? `版权所有 © ${new Date().getUTCFullYear()} 美国雨梦互联网有限公司 保留所有权利。`
      : `Copyright © ${new Date().getUTCFullYear()} Yume Internet LLC. All Rights Reserved.`
  ];
  return {
    subject,
    text: plain.join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: subject, rows, notes })
  };
}

export function identityProfileChangeMail(input: {
  locale: SupportedLocale;
  approved: boolean;
  kind: "player_name" | "email";
  applicationNumber?: string | null;
  currentValue: string | null;
  requestedValue: string;
  reason?: string | null;
}): { subject: string; text: string; html: string } {
  const copy = COPY[input.locale];
  const subject = input.approved ? copy.profileApproved : copy.profileRejected;
  const rows: Array<[string, string]> = [];
  if (input.applicationNumber) rows.push([copy.application, input.applicationNumber]);
  rows.push(
    [copy.changeType, input.kind === "player_name" ? copy.name : copy.email],
    [copy.oldValue, input.currentValue ?? ""],
    [copy.newValue, input.requestedValue]
  );
  if (!input.approved && input.reason) rows.push([copy.reason, input.reason]);
  const notes = [input.approved ? copy.profileApprovedNote : copy.profileRejectedNote];
  const plain = [
    subject,
    "",
    ...rows.map(([key, value]) => `${key}: ${value}`),
    "",
    ...notes,
    "",
    input.locale === "zh-cn"
      ? `版权所有 © ${new Date().getUTCFullYear()} 美国雨梦互联网有限公司 保留所有权利。`
      : `Copyright © ${new Date().getUTCFullYear()} Yume Internet LLC. All Rights Reserved.`
  ];
  return {
    subject,
    text: plain.join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: subject, rows, notes })
  };
}

export function identityPasswordResetMail(input: {
  locale: SupportedLocale;
  playerName: string | null;
  code: string;
  otp?: string;
  initialPassword?: string;
}): { subject: string; text: string; html: string } {
  const copy = COPY[input.locale];
  const rows: Array<[string, string]> = [
    [copy.code, input.code]
  ];
  if (input.otp) rows.push([copy.verificationCode, input.otp]);
  if (input.initialPassword) rows.push([copy.password, input.initialPassword]);
  const notes = [
    ...(input.otp ? ["验证码有效期为10分钟，请勿向他人透露。"] : []),
    input.initialPassword
      ? "这是新的识别码密码，请妥善保管。"
      : "验证码验证通过后即可设置新的识别码密码。"
  ];
  return {
    subject: input.initialPassword ? copy.passwordReset : copy.passwordReset,
    text: [copy.passwordReset, "", ...rows.map(([key, value]) => `${key}: ${value}`), "", ...notes].join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: copy.passwordReset, rows, notes })
  };
}

export function identityEmailChangeMail(input: {
  locale: SupportedLocale;
  otp: string;
  newEmail: string;
}): { subject: string; text: string; html: string } {
  const copy = COPY[input.locale];
  const rows: Array<[string, string]> = [
    [copy.verificationCode, input.otp],
    ["新邮箱", input.newEmail]
  ];
  const notes = ["验证码有效期为10分钟，请勿向他人透露。"];
  return {
    subject: copy.emailChange,
    text: [copy.emailChange, "", ...rows.map(([key, value]) => `${key}: ${value}`), "", ...notes].join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: copy.emailChange, rows, notes })
  };
}

export function identityCancellationMail(input: {
  locale: SupportedLocale;
  otp: string;
}): { subject: string; text: string; html: string } {
  const subject = input.locale === "zh-cn"
    ? "身份识别码注销邮箱验证码"
    : input.locale === "zh-tw"
      ? "身分識別碼註銷信箱驗證碼"
      : input.locale === "ja"
        ? "本人確認コード解約メール確認コード"
        : input.locale === "fr"
          ? "Code de vérification de la résiliation du code d’identité"
          : "Identity code cancellation verification code";
  const note = input.locale === "zh-cn"
    ? "验证码有效期为10分钟。验证通过后识别码将立即失效，注销流程无法撤回。"
    : input.locale === "zh-tw"
      ? "驗證碼有效期為10分鐘。驗證通過後身分識別碼將立即失效，註銷流程無法撤回。"
      : input.locale === "ja"
        ? "確認コードは10分間有効です。確認後、本人確認コードは直ちに無効となり、解約処理は取り消せません。"
        : input.locale === "fr"
          ? "Le code est valable 10 minutes. Après vérification, le code sera immédiatement désactivé et la procédure est irréversible."
          : "The code is valid for 10 minutes. After verification, the identity code is immediately disabled and the cancellation cannot be undone.";
  const rows: Array<[string, string]> = [[COPY[input.locale].verificationCode, input.otp]];
  return {
    subject,
    text: [subject, "", ...rows.map(([key, value]) => `${key}: ${value}`), "", note].join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: subject, rows, notes: [note] })
  };
}

export function identityCancellationCompletedMail(input: {
  locale: SupportedLocale;
  playerName: string | null;
}): { subject: string; text: string; html: string } {
  const copy = COPY[input.locale];
  const rows: Array<[string, string]> = [];
  if (input.playerName) rows.push([copy.player, input.playerName]);
  rows.push([copy.cancelledStatus, copy.cancelledStatusValue]);
  const notes = [copy.cancelledNote];
  const plain = [
    copy.cancelled,
    "",
    ...rows.map(([key, value]) => `${key}: ${value}`),
    "",
    ...notes,
    "",
    input.locale === "zh-cn"
      ? `版权所有 © ${new Date().getUTCFullYear()} 美国雨梦互联网有限公司 保留所有权利。`
      : `Copyright © ${new Date().getUTCFullYear()} Yume Internet LLC. All Rights Reserved.`
  ];
  return {
    subject: copy.cancelled,
    text: plain.join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: copy.cancelled, rows, notes })
  };
}

export function identityApplicationVerificationMail(input: {
  locale: SupportedLocale;
  otp: string;
  purpose: "new" | "reissue";
}): { subject: string; text: string; html: string } {
  const copy = COPY[input.locale];
  const subject = input.locale === "zh-cn"
    ? "身份识别码申请邮箱验证码"
    : input.locale === "zh-tw"
      ? "身分識別碼申請信箱驗證碼"
      : input.locale === "ja"
        ? "本人確認コード申請メール確認コード"
        : input.locale === "fr"
          ? "Code de vérification de la demande de code d’identité"
          : "Identity code application verification code";
  const note = input.locale === "zh-cn"
    ? "验证码有效期为10分钟，请勿向他人透露。验证通过后才能继续提交申请。"
    : input.locale === "zh-tw"
      ? "驗證碼有效期為10分鐘，請勿向他人透露。驗證通過後才能繼續提交申請。"
      : input.locale === "ja"
        ? "確認コードの有効期限は10分です。確認後に申請を続行できます。"
        : input.locale === "fr"
          ? "Le code est valable 10 minutes. La demande pourra continuer après vérification."
          : "The verification code is valid for 10 minutes. You can continue the application after verification.";
  const rows: Array<[string, string]> = [[copy.verificationCode, input.otp]];
  return {
    subject,
    text: [subject, "", ...rows.map(([key, value]) => `${key}: ${value}`), "", note].join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: subject, rows, notes: [note] })
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
  const notes = [copy.usage, copy.keep, ...(input.expired ? [copy.renew] : [])];
  return {
    subject: copy.recovered,
    text: [
      copy.recovered,
      "",
      ...rows.map(([key, value]) => `${key}: ${value}`),
      "",
      ...notes
    ].join("\n"),
    html: renderYumeEmail({ locale: input.locale, title: copy.recovered, rows, notes })
  };
}
