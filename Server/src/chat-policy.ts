export interface ChatPolicy {
  MESSAGE_RETENTION_DAYS: number;
  SOFT_DELETE_RETENTION_DAYS: number;
  MAX_FILE_SIZE: number;
  ORPHAN_UPLOAD_RETENTION_DAYS: number;
  ALLOWED_FILE_TYPES: string;
}
export const CHAT_POLICY_DEFAULTS: Readonly<ChatPolicy> = Object.freeze({
  MESSAGE_RETENTION_DAYS: 7,
  SOFT_DELETE_RETENTION_DAYS: 60,
  MAX_FILE_SIZE: 20971520,
  ORPHAN_UPLOAD_RETENTION_DAYS: 1,
  ALLOWED_FILE_TYPES: "image/,video/,audio/,application/pdf,text/plain",
});
export function validateChatPolicy(value: unknown): ChatPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("聊天参数无效");
  const input = value as Record<string, unknown>;
  const policy: ChatPolicy = { ...CHAT_POLICY_DEFAULTS };
  for (const [key, min, max] of [
    ["MESSAGE_RETENTION_DAYS", 1, 3650],
    ["SOFT_DELETE_RETENTION_DAYS", 1, 3650],
    ["ORPHAN_UPLOAD_RETENTION_DAYS", 1, 30],
    ["MAX_FILE_SIZE", 1024, 26214400],
  ] as const) {
    const number = Number(input[key]);
    if (!Number.isInteger(number) || number < min || number > max)
      throw new Error(`${key} 必须在 ${min}–${max} 之间`);
    policy[key] = number;
  }
  const types = String(input.ALLOWED_FILE_TYPES || "").trim();
  if (
    !types ||
    types.length > 500 ||
    types
      .split(",")
      .some((type) => !/^[a-z0-9.+-]+\/[a-z0-9.+-]*$/.test(type.trim()))
  )
    throw new Error("允许的文件类型无效");
  policy.ALLOWED_FILE_TYPES = types;
  return policy;
}
export async function getChatPolicy(env: Pick<Env, "DB">): Promise<ChatPolicy> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='chat_policy'",
  ).first<{ value: string }>();
  return row
    ? validateChatPolicy(JSON.parse(row.value))
    : { ...CHAT_POLICY_DEFAULTS };
}
export async function chatRuntimeEnv(env: Env) {
  return { ...env, ...(await getChatPolicy(env)) };
}
