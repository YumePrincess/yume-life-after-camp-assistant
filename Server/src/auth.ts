import {
  createTemporaryKey,
  deleteExpiredSessions,
  deleteSession,
  getTemporaryKey,
  getConfigBundle,
  getSession,
  listTemporaryKeys,
  markTemporaryKeyUsed,
  revokeTemporaryKey,
  saveSession,
  updateTemporaryKeyPermissions,
  type SessionRow
} from "./db";
import { json, problem, redirect } from "./response";

const SESSION_COOKIE = "mrzh_session";
const STATE_COOKIE = "mrzh_oidc_state";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_CHECK_SECONDS = 5;

export const ADMIN_PERMISSIONS = [
  "demo:preview",
  "admin:overview",
  "admin:general",
  "admin:tasks",
  "admin:agent",
  "admin:technology",
  "admin:technology-history",
  "admin:identity-review",
  "admin:identity-codes",
  "admin:smtp",
  "admin:access",
  "admin:members",
  "admin:history",
  // Legacy action permissions remain valid for previously issued keys.
  "config:write",
  "technology-history:manage",
  "task:run",
  "task:interrupt",
  "keys:manage",
  "identity:review",
  "identity:manage",
  "smtp:manage"
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const MODULE_PERMISSION_ALIASES: Partial<
  Record<AdminPermission, readonly AdminPermission[]>
> = {
  "admin:overview": ["task:run"],
  "admin:general": ["config:write"],
  "admin:tasks": ["config:write"],
  "admin:agent": ["config:write"],
  "admin:technology": ["config:write"],
  "admin:technology-history": ["technology-history:manage"],
  "admin:identity-review": ["identity:review"],
  "admin:identity-codes": ["identity:manage"],
  "admin:smtp": ["smtp:manage"],
  "admin:access": ["keys:manage"],
  "admin:history": ["task:interrupt"],
  "task:run": ["admin:overview"],
  "task:interrupt": ["admin:history"],
  "keys:manage": ["admin:access"],
  "identity:review": ["admin:identity-review"],
  "identity:manage": ["admin:identity-codes"],
  "smtp:manage": ["admin:smtp"],
  "technology-history:manage": ["admin:technology-history"]
};
type OidcMode = "login" | "silent" | "check";

interface DiscoveryDocument {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

interface OidcState {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  mode: OidcMode;
  sessionId: string | null;
  expectedEmail: string | null;
  createdAt: number;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface UserInfo {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  preferred_username?: unknown;
}

function parseCookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return result;
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function stateCookie(value: string, maxAgeSeconds: number): string {
  return `${STATE_COOKIE}=${value}; Path=/auth/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function base64Url(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealState(env: Env, state: OidcState): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await signingKey(env.SESSION_SECRET),
    new TextEncoder().encode(JSON.stringify(state))
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function unsealState(env: Env, value: string): Promise<OidcState | null> {
  try {
    const [encodedIv, encodedCiphertext] = value.split(".");
    if (!encodedIv || !encodedCiphertext) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(fromBase64Url(encodedIv)) },
      await signingKey(env.SESSION_SECRET),
      arrayBuffer(fromBase64Url(encodedCiphertext))
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as OidcState;
  } catch {
    return null;
  }
}

function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/admin";
  return value.startsWith("/admin") ? value : "/admin";
}

function issuer(env: Env): string {
  const value = env.OIDC_ISSUER.trim().replace(/\/+$/, "");
  if (!value.startsWith("https://")) throw new Error("OIDC_ISSUER must use HTTPS");
  return value;
}

async function discovery(env: Env): Promise<DiscoveryDocument> {
  const response = await fetch(`${issuer(env)}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
  const document = await response.json<DiscoveryDocument>();
  if (document.issuer?.replace(/\/+$/, "") !== issuer(env)) {
    throw new Error("OIDC discovery issuer mismatch");
  }
  return document;
}

function allowedEmails(env: Env): Set<string> {
  return new Set(
    env.OIDC_ALLOWED_EMAILS.split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function requireVerifiedEmail(env: Env): boolean {
  return /^(1|true|yes|on)$/i.test(env.OIDC_REQUIRE_VERIFIED_EMAIL.trim());
}

export function sessionPermissions(session: SessionRow): string[] {
  // OIDC is the system administrator identity source. Keep it authoritative
  // even for sessions created before wildcard permissions were persisted.
  if (session.auth_method === "oidc") return ["*"];
  try {
    const value = JSON.parse(session.permissions_json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function hasPermission(
  session: SessionRow,
  permission: AdminPermission
): boolean {
  const permissions = sessionPermissions(session);
  if (permissions.includes("*") || permissions.includes(permission)) return true;
  return (MODULE_PERMISSION_ALIASES[permission] ?? []).some((alias) =>
    permissions.includes(alias)
  );
}

export function canViewAdminModule(
  session: SessionRow,
  permission: AdminPermission
): boolean {
  return (
    permission.startsWith("admin:") &&
    (hasPermission(session, permission) ||
      sessionPermissions(session).includes("demo:preview"))
  );
}

export async function getAuthenticatedSession(
  request: Request,
  env: Env
): Promise<SessionRow | null> {
  const sessionId = parseCookies(request).get(SESSION_COOKIE);
  if (!sessionId) return null;
  return getSession(env, sessionId);
}

export async function requireAdmin(
  request: Request,
  env: Env,
  options: {
    api?: boolean;
    mutation?: boolean;
    permission?: AdminPermission;
  } = {}
): Promise<{ session: SessionRow } | { response: Response }> {
  const session = await getAuthenticatedSession(request, env);
  if (!session) {
    return {
      response: options.api
        ? problem("Authentication required", 401, "authentication_required")
        : redirect(`/login?returnTo=${encodeURIComponent(new URL(request.url).pathname)}`)
    };
  }

  if (options.mutation) {
    const requestOrigin = request.headers.get("Origin");
    const expectedOrigin = new URL(request.url).origin;
    if (requestOrigin && requestOrigin !== expectedOrigin) {
      return { response: problem("Invalid request origin", 403, "invalid_origin") };
    }
    const csrf = request.headers.get("X-CSRF-Token");
    if (!csrf || !(await timingSafeEqual(csrf, session.csrf_token))) {
      return { response: problem("Invalid CSRF token", 403, "invalid_csrf") };
    }
  }

  if (
    options.permission &&
    !(options.permission.startsWith("admin:")
      ? canViewAdminModule(session, options.permission)
      : hasPermission(session, options.permission))
  ) {
    return {
      response: problem("当前登录凭据没有执行此操作的权限", 403, "permission_denied")
    };
  }

  return { session };
}

export async function handleOidcStart(request: Request, env: Env): Promise<Response> {
  return handleOidcAuthorize(request, env, "login");
}

export async function handleOidcSilentStart(
  request: Request,
  env: Env
): Promise<Response> {
  const mode: OidcMode =
    new URL(request.url).searchParams.get("mode") === "check" ? "check" : "silent";
  return handleOidcAuthorize(request, env, mode);
}

async function handleOidcAuthorize(
  request: Request,
  env: Env,
  mode: OidcMode
): Promise<Response> {
  const document = await discovery(env);
  if (!document.authorization_endpoint) throw new Error("Missing OIDC authorization endpoint");
  const url = new URL(request.url);
  const current = await getAuthenticatedSession(request, env);
  const verifier = randomToken(64);
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  const state: OidcState = {
    state: randomToken(),
    verifier,
    nonce: randomToken(),
    returnTo: sanitizeReturnTo(url.searchParams.get("returnTo")),
    mode,
    sessionId: current?.id ?? null,
    expectedEmail: mode === "check" ? current?.email ?? null : null,
    createdAt: Date.now()
  };
  const authorizationUrl = new URL(document.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", env.OIDC_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", env.OIDC_REDIRECT_URI);
  authorizationUrl.searchParams.set("scope", env.OIDC_SCOPES);
  authorizationUrl.searchParams.set("state", state.state);
  authorizationUrl.searchParams.set("nonce", state.nonce);
  authorizationUrl.searchParams.set("code_challenge", base64Url(new Uint8Array(challengeBytes)));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (mode !== "login") authorizationUrl.searchParams.set("prompt", "none");

  return redirect(authorizationUrl.toString(), {
    "Set-Cookie": stateCookie(await sealState(env, state), STATE_DURATION_MS / 1000)
  });
}

export async function handleOidcCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sealed = parseCookies(request).get(STATE_COOKIE);
  const state = sealed ? await unsealState(env, sealed) : null;
  const clearState = stateCookie("", 0);
  if (
    !state ||
    Date.now() - state.createdAt > STATE_DURATION_MS ||
    url.searchParams.get("state") !== state.state
  ) {
    return redirect("/login?error=invalid_state", { "Set-Cookie": clearState });
  }
  if (url.searchParams.has("error")) {
    if (state.mode === "silent") return silentNoop(clearState);
    if (state.mode === "check") {
      if (state.sessionId) await deleteSession(env, state.sessionId);
      return redirect("/login?error=oidc_session_expired", clearAuthHeaders(clearState));
    }
    return redirect("/login?error=oidc_denied", { "Set-Cookie": clearState });
  }
  const code = url.searchParams.get("code");
  if (!code) return redirect("/login?error=missing_code", { "Set-Cookie": clearState });

  const document = await discovery(env);
  if (!document.token_endpoint || !document.userinfo_endpoint) {
    throw new Error("Incomplete OIDC discovery document");
  }
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.OIDC_REDIRECT_URI,
    client_id: env.OIDC_CLIENT_ID,
    code_verifier: state.verifier
  });
  const tokenHeaders = new Headers({
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded"
  });
  if (env.OIDC_TOKEN_AUTH_METHOD === "client_secret_basic") {
    tokenHeaders.set(
      "Authorization",
      `Basic ${btoa(`${env.OIDC_CLIENT_ID}:${env.OIDC_CLIENT_SECRET}`)}`
    );
  } else if (env.OIDC_TOKEN_AUTH_METHOD !== "none") {
    tokenBody.set("client_secret", env.OIDC_CLIENT_SECRET);
  }
  const tokenResponse = await fetch(document.token_endpoint, {
    method: "POST",
    headers: tokenHeaders,
    body: tokenBody
  });
  const token = await tokenResponse.json<TokenResponse>();
  if (!tokenResponse.ok || !token.access_token) {
    console.error(
      JSON.stringify({
        event: "oidc_token_exchange_failed",
        status: tokenResponse.status,
        error: token.error
      })
    );
    return redirect("/login?error=token_exchange_failed", { "Set-Cookie": clearState });
  }

  const userInfoResponse = await fetch(document.userinfo_endpoint, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token.access_token}`
    }
  });
  if (!userInfoResponse.ok) {
    return redirect("/login?error=userinfo_failed", { "Set-Cookie": clearState });
  }
  const claims = await userInfoResponse.json<UserInfo>();
  const emailClaim = env.OIDC_EMAIL_CLAIM || "email";
  const dynamicClaims = claims as Record<string, unknown>;
  const emailValue = dynamicClaims[emailClaim];
  const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : "";
  if (
    !email ||
    (!allowedEmails(env).has("*") && !allowedEmails(env).has(email)) ||
    (requireVerifiedEmail(env) && claims.email_verified !== true)
  ) {
    return oidcFailure(state, "/login?error=unauthorized", clearState);
  }

  await deleteExpiredSessions(env);
  if (state.mode === "check" && state.expectedEmail && state.expectedEmail !== email) {
    if (state.sessionId) await deleteSession(env, state.sessionId);
    return redirect("/login?error=oidc_session_expired", clearAuthHeaders(clearState));
  }
  if (state.sessionId) await deleteSession(env, state.sessionId);
  const now = new Date();
  const session: SessionRow = {
    id: randomToken(32),
    csrf_token: randomToken(32),
    email,
    display_name:
      typeof claims.name === "string"
        ? claims.name
        : typeof claims.preferred_username === "string"
          ? claims.preferred_username
          : null,
    auth_method: "oidc",
    permissions_json: JSON.stringify(["*"]),
    oidc_id_token: token.id_token ?? null,
    oidc_last_checked_at: now.toISOString(),
    temp_key_id: null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_DURATION_MS).toISOString(),
    last_checked_at: now.toISOString()
  };
  await saveSession(env, session);
  const headers = new Headers();
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", sessionCookie(session.id, SESSION_DURATION_MS / 1000));
  if (state.mode === "silent") {
    return silentSuccess(state.returnTo, headers);
  }
  return redirect(state.returnTo, headers);
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const sessionId = parseCookies(request).get(SESSION_COOKIE);
  const session = sessionId ? await getSession(env, sessionId) : null;
  if (sessionId) await deleteSession(env, sessionId);
  const headers = new Headers({ "Set-Cookie": sessionCookie("", 0) });
  let target = env.OIDC_POST_LOGOUT_REDIRECT_URI || "/";
  if (session?.auth_method === "oidc") {
    try {
      const document = await discovery(env);
      if (document.end_session_endpoint) {
        const logout = new URL(document.end_session_endpoint);
        if (session.oidc_id_token) {
          logout.searchParams.set("id_token_hint", session.oidc_id_token);
        }
        logout.searchParams.set("client_id", env.OIDC_CLIENT_ID);
        logout.searchParams.set(
          "post_logout_redirect_uri",
          env.OIDC_POST_LOGOUT_REDIRECT_URI || new URL("/", request.url).toString()
        );
        target = logout.toString();
      }
    } catch (error) {
      console.error("OIDC synchronized logout discovery failed", error);
    }
  }
  headers.set("Location", target);
  return new Response(null, { status: 302, headers });
}

export async function maybeValidateOidcSession(
  request: Request,
  env: Env
): Promise<Response | null> {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/admin") return null;
  const session = await getAuthenticatedSession(request, env);
  if (!session || session.auth_method !== "oidc") return null;
  const checkedAt = Date.parse(session.oidc_last_checked_at || "");
  const configured = Number(env.OIDC_SESSION_CHECK_INTERVAL_SECONDS);
  const seconds =
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_SESSION_CHECK_SECONDS;
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < seconds * 1000) return null;
  const target = new URL("/auth/oidc/silent", request.url);
  target.searchParams.set("mode", "check");
  target.searchParams.set("returnTo", "/admin");
  return redirect(target.pathname + target.search);
}

export async function handleTemporaryKeyLogin(
  request: Request,
  env: Env
): Promise<Response> {
  const bundle = await getConfigBundle(env);
  if (!bundle.authConfig.temporaryKeyLoginEnabled) {
    return problem("临时 Key 登录当前未开放", 403, "temporary_key_login_disabled");
  }
  const body = (await request.json().catch(() => null)) as
    | { key?: unknown; returnTo?: unknown }
    | null;
  const raw = typeof body?.key === "string" ? body.key.trim() : "";
  const match = /^mrzh_([A-Za-z0-9_-]{8,40})\.([A-Za-z0-9_-]{32,})$/.exec(raw);
  if (!match) return problem("临时 Key 无效", 401, "invalid_temporary_key");
  const id = match[1];
  const secret = match[2];
  if (!id || !secret) return problem("临时 Key 无效", 401, "invalid_temporary_key");
  const record = await getTemporaryKey(env, id);
  if (
    !record ||
    record.revoked_at ||
    (record.permanent !== 1 && Date.parse(record.expires_at) <= Date.now()) ||
    !(await timingSafeEqual(await sha256Hex(secret), record.secret_hash))
  ) {
    return problem("临时 Key 无效、已过期或已撤销", 401, "invalid_temporary_key");
  }
  const now = new Date();
  const expiresAt = new Date(record.permanent === 1
    ? now.getTime() + SESSION_DURATION_MS
    : Math.min(now.getTime() + SESSION_DURATION_MS, Date.parse(record.expires_at)));
  const session: SessionRow = {
    id: randomToken(32),
    csrf_token: randomToken(32),
    email: `temporary-key:${record.id}`,
    display_name: record.name,
    auth_method: "temporary_key",
    permissions_json: record.permissions_json,
    oidc_id_token: null,
    oidc_last_checked_at: null,
    temp_key_id: record.id,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    last_checked_at: now.toISOString()
  };
  await saveSession(env, session);
  await markTemporaryKeyUsed(env, record.id);
  return json(
    { ok: true, returnTo: sanitizeReturnTo(String(body?.returnTo || "/admin")) },
    200,
    { "Set-Cookie": sessionCookie(session.id, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)) }
  );
}

export async function issueTemporaryKey(
  env: Env,
  input: {
    name: string;
    expiresAt: string;
    permanent: boolean;
    permissions: string[];
    createdBy: string;
  }
): Promise<{ key: string; id: string }> {
  const id = randomToken(9);
  // The visible value always contains letters (mrzh), symbols (_ . -) and
  // digits, while the random body still provides substantially more than
  // 20 characters of entropy-bearing material.
  const randomDigit = String((crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 10);
  const secret = `${randomToken(36)}-${randomDigit}`;
  await createTemporaryKey(env, {
    id,
    name: input.name,
    secret_hash: await sha256Hex(secret),
    permissions_json: JSON.stringify(input.permissions),
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    expires_at: input.expiresAt,
    permanent: input.permanent ? 1 : 0
  });
  return { id, key: `mrzh_${id}.${secret}` };
}

export { listTemporaryKeys, revokeTemporaryKey, updateTemporaryKeyPermissions };

function oidcFailure(state: OidcState, location: string, clearState: string): Response {
  return state.mode === "silent"
    ? silentNoop(clearState)
    : redirect(location, { "Set-Cookie": clearState });
}

function silentSuccess(returnTo: string, headers: Headers): Response {
  const nonce = randomToken(16);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'self'`
  );
  const target = JSON.stringify(returnTo);
  return new Response(
    `<!doctype html><meta charset="utf-8"><script nonce="${nonce}">try{window.top.location.replace(${target})}catch(e){window.location.replace(${target})}</script>`,
    { status: 200, headers }
  );
}

function silentNoop(clearState: string): Response {
  return new Response("<!doctype html><meta charset=\"utf-8\">", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": clearState
    }
  });
}

function clearAuthHeaders(clearState: string): Headers {
  const headers = new Headers();
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", sessionCookie("", 0));
  return headers;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftBytes[index % Math.max(leftBytes.byteLength, 1)] ?? 0) ^
      (rightBytes[index % Math.max(rightBytes.byteLength, 1)] ?? 0);
  }
  return difference === 0;
}
