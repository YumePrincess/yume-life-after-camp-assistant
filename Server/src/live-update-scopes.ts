import type { LiveUpdateScope } from "./live-updates";

const PUBLIC_DATA_MUTATIONS = new Set([
  "/api/public/tech-vote",
  "/api/public/daily-vote",
  "/api/public/vote-eligibility-applications",
  "/api/public/identity-profile",
  "/api/public/identity-cancellation",
  "/api/public/identity-code-applications",
  "/api/public/identity-code-renewal",
  "/api/public/identity-code-reissue"
]);

const AGENT_DATA_MUTATIONS = new Set([
  "/api/agent/run-update",
  "/api/agent/snapshot",
  "/api/agent/complete-command"
]);

export function liveUpdateScopes(
  request: Request,
  response: Response
): LiveUpdateScope[] {
  if (response.status < 200 || response.status >= 300) return [];
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return [];

  if (method === "POST" && PUBLIC_DATA_MUTATIONS.has(pathname)) {
    return ["public", "admin"];
  }

  if (pathname.startsWith("/api/admin/")) {
    // Sending a test message has no shared application state to refresh.
    if (pathname === "/api/admin/smtp-config/test") return [];
    return ["public", "admin"];
  }

  if (pathname === "/api/agent/register") return ["admin"];
  if (AGENT_DATA_MUTATIONS.has(pathname)) return ["public", "admin"];

  // In particular, identity-login, vote-participation, vote-participants,
  // agent heartbeat, bootstrap, and next-command are reads despite using POST.
  return [];
}
