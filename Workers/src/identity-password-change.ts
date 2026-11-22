import { timingSafeEqual } from "./auth";
import { boundedBody, BodyTooLarge } from "./request-limits";
import {
  hashPassword,
  verifyPassword,
  keyedHash,
} from "./crypto";
import {
  identityCookie,
  identityCookieToken,
  identityRequestAllowed,
  validateIdentitySession,
} from "./identity-session";
import {
  checkValueRateLimit,
  recordValueRateLimitAttempt,
  clearValueRateLimitAttempts,
} from "./rate-limit";
import { json, problem } from "./response";

const POLICY = {
  scope: "identity-password-change",
  maximum: 5,
  windowSeconds: 900,
  blockSeconds: 900,
};
const PROOF_DURATION = 5 * 60_000;

export async function handleIdentityPasswordChange(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return problem("Method not allowed", 405);
  if (!identityRequestAllowed(request)) return problem("请求被拒绝", 403);
  const token = identityCookieToken(request);
  const account = await validateIdentitySession(env, token);
  if (!account)
    return problem("请先登录有效的身份识别码", 401, "identity_login_required");
  const limit = await checkValueRateLimit(account.id, env, POLICY);
  if (!limit.allowed)
    return json({ error: "尝试次数过多，请15分钟后重试。" }, 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(await boundedBody(request, 2048)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return problem("请求参数无效", 400);
    body = value as Record<string, unknown>;
  } catch (error) {
    return problem(
      error instanceof BodyTooLarge ? "请求体过大" : "请求参数无效",
      error instanceof BodyTooLarge ? 413 : 400,
    );
  }
  const signature = (expires: number) =>
    keyedHash(
      env,
      "identity-password-change",
      `${account.id}:${token}:${account.password_hash}:${expires}`,
    );
  if (body.action === "verify") {
    if (
      typeof body.oldPassword !== "string" ||
      body.oldPassword.length > 32 ||
      !(await verifyPassword(body.oldPassword, account.password_hash))
    ) {
      await recordValueRateLimitAttempt(account.id, env, POLICY);
      return problem("旧密码错误，请重新输入。", 400, "old_password_invalid");
    }
    const expires = Date.now() + PROOF_DURATION;
    await clearValueRateLimitAttempts(account.id, env, POLICY);
    return json(
      { verificationToken: `${expires}.${await signature(expires)}` },
      200,
      { "Cache-Control": "no-store" },
    );
  }
  if (body.action !== "set") return problem("请求参数无效", 400);
  const [time, proof, ...extra] =
    typeof body.verificationToken === "string"
      ? body.verificationToken.split(".")
      : [];
  const expires = Number(time);
  if (
    extra.length ||
    !proof ||
    !Number.isSafeInteger(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + PROOF_DURATION ||
    !(await timingSafeEqual(proof, await signature(expires)))
  ) {
    await recordValueRateLimitAttempt(account.id, env, POLICY);
    return problem(
      "验证已失效，请重新验证旧密码。",
      400,
      "password_verification_expired",
    );
  }
  if (
    typeof body.newPassword !== "string" ||
    body.newPassword.length < 6 ||
    body.newPassword.length > 32
  )
    return problem("密码必须为6至32位", 400);
  if (await verifyPassword(body.newPassword, account.password_hash))
    return problem("新密码不能与旧密码相同。", 400);
  const hash = await hashPassword(body.newPassword);
  const now = new Date().toISOString();
  const result =
    await env.DB.prepare(`UPDATE identity_codes SET password_hash=?,password_set_at=COALESCE(password_set_at,?),password_updated_at=?,updated_at=?
    WHERE id=? AND password_hash=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at)>CURRENT_TIMESTAMP)`)
      .bind(hash, now, now, now, account.id, account.password_hash)
      .run();
  if (!result.meta.changes)
    return problem("验证已失效，请重新验证旧密码。", 409);
  // Explicitly revoke every device, including databases upgraded before the revocation trigger existed.
  await env.DB.prepare(
    "DELETE FROM identity_web_sessions WHERE identity_code_id=?",
  )
    .bind(account.id)
    .run();
  await clearValueRateLimitAttempts(account.id, env, POLICY);
  return json({ ok: true }, 200, {
    "Set-Cookie": identityCookie(request, ""),
    "Cache-Control": "no-store",
  });
}
