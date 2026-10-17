import { chatRuntimeEnv } from "./chat-policy";
// The vendored chat core is JavaScript, as in the upstream yume-chat project.
// @ts-expect-error JavaScript integration boundary; request/session authorization lives in typed adapters.
import chatApp from "../chat/worker/src/index.js";
import { fetchAsset, problem, redirect } from "./response";
import {
  identityCookieToken,
  identityRequestAllowed,
  validateIdentitySession,
} from "./identity-session";
export async function handleChat(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/chat/admin" || url.pathname.startsWith("/chat/admin/"))
    return problem("Not found", 404);
  if (!identityRequestAllowed(request)) return problem("请求被拒绝", 403);
  const account = await validateIdentitySession(
    env,
    identityCookieToken(request),
  );
  if (!account) {
    return url.pathname.startsWith("/chat/api/") ||
      url.pathname.startsWith("/chat/files/")
      ? problem("请先登录有效的身份识别码", 401, "identity_login_required")
      : redirect("/?identityLoginRequired=1#identity");
  }
  if (url.pathname === "/chat") return redirect("/chat/");
  if (
    url.pathname.startsWith("/chat/api/") ||
    url.pathname.startsWith("/chat/files/")
  ) {
    url.pathname = url.pathname.slice(5);
    return chatApp.fetch(new Request(url, request), await chatRuntimeEnv(env));
  }
  if (!["GET", "HEAD"].includes(request.method))
    return problem("Method not allowed", 405);
  const assetPath = /\.[a-z0-9]+$/i.test(url.pathname)
    ? url.pathname
    : "/chat/index.html";
  const response = await fetchAsset(env, request, assetPath);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  headers.set(
    "Permissions-Policy",
    "microphone=(self), camera=(), geolocation=(), payment=()",
  );
  return new Response(response.body, { status: response.status, headers });
}
