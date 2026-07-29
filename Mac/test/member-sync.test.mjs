import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcilePageRows,
  selectActivityWarningRows
} from "../src/workflows/member-sync.mjs";

test("page overlap reconciles only the same positional member", () => {
  const previous = [
    { name: "甲" },
    { name: "乙" },
    { name: "星河踏月归✨", roommateName: "踏月追星河" },
    { name: "相似名字" },
    { name: "锚点一" },
    { name: "锚点二" }
  ];
  const current = [
    { name: "星河踏月归", roommateName: "踏月追星河" },
    { name: "相似名字" },
    { name: "锚点一" },
    { name: "锚点二" },
    { name: "相似名字二" },
    { name: "新成员" }
  ];

  assert.deepEqual(
    reconcilePageRows(previous, current).map((row) => row.name),
    [
      "星河踏月归✨",
      "相似名字",
      "锚点一",
      "锚点二",
      "相似名字二",
      "新成员"
    ]
  );
});

test("similar names are untouched without three exact overlap anchors", () => {
  const previous = [{ name: "角色A" }, { name: "角色B" }, { name: "角色C" }];
  const current = [{ name: "角色Ａ" }, { name: "角色D" }, { name: "角色E" }];

  assert.deepEqual(reconcilePageRows(previous, current), current);
});

test("page alignment prefers the denser exact overlap", () => {
  const previous = [
    { name: "甲" },
    { name: "乙" },
    { name: "锚点一" },
    { name: "锚点二" },
    { name: "锚点三" },
    { name: "尾部", roommateName: "同居对象" }
  ];
  const current = [
    { name: "锚点一" },
    { name: "锚点二" },
    { name: "锚点三" },
    { name: "尾部变体", roommateName: "同居对象" },
    { name: "新成员一" },
    { name: "新成员二" }
  ];

  assert.deepEqual(
    reconcilePageRows(previous, current).map((row) => row.name),
    [
      "锚点一",
      "锚点二",
      "锚点三",
      "尾部",
      "新成员一",
      "新成员二"
    ]
  );
});

test("two anchors cannot merge a different member", () => {
  const previous = [
    { name: "锚点一" },
    { name: "锚点二" },
    { name: "相似姓名甲", profession: "步枪兵王", manorLevel: "30" }
  ];
  const current = [
    { name: "锚点一" },
    { name: "锚点二" },
    { name: "相似姓名乙", profession: "步枪兵王", manorLevel: "30" }
  ];

  assert.equal(reconcilePageRows(previous, current)[2].name, "相似姓名乙");
});

test("shared camp titles never merge distinct members", () => {
  const previous = [
    { name: "前一人" },
    { name: "锚点一" },
    { name: "锚点二" },
    { name: "相似姓名甲", campTitle: "#G春之音" }
  ];
  const current = [
    { name: "锚点一" },
    { name: "锚点二" },
    { name: "相似姓名乙", campTitle: "#G春之音" },
    { name: "新成员" }
  ];

  assert.equal(reconcilePageRows(previous, current)[2].name, "相似姓名乙");
});

test("a boundary OCR variant is reconciled only by the same non-empty roommate", () => {
  const previous = [
    { name: "成员一" },
    { name: "成员二" },
    { name: "纸鸢（装饰符A）", roommateName: "啾棠儿" }
  ];
  const current = [
    { name: "纸鸢（装饰符B）", roommateName: "啾棠儿" },
    { name: "新成员一" },
    { name: "新成员二" }
  ];

  assert.equal(
    reconcilePageRows(previous, current)[0].name,
    "纸鸢（装饰符A）"
  );
});

test("a boundary member without a roommate is never merged by similar fields", () => {
  const previous = [
    { name: "成员一" },
    { name: "成员二" },
    { name: "相似姓名甲", profession: "特级步枪兵王", manorLevel: "30" }
  ];
  const current = [
    { name: "相似姓名乙", profession: "特级步枪兵王", manorLevel: "30" },
    { name: "新成员一" },
    { name: "新成员二" }
  ];

  assert.equal(reconcilePageRows(previous, current)[0].name, "相似姓名乙");
});

test("activity warning scan keeps the threshold and stops at the first newer member", () => {
  const selection = selectActivityWarningRows(
    [
      { name: "离线一月", onlineState: "1个月前" },
      { name: "离线两天", onlineState: "2天前" },
      { name: "离线一天", onlineState: "1天前" },
      { name: "离线十二小时", onlineState: "12小时前" },
      { name: "在线成员", onlineState: "在线" }
    ],
    1
  );
  assert.deepEqual(
    selection.rows.map((row) => row.name),
    ["离线一月", "离线两天", "离线一天"]
  );
  assert.equal(selection.reachedBoundary, true);
});

test("activity warning scan does not stop while every parsed member remains over threshold", () => {
  const selection = selectActivityWarningRows(
    [
      { name: "离线一年", onlineState: "1年前" },
      { name: "离线八天", onlineState: "8天前" }
    ],
    8
  );
  assert.equal(selection.rows.length, 2);
  assert.equal(selection.reachedBoundary, false);
});
