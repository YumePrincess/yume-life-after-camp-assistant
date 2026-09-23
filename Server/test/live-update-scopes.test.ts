import { describe, expect, it } from "vitest";
import { liveUpdateScopes } from "../src/live-update-scopes";

function request(path: string, method = "POST"): Request {
  return new Request(`https://example.test${path}`, { method });
}

function response(status = 200): Response {
  return new Response(null, { status });
}

describe("live update scopes", () => {
  it("does not rebroadcast read-only POST endpoints", () => {
    for (const path of [
      "/api/public/identity-login",
      "/api/public/vote-participation",
      "/api/public/vote-participants",
      "/api/agent/heartbeat",
      "/api/agent/bootstrap",
      "/api/agent/next-command"
    ]) {
      expect(liveUpdateScopes(request(path), response())).toEqual([]);
    }
  });

  it("broadcasts successful public vote and profile mutations", () => {
    for (const path of [
      "/api/public/tech-vote",
      "/api/public/daily-vote",
      "/api/public/identity-profile"
    ]) {
      expect(liveUpdateScopes(request(path), response())).toEqual(["public", "admin"]);
    }
  });

  it("only notifies admins about agent registration and excludes command polling", () => {
    expect(liveUpdateScopes(request("/api/agent/register"), response())).toEqual(["admin"]);
    expect(liveUpdateScopes(request("/api/agent/run-update"), response())).toEqual(["public", "admin"]);
  });

  it("does not broadcast failed mutations or safe requests", () => {
    expect(liveUpdateScopes(request("/api/public/tech-vote"), response(409))).toEqual([]);
    expect(liveUpdateScopes(request("/api/admin/config", "GET"), response())).toEqual([]);
    expect(liveUpdateScopes(request("/api/admin/smtp-config/test"), response())).toEqual([]);
  });
});
