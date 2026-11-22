import { avatarFormat, storageRoot } from "./identity-avatar";
import { boundedBody, BodyTooLarge } from "./request-limits";
import { json, problem } from "./response";
import { getAuthenticatedSession } from "./auth";
import { identityCookieToken, identityRequestAllowed, validateIdentitySession } from "./identity-session";
import { GENERAL_AVATAR_SETTING } from "../chat/shared/general-avatar";

const MAX_BYTES = 5 * 1024 * 1024;
export function adminGeneralAvatarUrl(key: string | null | undefined): string {
  return key ? `/api/admin/chat/general/avatar?v=${encodeURIComponent(key)}` : "";
}
export async function generalAvatarKey(env: Env): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(GENERAL_AVATAR_SETTING).first<{ value: string }>())?.value ?? null;
}
async function readAvatar(request: Request, env: Env): Promise<Response> {
  const key = await generalAvatarKey(env);
  if (!key || !env.FILES) return problem("头像不存在", 404);
  const object = await env.FILES.get(key);
  if (!object) return problem("头像不存在", 404);
  return new Response(request.method === "HEAD" ? null : object.body, { headers: {
    "Content-Type": object.httpMetadata?.contentType || "image/webp",
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"
  } });
}
export async function handlePublicGeneralAvatar(request: Request, env: Env): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) return problem("Method not allowed", 405);
  if (!identityRequestAllowed(request)) return problem("请求被拒绝", 403);
  const identity = await validateIdentitySession(env, identityCookieToken(request));
  if (!identity && !(await getAuthenticatedSession(request, env))) return problem("请先登录身份识别码", 401);
  return readAvatar(request, env);
}

/** Called only after the system OIDC/Key session and admin:chat permission check. */
export async function handleGeneralAvatar(request: Request, env: Env): Promise<Response> {
  if (!["GET", "HEAD", "POST"].includes(request.method)) return problem("Method not allowed", 405);
  if (!env.FILES) return problem("未配置头像存储", 503);
  if (["GET", "HEAD"].includes(request.method)) return readAvatar(request, env);
  if (Number(request.headers.get("content-length")) > MAX_BYTES + 65536) return problem("头像不能超过5MB", 413);
  let form: FormData;
  try {
    const body = await boundedBody(request, MAX_BYTES + 65536);
    form = await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type") || "" } }).formData();
  } catch (error) {
    return error instanceof BodyTooLarge ? problem("头像不能超过5MB", 413) : problem("请选择5MB以内的PNG、JPEG或WebP图片", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 12 || file.size > MAX_BYTES) return problem("请选择5MB以内的PNG、JPEG或WebP图片", 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = avatarFormat(bytes);
  if (!format || format.type !== file.type) return problem("头像仅支持PNG、JPEG或WebP图片", 400);
  const previous = await generalAvatarKey(env);
  const prefix = `${storageRoot(env)}/avatars/general/`;
  const key = `${prefix}${crypto.randomUUID()}.${format.extension}`;
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: format.type }, customMetadata: { kind: "general-avatar" }
  });
  try {
    // System avatars are site settings, never files attributed to an identity-code user.
    const result = await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE settings.value IS ?`)
      .bind(GENERAL_AVATAR_SETTING, key, new Date().toISOString(), previous).run();
    if (!result.meta.changes) {
      await env.FILES.delete(key);
      return problem("头像已更新，请重试。", 409);
    }
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }
  if (previous?.startsWith(prefix)) {
    try { await env.FILES.delete(previous); }
    catch (error) { console.warn("Previous general avatar cleanup failed", error); }
  }
  return json({ avatarUrl: adminGeneralAvatarUrl(key) });
}
