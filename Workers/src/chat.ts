import { chatRuntimeEnv } from "./chat-policy";
// The vendored chat core is JavaScript, as in the upstream yume-chat project.
// @ts-expect-error JavaScript integration boundary; request/session authorization lives in typed adapters.
import chatApp from "../chat/worker/src/index.js";
import { fetchAsset, problem } from "./response";
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
  if (url.pathname.endsWith(".html")) return problem("Not found", 404);
  if (!identityRequestAllowed(request)) return problem("请求被拒绝", 403);
  const isApi = url.pathname.startsWith("/chat/api/") || url.pathname.startsWith("/chat/files/");
  const isAsset = /\.[a-z0-9]+$/i.test(url.pathname);
  const embeddedDocument = !isApi && !isAsset;
  // The public route is /#chat. Only its same-origin embedded application has a document endpoint.
  if (embeddedDocument && (url.pathname !== "/chat/" || url.searchParams.get("embedded") !== "1" || request.headers.get("Sec-Fetch-Dest") === "document"))
    return problem("Not found", 404);
  if (!isApi && !["GET", "HEAD"].includes(request.method))
    return problem("Method not allowed", 405);
  const account = await validateIdentitySession(
    env,
    identityCookieToken(request),
  );
  if (!account) {
    if (embeddedDocument) {
      // Report an expiry between the host's check and frame creation, without nesting the homepage.
      return new Response(request.method === "HEAD" ? null : '<!doctype html><html><head><meta charset="utf-8"></head><body data-chat-session-required><script src="/js/chat-frame-navigation.js"></script></body></html>', {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'",
          "X-Frame-Options": "SAMEORIGIN"
        }
      });
    }
    return problem("请先登录有效的身份识别码", 401, "identity_login_required");
  }
  if (
    url.pathname.startsWith("/chat/api/") ||
    url.pathname.startsWith("/chat/files/")
  ) {
    url.pathname = url.pathname.slice(5);
    return chatApp.fetch(new Request(url, request), await chatRuntimeEnv(env));
  }
  const assetPath = /\.[a-z0-9]+$/i.test(url.pathname)
    ? url.pathname
    : "/chat/index.html";
  const response = await fetchAsset(env, request, assetPath);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set(
    "Content-Security-Policy",
    `default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors ${embeddedDocument ? "'self'" : "'none'"}; base-uri 'self'; form-action 'self'; object-src 'none'`,
  );
  headers.set("X-Frame-Options", embeddedDocument ? "SAMEORIGIN" : "DENY");
  headers.set(
    "Permissions-Policy",
    "microphone=(self), camera=(), geolocation=(), payment=()",
  );
  return new Response(response.body, { status: response.status, headers });
}
