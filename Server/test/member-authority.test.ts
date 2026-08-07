import { describe, expect, it, vi } from "vitest";
import {
  reconcileStaffAssignments,
  updateMemberProfiles
} from "../src/db";

function createDatabaseRecorder() {
  const prepared: Array<{
    sql: string;
    args: unknown[];
    run: ReturnType<typeof vi.fn>;
  }> = [];
  const batches: unknown[][] = [];

  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        run: vi.fn(async () => ({ success: true }))
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements: unknown[]) {
      batches.push(statements);
      return [];
    }
  };

  return { db, prepared, batches };
}

describe("authoritative member profile snapshot", () => {
  it("removes members absent from the next successful profile scan", async () => {
    const recorder = createDatabaseRecorder();

    await updateMemberProfiles(
      { DB: recorder.db } as never,
      {
        runId: "profile-run-latest",
        capturedAt: "2026-07-30T06:00:00.000Z",
        members: [
          {
            name: "仍在营地",
            profession: "采集",
            manorLevel: 30,
            roommateName: null,
            campTitle: null,
            weeklyContribution: 1234
          }
        ]
      }
    );

    expect(recorder.batches).toHaveLength(1);
    expect(recorder.batches[0]).toHaveLength(1);
    const upsert = recorder.prepared.find((statement) =>
      statement.sql.includes("INSERT INTO members")
    );
    expect(upsert?.sql).toContain("ON CONFLICT(id) DO UPDATE SET");
    expect(upsert?.sql).not.toContain("ON CONFLICT(name)");
    expect(upsert?.sql).not.toContain(
      "weekly_contribution = excluded.weekly_contribution"
    );
    const cleanup = recorder.prepared.find((statement) =>
      statement.sql.includes("DELETE FROM members WHERE source_run_id")
    );
    expect(cleanup).toBeDefined();
    expect(cleanup?.args).toEqual(["profile-run-latest"]);
    expect(cleanup?.run).toHaveBeenCalledOnce();
    const authoritativeSnapshot = recorder.prepared.find((statement) =>
      statement.sql.includes("INSERT INTO settings")
    );
    expect(authoritativeSnapshot?.args[0]).toBe("member_profile_snapshot");
    expect(JSON.parse(String(authoritativeSnapshot?.args[1]))).toHaveLength(1);
  });

  it("does not erase the roster when a profile scan has no usable rows", async () => {
    const recorder = createDatabaseRecorder();

    await updateMemberProfiles(
      { DB: recorder.db } as never,
      {
        runId: "empty-profile-run",
        capturedAt: "2026-07-30T06:00:00.000Z",
        members: []
      }
    );

    expect(recorder.batches).toHaveLength(0);
    expect(
      recorder.prepared.some((statement) =>
        statement.sql.includes("DELETE FROM members WHERE source_run_id")
      )
    ).toBe(false);
  });
});

describe("staff assignments", () => {
  it("self-deduplicates roles and players without consulting the member roster", () => {
    const result = reconcileStaffAssignments([
        { roleKey: "mayor", roleName: "市长", memberName: "雨梦" },
        { roleKey: "mayor-copy", roleName: "市长", memberName: "雨梦" },
        { roleKey: "staff-1", roleName: "#W月之歌", memberName: "萤萤空心菜" },
        { roleKey: "staff-2", roleName: "#W圣之雪", memberName: "七晓白" },
        { roleKey: "staff-3", roleName: "#P营地助手", memberName: "七晓白✨" },
        { roleKey: "staff-4", roleName: "#G春之音", memberName: "不在营地的人" }
      ]);

    expect(result.staff).toEqual([
      { roleKey: "mayor", roleName: "市长", memberName: "雨梦" },
      { roleKey: "staff-1", roleName: "#W月之歌", memberName: "萤萤空心菜" },
      { roleKey: "staff-2", roleName: "#W圣之雪", memberName: "七晓白" },
      { roleKey: "staff-4", roleName: "#G春之音", memberName: "不在营地的人" }
    ]);
    expect(result.ignored).toBe(2);
  });
});
