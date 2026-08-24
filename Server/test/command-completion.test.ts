import { describe, expect, it } from "vitest";
import {
  completeCommand,
  finalizeAgentCancellations,
  mergeRunDetail,
  reconcileStaleCommands,
  reconcileTerminalRunCommands,
  scheduledRetryAttempt,
  updateRun
} from "../src/db";

describe("scheduled retry accounting", () => {
  it("keeps the retry policy when an Agent sends a partial run detail update", () => {
    expect(
      JSON.parse(
        mergeRunDetail(
          JSON.stringify({ scheduledRetryLimit: 2, patrolDeadlineAt: "deadline" }),
          { locale: "zh-cn", currentStep: "starting" }
        )
      )
    ).toMatchObject({
      scheduledRetryLimit: 2,
      patrolDeadlineAt: "deadline",
      locale: "zh-cn",
      currentStep: "starting"
    });
  });

  it("trusts the persisted retry suffix when a run detail was reset by an older agent", () => {
    expect(
      scheduledRetryAttempt(
        { scheduledRetryAttempt: 0 },
        "patrol:2026-08-10:retry:1"
      )
    ).toBe(1);
    expect(
      scheduledRetryAttempt(
        { scheduledRetryAttempt: 1 },
        "patrol:2026-08-10:retry:1:retry:2"
      )
    ).toBe(2);
  });
});

describe("completeCommand", () => {
  it("does not schedule a retry after patrol terminal cleanup failure", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const command = {
      id: "command-patrol",
      run_id: "run-patrol",
      agent_id: "agent-1",
      type: "run_task",
      trigger_mode: "scheduled",
      payload_json: "{}"
    };
    const completedRun = {
      id: "run-patrol",
      task_key: "patrol",
      trigger_mode: "scheduled",
      schedule_key: "patrol:2026-08-04",
      local_date: "2026-08-04",
      detail_json: JSON.stringify({
        scheduledRetryLimit: 4,
        scheduledRetryAttempt: 0,
        suppressScheduledRetry: true,
        retrySuppressionReason: "patrol_deadline_cleanup"
      })
    };
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            first: async () => null,
            bind(...values: unknown[]) {
              const statement = { sql, values };
              statements.push(statement);
              return {
                async first() {
                  if (sql.includes("FROM command_queue")) return command;
                  if (sql.includes("FROM task_runs")) return completedRun;
                  return null;
                },
                async run() {
                  return { meta: { changes: 1 } };
                }
              };
            }
          };
        },
        async batch() {
          return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
        }
      }
    } as unknown as Env;

    expect(
      await completeCommand(env, {
        commandId: command.id,
        leaseToken: "lease-patrol",
        state: "failed",
        message: "PATROL_CLOSE_TEAM_PANEL_DID_NOT_CLOSE"
      })
    ).toBe(true);
    assertNoScheduledRetryInsert(statements);
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO task_events"))).toBe(true);
  });

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

  it("keeps a cancellation authoritative when a late run command reports failure", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const command = {
      id: "command-late",
      run_id: "run-cancelled",
      agent_id: "agent-1",
      type: "run_task"
    };
    const run = {
      id: "run-cancelled",
      cancel_requested: 1,
      trigger_mode: "manual",
      detail_json: "{}"
    };
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            async first() {
              return null;
            },
            bind(...values: unknown[]) {
              statements.push({ sql, values });
              return {
                async first() {
                  if (sql.includes("FROM command_queue")) return command;
                  if (sql.includes("FROM task_runs")) return run;
                  return null;
                }
              };
            }
          };
        },
        async batch() {
          return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
        }
      }
    } as unknown as Env;

    await expect(
      completeCommand(env, {
        commandId: command.id,
        leaseToken: "lease-late",
        state: "failed",
        message: "网络错误"
      })
    ).resolves.toBe(true);
    expect(statements[3]?.values[0]).toBe("interrupted");
    expect(statements[3]?.values[1]).toBe("任务已由管理员中断");
  });
});

function assertNoScheduledRetryInsert(
  statements: Array<{ sql: string; values: unknown[] }>
) {
  expect(
    statements.some(({ sql }) => sql.includes("INSERT INTO task_runs"))
  ).toBe(false);
  expect(
    statements.some(({ sql }) => sql.includes("INSERT INTO command_queue"))
  ).toBe(false);
}

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

describe("ghost-command and cancellation recovery", () => {
  it("cancels commands whose task row was manually removed or already finished", async () => {
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

    expect(await reconcileStaleCommands(env, new Date("2026-08-24T18:00:00.000Z"))).toBe(2);
    expect(statement?.sql).toContain("run_id IS NULL");
    expect(statement?.sql).toContain("关联任务已不存在或已结束");
    expect(statement?.sql).toContain("lease_expires_at = NULL");
  });

  it("finalizes a cancelling run when a restarted Agent reports no active run", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              const statement = { sql, values };
              statements.push(statement);
              return {
                async all() {
                  return sql.includes("SELECT task_runs.id")
                    ? { results: [{ id: "run-cancelling" }] }
                    : { results: [] };
                }
              };
            }
          };
        },
        async batch() {
          return [
            { meta: { changes: 2 } },
            { results: [{ id: "run-cancelling" }] }
          ];
        }
      }
    } as unknown as Env;

    await expect(
      finalizeAgentCancellations(env, {
        agentId: "mac-agent",
        activeRunId: null,
        now: new Date("2026-08-24T18:00:00.000Z")
      })
    ).resolves.toEqual(["run-cancelling"]);
    expect(statements.some(({ sql }) => sql.includes("state = 'interrupted'"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("state IN ('queued', 'claimed')"))).toBe(true);
  });

  it("does not let a late Agent update a terminal run", async () => {
    const terminalRun = {
      id: "run-terminal",
      state: "interrupted",
      cancel_requested: 1,
      message: "任务已由管理员中断"
    };
    let updateIssued = false;
    const env = {
      DB: {
        prepare(sql: string) {
          if (sql.startsWith("SELECT * FROM task_runs")) {
            return {
              bind() {
                return { async first() { return terminalRun; } };
              }
            };
          }
          updateIssued = true;
          return {
            bind() {
              return { async first() { return terminalRun; } };
            }
          };
        }
      }
    } as unknown as Env;

    await expect(
      updateRun(env, {
        runId: "run-terminal",
        state: "succeeded",
        message: "旧 Agent 晚到的成功结果"
      })
    ).resolves.toEqual(terminalRun);
    expect(updateIssued).toBe(false);
  });
});
