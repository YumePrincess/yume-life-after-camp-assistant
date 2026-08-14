import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeActivity,
  normalizeContribution,
  normalizeMembers,
  normalizeProfiles,
  parseTable
} from "../src/table-parser.mjs";

test("member, contribution and activity tasks share text-first name normalization", () => {
  assert.equal(
    normalizeProfiles([{ name: "&/¥Alice“”！", profession: "步枪兵" }])[0].name,
    "Alice"
  );
  assert.equal(
    normalizeContribution([{ name: "Élodie♠", weeklyContribution: "7" }])[0].name,
    "Élodie"
  );
  assert.equal(
    normalizeActivity([{ name: "青在✨", onlineState: "在线" }])[0].name,
    "青在"
  );
});

test("member row slots merge stacked badges without creating a sixth member", () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0, right: 0.318, stackedKeys: ["name", "campTitle"] },
      { key: "profession", left: 0.318, right: 0.46 }
    ],
    pagination: { rowHeightPx: 95 }
  };
  const observations = [
    { text: "模型5号", x: 250, y: 300, width: 120, height: 36 },
    { text: "启航", x: 250, y: 340, width: 80, height: 28 },
    { text: "伐木专家", x: 700, y: 325, width: 120, height: 30 },
    { text: "欲斩", x: 250, y: 395, width: 80, height: 36 },
    { text: "启航", x: 250, y: 435, width: 80, height: 28 },
    { text: "伐木专家", x: 700, y: 420, width: 120, height: 30 }
  ];
  assert.deepEqual(
    parseTable(observations, definition).map(({ name, campTitle }) => ({ name, campTitle })),
    [
      { name: "模型5号", campTitle: "启航" },
      { name: "欲斩", campTitle: "启航" }
    ]
  );
});

test("tail member crop skips the half-visible previous row", () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 810 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0, right: 0.318, stackedKeys: ["name"] },
      { key: "profession", left: 0.318, right: 0.46 }
    ],
    pagination: {
      rowHeightPx: 95,
      skipLeadingPartialRows: true
    }
  };
  const observations = [
    { text: "上一页成员", x: 250, y: 275, width: 140, height: 30 },
    { text: "成员一", x: 250, y: 320, width: 100, height: 36 },
    { text: "步枪兵王", x: 700, y: 320, width: 120, height: 30 },
    { text: "成员二", x: 250, y: 415, width: 100, height: 36 },
    { text: "伐木专家", x: 700, y: 415, width: 120, height: 30 }
  ];
  assert.deepEqual(
    parseTable(observations, definition).map(({ name }) => name),
    ["成员一", "成员二"]
  );
});

test("member identity column excludes text rendered inside the avatar", () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318, stackedKeys: ["name", "campTitle"] },
      { key: "profession", left: 0.318, right: 0.46 }
    ],
    pagination: { rowHeightPx: 95 }
  };
  const observations = [
    { text: "2025", x: 145, y: 315, width: 75, height: 32 },
    { text: "雨梦", x: 275, y: 315, width: 70, height: 36 },
    { text: "特级厨师", x: 700, y: 315, width: 130, height: 30 },
    { text: "20251", x: 145, y: 410, width: 75, height: 32 },
    { text: "青在", x: 275, y: 410, width: 70, height: 36 },
    { text: "步枪兵王", x: 700, y: 410, width: 130, height: 30 }
  ];

  assert.deepEqual(
    parseTable(observations, definition).map(({ name }) => name),
    ["雨梦", "青在"]
  );
});

test("similar member names are never fuzzy-merged", () => {
  const rows = normalizeMembers(
    [
      { name: "星河踏月归", materialContribution: 101 },
      { name: "星河踏月归✨", materialContribution: 202 }
    ],
    [
      { name: "星河踏月归", profession: "步枪兵王" },
      { name: "星河踏月归✨", profession: "武道大师" }
    ]
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map(({ name, profession, materialContribution }) => ({
      name,
      profession,
      materialContribution
    })),
    [
      {
        name: "星河踏月归",
        profession: "步枪兵王",
        materialContribution: 101
      },
      {
        name: "星河踏月归✨",
        profession: "武道大师",
        materialContribution: 202
      }
    ]
  );
});

test("member profiles preserve the profile page's own weekly contribution field", () => {
  assert.deepEqual(
    normalizeProfiles([
      {
        name: "愿",
        profession: "步枪兵",
        weeklyContribution: "17,892,175"
      }
    ]),
    [
      {
        name: "愿",
        profession: "步枪兵",
        manorLevel: null,
        roommateName: null,
        campTitle: null,
        weeklyContribution: 17892175
      }
    ]
  );
});

test("member profile titles discard symbol-only OCR fallback output", () => {
  assert.equal(
    normalizeProfiles([
      { name: "玩家甲", campTitle: "☻ 〛 ☻" },
      { name: "玩家乙", campTitle: "#G春之音" },
      { name: "玩家丙", campTitle: "启航" }
    ]).map(({ campTitle }) => campTitle).join("|"),
    "|春之音|启航"
  );
});

test("member profile normalization preserves the reconciled roster count", () => {
  assert.deepEqual(
    normalizeProfiles([
      { name: "成员资料" },
      { name: "✨" },
      { name: "玩家甲" }
    ]).map(({ name }) => name),
    ["成员资料", "✨", "玩家甲"]
  );
});
