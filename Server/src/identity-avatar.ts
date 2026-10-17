import { boundedBody, BodyTooLarge } from "./request-limits";
import {
  identityAvatarUrl,
  identityCookieToken,
  identityRequestAllowed,
  validateIdentitySession,
} from "./identity-session";
import { getAuthenticatedSession } from "./auth";
import { json, problem } from "./response";
const MAX_BYTES = 5 * 1024 * 1024;

export function avatarFormat(
  bytes: Uint8Array,
): { type: string; extension: string } | null {
  if (
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    return { type: "image/png", extension: "png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { type: "image/jpeg", extension: "jpg" };
  const head = new TextDecoder().decode(bytes.slice(0, 12));
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP")
    return { type: "image/webp", extension: "webp" };
  return null;
}
export function storageRoot(env: Env): string {
  const prefix = String(env.STORAGE_PREFIX || "lifeafter").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (
    !prefix ||
    prefix.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid STORAGE_PREFIX");
  return prefix;
}
export async function handleIdentityAvatar(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!identityRequestAllowed(request)) return problem("请求被拒绝", 403);
  const account = await validateIdentitySession(
    env,
    identityCookieToken(request),
  );
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/api/public/identity-avatar") {
    if (!account)
      return problem("请先登录身份识别码", 401, "identity_login_required");
    if (!env.FILES) return problem("未配置头像存储", 503);
    if (Number(request.headers.get("content-length")) > MAX_BYTES + 65536)
      return problem("头像不能超过5MB", 413);
    let body: Uint8Array<ArrayBuffer>;
    try {
      body = await boundedBody(request, MAX_BYTES + 65536);
    } catch (error) {
      if (error instanceof BodyTooLarge) return problem("头像不能超过5MB", 413);
      throw error;
    }
    const form = await new Response(body, {
      headers: { "Content-Type": request.headers.get("Content-Type") || "" },
    }).formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size > MAX_BYTES || file.size < 12)
      return problem("请选择5MB以内的PNG、JPEG或WebP图片", 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = avatarFormat(bytes);
    if (!format || file.type !== format.type)
      return problem("头像仅支持PNG、JPEG或WebP图片", 400);
    const key = `${storageRoot(env)}/avatars/${account.id}/${crypto.randomUUID()}.${format.extension}`;
    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: format.type },
      customMetadata: { identity_id: account.id, kind: "identity-avatar" },
    });
    try {
      // Password reset, disablement or expiry during the upload must not authorize a write.
      const current = await validateIdentitySession(
        env,
        identityCookieToken(request),
      );
      if (!current) throw new Error("登录已失效");
      const updated =
        await env.DB.prepare(`UPDATE identity_codes SET avatar_key = ? WHERE id = ?
        AND avatar_key IS ? AND password_hash = ? AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)`)
          .bind(
            key,
            account.id,
            account.avatar_key,
            account.password_hash,
            new Date().toISOString(),
          )
          .run();
      if (!updated.meta.changes)
        throw new Error("头像已更新或登录已失效，请重试");
    } catch (error) {
      await env.FILES.delete(key);
      throw error;
    }
    if (
      account.avatar_key?.startsWith(
        `${storageRoot(env)}/avatars/${account.id}/`,
      )
    )
      await env.FILES.delete(account.avatar_key);
    return json({
      avatarUrl: identityAvatarUrl({ ...account, avatar_key: key }),
    });
  }
  if (["GET", "HEAD"].includes(request.method)) {
    if (!account && !(await getAuthenticatedSession(request, env)))
      return problem("请先登录身份识别码", 401);
    const id = path.slice("/api/public/identity-avatar/".length);
    const row = await env.DB.prepare(
      "SELECT avatar_key FROM identity_codes WHERE id = ?",
    )
      .bind(id)
      .first<{ avatar_key: string | null }>();
    if (!row?.avatar_key || !env.FILES) return problem("头像不存在", 404);
    const object = await env.FILES.get(row.avatar_key);
    if (!object) return problem("头像不存在", 404);
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return problem("Not found", 404);
}
