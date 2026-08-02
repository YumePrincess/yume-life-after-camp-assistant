import { describe, expect, it } from "vitest";
import {
  canViewAdminModule,
  hasPermission,
  sessionPermissions
} from "../src/auth";
import type { SessionRow } from "../src/db";

function session(
  authMethod: SessionRow["auth_method"],
  permissions: string[]
): SessionRow {
  return {
    id: "session",
    csrf_token: "csrf",
    email: "admin@example.com",
    display_name: "Admin",
    auth_method: authMethod,
    permissions_json: JSON.stringify(permissions),
    oidc_id_token: null,
    oidc_last_checked_at: null,
    temp_key_id: authMethod === "temporary_key" ? "key" : null,
    created_at: "2026-07-30T00:00:00.000Z",
    expires_at: "2026-07-31T00:00:00.000Z",
    last_checked_at: "2026-07-30T00:00:00.000Z"
  };
}

describe("admin permissions", () => {
  it("always gives OIDC sessions full administrator permission", () => {
    const oidc = session("oidc", []);

    expect(sessionPermissions(oidc)).toEqual(["*"]);
    expect(hasPermission(oidc, "keys:manage")).toBe(true);
    expect(hasPermission(oidc, "admin:technology")).toBe(true);
  });

  it("allows Demo to view every module but not perform actions", () => {
    const demo = session("temporary_key", ["demo:preview"]);

    expect(canViewAdminModule(demo, "admin:members")).toBe(true);
    expect(canViewAdminModule(demo, "admin:smtp")).toBe(true);
    expect(hasPermission(demo, "admin:members")).toBe(false);
    expect(hasPermission(demo, "smtp:manage")).toBe(false);
  });

  it("maps a module permission to the operations within that module", () => {
    const access = session("temporary_key", ["admin:access"]);
    const overview = session("temporary_key", ["admin:overview"]);

    expect(hasPermission(access, "keys:manage")).toBe(true);
    expect(hasPermission(access, "admin:members")).toBe(false);
    expect(hasPermission(overview, "task:run")).toBe(true);
    expect(hasPermission(overview, "task:interrupt")).toBe(false);
  });

  it("keeps previously issued legacy permissions usable", () => {
    const legacy = session("temporary_key", ["identity:review"]);

    expect(hasPermission(legacy, "admin:identity-review")).toBe(true);
    expect(hasPermission(legacy, "identity:review")).toBe(true);
  });
});
