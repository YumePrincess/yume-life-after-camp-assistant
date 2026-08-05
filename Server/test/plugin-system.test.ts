import { describe, expect, it } from "vitest";
import {
  builtPermissionCatalog,
  builtPluginForTask,
  effectiveWorkerPlugins,
  enabledPermissionCatalog,
  enabledPluginForTask,
  registeredWorkerPlugins
} from "../src/plugin-system";

function envWithStates(states: Record<string, boolean>): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(key: string) {
            return {
              async first() {
                if (sql.includes("FROM settings") && key === "worker_plugin_states") {
                  return { value: JSON.stringify(states) };
                }
                return null;
              }
            };
          }
        };
      }
    }
  } as unknown as Env;
}

describe("build-time Worker plugins", () => {
  it("registers the same five versioned task plugins shipped by the Mac app", () => {
    const plugins = registeredWorkerPlugins();
    expect(plugins).toHaveLength(5);
    expect(plugins.map((plugin) => plugin.manifest.id).sort()).toEqual([
      "contribution",
      "inactivity",
      "member-profile",
      "patrol",
      "technology"
    ]);
    expect(plugins.every((plugin) => plugin.manifest.version === "27.0.0")).toBe(true);
    expect(plugins.every((plugin) => plugin.manifest.build === 27045)).toBe(true);
  });

  it("removes disabled plugin tasks and permissions from the effective registry", async () => {
    const env = envWithStates({ technology: false });
    const plugins = await effectiveWorkerPlugins(env);
    expect(plugins.find((plugin) => plugin.id === "technology")?.enabled).toBe(false);
    expect(await enabledPluginForTask(env, "tech_switch")).toBeNull();
    expect((await enabledPermissionCatalog(env)).map((item) => item.key)).not.toContain(
      "admin:technology"
    );
  });

  it("keeps core permissions independent from plugin files", () => {
    expect(builtPluginForTask("patrol")?.id).toBe("patrol");
    expect(builtPermissionCatalog().map((item) => item.key)).toContain("admin:smtp");
    expect(builtPermissionCatalog().map((item) => item.key)).toContain("admin:access");
  });
});
