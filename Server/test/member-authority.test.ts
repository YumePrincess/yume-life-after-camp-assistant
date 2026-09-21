import { describe, expect, it, vi } from "vitest";
import {
  calibrateMemberName,
  reconcileStaffAssignments,
  updateWeeklyActivitySnapshot,
  updateMemberDetails,
  updateMemberProfiles
} from "../src/db";

function createDatabaseRecorder() {
  const prepared: Array<{
    sql: string;
    args: unknown[];
    run: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
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
        run: vi.fn(async () => ({ success: true })),
        all: vi.fn(async () => ({ results: [] }))
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

describe("manual member details", () => {
  it("updates editable fields without changing the member identity or sync metadata", async () => {
    const prepared: Array<{ sql: string; args: unknown[] }> = [];
    const updatedMember = {
      id: "member_123",
      name: "玩家甲",
      profession: "采集",
      manor_level: 31,
      roommate_name: "玩家乙",
      camp_title: "新称号",
      weekly_contribution: 1234,
      technology_points_used: 5678,
      material_contribution: 9012,
      last_seen_at: "2026-09-21T06:00:00.000Z"
    };
    const db = {
      prepare(sql: string) {
        const statement = {
          sql,
          args: [] as unknown[],
          bind(...args: unknown[]) {
            statement.args = args;
            return statement;
          },
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
          first: vi.fn(async () => updatedMember)
        };
        prepared.push(statement);
        return statement;
      }
    };

    const result = await updateMemberDetails(
      { DB: db } as never,
      {
        id: "member_123",
        profession: "采集",
        manorLevel: 31,
        roommateName: "玩家乙",
        campTitle: "新称号",
      weeklyContribution: 1234,
      technologyPointsUsed: 5678,
      materialContribution: 9012,
      weeklyActivityPoints: 345
      }
    );

    expect(result).toEqual(updatedMember);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.sql).toContain("SET profession = ?, manor_level = ?");
    expect(prepared[0]?.sql).toContain("WHERE id = ?");
    expect(prepared[0]?.sql).not.toMatch(/(?:^|[\s,])name\s*=/);
    expect(prepared[0]?.args).toEqual([
      "采集",
      31,
      "玩家乙",
      "新称号",
      1234,
      5678,
      9012,
      345,
      "member_123"
    ]);
  });
});

describe("identity-code member-name calibration", () => {
  it("uses the active identity display name for decorative-symbol variants", () => {
    expect(
      calibrateMemberName("☆椿☆", [{ name: "✨椿✨" }])
    ).toBe("✨椿✨");
  });

  it("accepts one long-name OCR typo only when the best match is unique", () => {
    expect(
      calibrateMemberName("AlphaX", [{ name: "AlphaY" }, { name: "Bravo" }])
    ).toBe("AlphaY");
    expect(
      calibrateMemberName("AlphaX", [{ name: "AlphaY" }, { name: "AlphaZ" }])
    ).toBe("AlphaX");
  });

  it("does not fuzzy-match short names", () => {
    expect(
      calibrateMemberName("玩家甲一", [{ name: "玩家甲二" }])
    ).toBe("玩家甲一");
  });
});

describe("weekly activity snapshot", () => {
  it("resets every roster member before applying the recognized ranking rows", async () => {
    const recorder = createDatabaseRecorder();
    const masterStatement = recorder.prepared;
    const originalPrepare = recorder.db.prepare.bind(recorder.db);
    recorder.db.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("SELECT name FROM members")) {
        statement.all = vi.fn(async () => ({
          results: [{ name: "玩家甲" }, { name: "玩家乙" }, { name: "玩家丙" }]
        })) as never;
      }
      return statement;
    };

    const result = await updateWeeklyActivitySnapshot(
      { DB: recorder.db } as never,
      {
        runId: "weekly-activity-run",
        capturedAt: "2026-09-21T14:00:00.000Z",
        members: [{ name: "玩家甲", weeklyActivityPoints: 12 }]
      }
    );

    expect(result.updates).toEqual([
      { name: "玩家甲", weeklyActivityPoints: 12 }
    ]);
    expect(
      masterStatement.some((statement) =>
        statement.sql.includes("UPDATE members SET weekly_activity_points = 0")
      )
    ).toBe(true);
    expect(recorder.batches).toHaveLength(1);
    expect(recorder.batches[0]).toHaveLength(1);
  });

  it("resets the full roster when the game returns an empty ranking", async () => {
    const recorder = createDatabaseRecorder();
    const originalPrepare = recorder.db.prepare.bind(recorder.db);
    recorder.db.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("SELECT name FROM members")) {
        statement.all = vi.fn(async () => ({
          results: [{ name: "玩家甲" }, { name: "玩家乙" }]
        })) as never;
      }
      return statement;
    };

    const result = await updateWeeklyActivitySnapshot(
      { DB: recorder.db } as never,
      {
        runId: "weekly-activity-empty-run",
        capturedAt: "2026-09-21T14:00:00.000Z",
        members: []
      }
    );

    expect(result).toEqual({ updates: [], ignored: 0, ambiguous: 0 });
    expect(
      recorder.prepared.some((statement) =>
        statement.sql.includes("UPDATE members SET weekly_activity_points = 0")
      )
    ).toBe(true);
    expect(recorder.batches).toHaveLength(0);
  });

  it("resets the full roster even when every recognized row is unmatched", async () => {
    const recorder = createDatabaseRecorder();
    const originalPrepare = recorder.db.prepare.bind(recorder.db);
    recorder.db.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("SELECT name FROM members")) {
        statement.all = vi.fn(async () => ({
          results: [{ name: "玩家甲" }, { name: "玩家乙" }]
        })) as never;
      }
      return statement;
    };

    const result = await updateWeeklyActivitySnapshot(
      { DB: recorder.db } as never,
      {
        runId: "weekly-activity-unmatched-run",
        capturedAt: "2026-09-21T14:00:00.000Z",
        members: [{ name: "无法匹配的 OCR 名称", weeklyActivityPoints: 99 }]
      }
    );

    expect(result).toEqual({ updates: [], ignored: 1, ambiguous: 0 });
    expect(
      recorder.prepared.some((statement) =>
        statement.sql.includes("UPDATE members SET weekly_activity_points = 0")
      )
    ).toBe(true);
    expect(recorder.batches).toHaveLength(0);
  });
});
