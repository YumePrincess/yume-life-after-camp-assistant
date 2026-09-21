import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWeeklyRows } from "../src/workflows/weekly-activity.mjs";

test("weekly activity reuses profile name handling for decorated and symbol-only names", () => {
  assert.deepEqual(
    normalizeWeeklyRows([
      { rank: "1", name: "✨椿✨", weeklyActivityPoints: "6" },
      { rank: "2", name: "-😊-", weeklyActivityPoints: "4" },
      { rank: "3", name: "2025", weeklyActivityPoints: "2" },
      { rank: "4", name: "启航", weeklyActivityPoints: "1" }
    ]),
    [
      { rank: 1, name: "✨椿✨", weeklyActivityPoints: 6 },
      { rank: 2, name: "-😊-", weeklyActivityPoints: 4 }
    ]
  );
});

test("weekly activity rejects a profession-only OCR leak through profile normalization", () => {
  assert.deepEqual(
    normalizeWeeklyRows([
      {
        rank: "1",
        name: "伐木专家",
        profession: "伐木专家",
        weeklyActivityPoints: "8"
      }
    ]),
    []
  );
});

test("weekly activity collapses duplicate OCR name tokens without dropping ranks", () => {
  assert.deepEqual(
    normalizeWeeklyRows([
      { rank: 13, name: "软萌奶猫酱 软萌奶猫酱", weeklyActivityPoints: 4 },
      { rank: 14, name: "昵称未被占用\u200b昵称未被占用", weeklyActivityPoints: 4 }
    ]),
    [
      { rank: 13, name: "软萌奶猫酱", weeklyActivityPoints: 4 },
      { rank: 14, name: "昵称未被占用", weeklyActivityPoints: 4 }
    ]
  );
});

test("weekly activity never treats a visible rank number as a member name", () => {
  assert.deepEqual(
    normalizeWeeklyRows([
      { rank: 5, name: "5", weeklyActivityPoints: 6 },
      { rank: 6, name: "蛮蛮空心菜", weeklyActivityPoints: 6 }
    ]),
    [{ rank: 6, name: "蛮蛮空心菜", weeklyActivityPoints: 6 }]
  );
});
