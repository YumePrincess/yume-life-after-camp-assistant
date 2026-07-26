const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://account.yume.zone",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

export function withSecurityHeaders(response: Response): Response {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!next.headers.has(key)) next.headers.set(key, value);
  }
  return next;
}

export function json(
  payload: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

export function problem(message: string, status = 400, code = "bad_request"): Response {
  return json({ error: message, code }, status);
}

export function redirect(location: string, headers: HeadersInit = {}): Response {
  const result = new Headers(headers);
  result.set("Location", location);
  return new Response(null, { status: 302, headers: result });
}

export function methodNotAllowed(allowed: string[]): Response {
  const response = problem("Method not allowed", 405, "method_not_allowed");
  response.headers.set("Allow", allowed.join(", "));
  return response;
}

export async function fetchAsset(env: Env, request: Request, pathname: string): Promise<Response> {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  assetUrl.search = "";
  return env.ASSETS.fetch(new Request(assetUrl, { method: "GET", headers: request.headers }));
}

export function publicCors(request: Request): Headers {
  const origin = request.headers.get("Origin");
  const headers = new Headers();
  if (!origin || origin === new URL(request.url).origin) {
    if (origin) headers.set("Access-Control-Allow-Origin", origin);
  }
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}
