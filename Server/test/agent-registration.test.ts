import { describe, expect, it } from "vitest";
import { registerAgentIdentity } from "../src/db";
import type { ConfigBundle } from "../src/domain";

describe("registerAgentIdentity", () => {
  it("atomically makes the configured Agent canonical and retires stale heartbeats", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              const statement = { sql, values };
              statements.push(statement);
              return statement;
            }
          };
        },
        async batch(batch: unknown[]) {
          expect(batch).toHaveLength(3);
          return [];
        }
      }
    } as unknown as Env;
    const bundle = {
      campConfig: { agentId: "mumu-main" }
    } as ConfigBundle;

    const registered = await registerAgentIdentity(
      env,
      bundle,
      "mac-life-after-agent"
    );

    expect(registered.campConfig.agentId).toBe("mac-life-after-agent");
    expect(statements[1]).toMatchObject({
      values: ["mac-life-after-agent", "mac-life-after-agent"]
    });
    expect(statements[1]?.sql).toContain("state = 'queued'");
    expect(statements[2]).toMatchObject({ values: ["mac-life-after-agent"] });
    expect(statements[2]?.sql).toContain("DELETE FROM agent_heartbeats");
  });
});
