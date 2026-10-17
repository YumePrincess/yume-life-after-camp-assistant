import { decryptSecret, keyedHash } from "./crypto";
import type { IdentityCodeRow } from "./identity";

export const IDENTITY_COOKIE = "mrzh_identity";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export type IdentityWebAccount = IdentityCodeRow & {
  avatar_key: string | null;
};

function identityCookieName(request: Request): string {
  return new URL(request.url).protocol === "https:"
    ? `__Host-${IDENTITY_COOKIE}`
    : IDENTITY_COOKIE;
}
export function identityCookieToken(request: Request): string {
  const name = identityCookieName(request);
  return (
    (request.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ""
  );
}

export function identityCookie(request: Request, token: string): string {
  return `${identityCookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_MS / 1000 : 0}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

export function identityRequestAllowed(request: Request): boolean {
  if (
    ["GET", "HEAD"].includes(request.method) &&
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    return request.headers.get("sec-fetch-site") !== "cross-site";
  }
  return request.headers.get("origin") === new URL(request.url).origin;
}

export function identityIsActive(
  code: Pick<IdentityWebAccount, "status" | "expires_at">,
  time = Date.now(),
): boolean {
  return (
    code.status === "active" &&
    (!code.expires_at || Date.parse(code.expires_at) > time)
  );
}

export async function issueIdentitySession(
  env: Env,
  request: Request,
  identityCode: string,
): Promise<{ cookie: string; avatarUrl: string }> {
  const code = await env.DB.prepare(
    "SELECT * FROM identity_codes WHERE code_hash = ?",
  )
    .bind(await keyedHash(env, "identity-code", identityCode))
    .first<IdentityWebAccount>();
  // A renewal voting grace period never grants chat access.
  if (!code || !identityIsActive(code) || !code.password_hash)
    return { cookie: identityCookie(request, ""), avatarUrl: "" };
  const existingToken = identityCookieToken(request);
  const existing = await validateIdentitySession(env, existingToken);
  if (existing?.id === code.id)
    return {
      cookie: identityCookie(request, existingToken),
      avatarUrl: identityAvatarUrl(code),
    };
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(
    Math.min(
      Date.now() + SESSION_MS,
      code.expires_at ? Date.parse(code.expires_at) : Infinity,
    ),
  ).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM identity_web_sessions WHERE expires_at <= ?",
    ).bind(new Date().toISOString()),
    env.DB.prepare(
      `INSERT INTO identity_web_sessions(token_hash,identity_code_id,code_hash,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)`,
    ).bind(
      await keyedHash(env, "identity-web-session", token),
      code.id,
      code.code_hash,
      code.password_hash,
      expiresAt,
      new Date().toISOString(),
    ),
  ]);
  return {
    cookie: identityCookie(request, token),
    avatarUrl: identityAvatarUrl(code),
  };
}

export async function validateIdentitySession(
  env: Env,
  token: string,
): Promise<IdentityWebAccount | null> {
  if (!/^[a-f0-9-]{72}$/.test(token)) return null;
  const code = await env.DB.prepare(`SELECT i.* FROM identity_web_sessions s
    JOIN identity_codes i ON i.id = s.identity_code_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND s.code_hash = i.code_hash
      AND s.password_hash = i.password_hash LIMIT 1`)
    .bind(
      await keyedHash(env, "identity-web-session", token),
      new Date().toISOString(),
    )
    .first<IdentityWebAccount>();
  return code && identityIsActive(code) ? code : null;
}

export async function revokeIdentitySession(
  env: Env,
  request: Request,
): Promise<void> {
  const token = identityCookieToken(request);
  if (token)
    await env.DB.prepare(
      "DELETE FROM identity_web_sessions WHERE token_hash = ?",
    )
      .bind(await keyedHash(env, "identity-web-session", token))
      .run();
}

export function identityAvatarUrl(
  code: Pick<IdentityWebAccount, "id" | "avatar_key">,
): string {
  return code.avatar_key
    ? `/api/public/identity-avatar/${encodeURIComponent(code.id)}?v=${encodeURIComponent(code.avatar_key)}`
    : "";
}

export async function identitySessionSummary(
  env: Env,
  code: IdentityWebAccount,
) {
  return {
    identityCode: await decryptSecret(
      env,
      "identity-code-value",
      code.code_encrypted,
    ),
    playerName: code.player_name || "",
    avatarUrl: identityAvatarUrl(code),
    expiresAt: code.expires_at,
  };
}

// A request-local, server-created context cannot be forged through JSON input.
const requestAccount = Symbol("identity-request-account");
type RequestIdentityEnv = Env & { [requestAccount]?: IdentityWebAccount };
export async function withIdentityRequestSession(
  request: Request,
  env: Env,
): Promise<Env> {
  if (!identityRequestAllowed(request)) return env;
  const token = identityCookieToken(request);
  if (!token) return env;
  const account = await validateIdentitySession(env, token);
  return account
    ? (Object.assign(Object.create(env), {
        [requestAccount]: account,
      }) as RequestIdentityEnv)
    : env;
}
export function requestIdentityAccount(
  env: Env,
): IdentityWebAccount | undefined {
  return (env as RequestIdentityEnv)[requestAccount];
}
