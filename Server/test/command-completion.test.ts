import { describe, expect, it } from "vitest";
import { completeCommand, reconcileTerminalRunCommands } from "../src/db";

describe("completeCommand", () => {
  it("atomically marks a cancelled run_task as interrupted", async () => {
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
          return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
        }
      }
    } as unknown as Env;

    const completed = await completeCommand(env, {
      commandId: "command-1",
      leaseToken: "lease-1",
      state: "cancelled",
      message: "任务已由管理员中断"
    });

    expect(completed).toBe(true);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("UPDATE command_queue");
    expect(statements[1]?.sql).toContain("UPDATE task_runs");
    expect(statements[1]?.sql).toContain("type = 'run_task'");
    expect(statements[1]?.sql).toContain("'cancelling'");
    expect(statements[1]?.values[0]).toBe("interrupted");
  });

  it("does not overwrite an existing terminal run state", async () => {
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
        async batch() {
          return [{ meta: { changes: 1 } }, { meta: { changes: 0 } }];
        }
      }
    } as unknown as Env;

    expect(
      await completeCommand(env, {
        commandId: "command-2",
        leaseToken: "lease-2",
        state: "completed",
        message: "任务完成"
      })
    ).toBe(true);
    expect(statements[1]?.sql).toContain(
      "state IN ('queued', 'claimed', 'running', 'cancelling')"
    );
    expect(statements[1]?.values[0]).toBe("succeeded");
  });
});

describe("reconcileTerminalRunCommands", () => {
  it("repairs historical cancelling runs without deleting their data", async () => {
    let statement: { sql: string; values: unknown[] } | undefined;
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              statement = { sql, values };
              return {
                async run() {
                  return { meta: { changes: 2 } };
                }
              };
            }
          };
        }
      }
    } as unknown as Env;

    expect(await reconcileTerminalRunCommands(env)).toBe(2);
    expect(statement?.sql).toContain("WHEN 'cancelled' THEN 'interrupted'");
    expect(statement?.sql).toContain("state IN ('queued', 'claimed', 'running', 'cancelling')");
    expect(statement?.sql).not.toContain("DELETE");
    expect(statement?.sql).not.toContain("INSERT");
  });
});
