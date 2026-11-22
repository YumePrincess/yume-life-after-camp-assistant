import { describe, expect, it } from "vitest";
import {
  activateAgentIdentity,
  deleteAgentHeartbeat,
  touchHeartbeat
} from "../src/db";
import type { ConfigBundle } from "../src/domain";

describe("activateAgentIdentity", () => {
  it("atomically routes queued commands without deleting other devices", async () => {
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
          expect(batch).toHaveLength(2);
          return [];
        }
      }
    } as unknown as Env;
    const bundle = {
      campConfig: { agentId: "mumu-main" }
    } as ConfigBundle;

    const registered = await activateAgentIdentity(
      env,
      bundle,
      "mac-life-after-agent"
    );

    expect(registered.campConfig.agentId).toBe("mac-life-after-agent");
    expect(statements[1]).toMatchObject({
      values: ["mac-life-after-agent", "mac-life-after-agent"]
    });
    expect(statements[1]?.sql).toContain("state = 'queued'");
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) =>
      !statement.sql.includes("DELETE FROM agent_heartbeats")
    )).toBe(true);
  });

  it("upserts the editable device name and only auto-enables an empty deployment", async () => {
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
          expect(batch).toHaveLength(2);
          return [];
        }
      }
    } as unknown as Env;

    await touchHeartbeat(env, {
      agentId: "mac-device-1",
      displayName: "Mac Studio 工作室",
      activeRunId: null,
      activeTaskKey: null,
      status: "idle",
      capabilities: { visionOcr: true },
      detail: { emulatorName: "Life After CN Auto" }
    });

    expect(statements[0]?.sql).toContain("display_name");
    expect(statements[0]?.sql).toContain("ON CONFLICT(agent_id)");
    expect(statements[0]?.sql).toContain(
      "agent_heartbeats.display_name = agent_heartbeats.agent_id"
    );
    expect(statements[0]?.values.slice(0, 2)).toEqual([
      "mac-device-1",
      "Mac Studio 工作室"
    ]);
    expect(statements[1]?.sql).toContain(
      "COALESCE(json_extract(value, '$.agentId'), '') = ''"
    );
  });

  it("deletes only a non-active heartbeat so an online device can re-register", async () => {
    let statement: { sql: string; values: unknown[] } | undefined;
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              statement = { sql, values };
              return {
                async run() {
                  return { meta: { changes: 1 } };
                }
              };
            }
          };
        }
      }
    } as unknown as Env;

    expect(await deleteAgentHeartbeat(env, "standby", "active")).toBe(true);
    expect(statement?.sql).toContain("agent_id <> ?");
    expect(statement?.values).toEqual(["standby", "active"]);
  });
});
