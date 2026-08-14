import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  capturePagedTable,
  alignContributionRowsToRoster,
  alignStaffNamesToRoster,
  dedupeStaffAssignments,
  assertContributionComplete,
  reconcilePageRows,
  selectActivityWarningRows
} from "../src/workflows/member-sync.mjs";

test("contribution OCR role badges are aligned to the authoritative roster", () => {
  assert.deepEqual(
    alignContributionRowsToRoster(
      [
        {
          name: "雨梦也",
          weeklyContribution: "1",
          technologyPointsUsed: "81339",
          materialContribution: "2293389"
        },
        { name: "星河踏月归✨", weeklyContribution: "0" }
      ],
      [{ name: "雨梦" }, { name: "星河踏月归✨" }]
    ).map((row) => row.name),
    ["雨梦", "星河踏月归✨"]
  );
});

test("contribution rows keep all three values while deduplicating against the roster", () => {
  const rows = alignContributionRowsToRoster(
    [
      {
        name: "雨梦也",
        weeklyContribution: "1",
        technologyPointsUsed: "81339",
        materialContribution: "2293389"
      },
      {
        name: "雨梦",
        weeklyContribution: "1",
        technologyPointsUsed: "",
        materialContribution: "2293389"
      },
      {
        name: "OCR乱码",
        weeklyContribution: "999",
        technologyPointsUsed: "999",
        materialContribution: "999"
      }
    ],
    [{ name: "雨梦" }]
  );
  assert.deepEqual(rows, [
    {
      name: "雨梦",
      weeklyContribution: "1",
      technologyPointsUsed: "81339",
      materialContribution: "2293389"
    }
  ]);
});

test("contribution and inactivity scans wait three seconds after paging and stop at eleven pages", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    for (const table of ["contribution", "activity"]) {
      assert.equal(config.tables[table].pagination.maxPages, 11);
      assert.equal(
        config.tables[table].pagination.initialSettleMs,
        3000
      );
      assert.equal(config.tables[table].ocrMinimumConfidence, 0.3);
      assert.equal(
        config.tables[table].pagination.settleAfterSwipeMs,
        3000
      );
    }
    assert.equal(config.tables.members.ocrMinimumConfidence, 0.3);
    assert.deepEqual(config.tables.members.pagination.from, { x: 1700, y: 700 });
    assert.deepEqual(config.tables.members.pagination.to, { x: 1700, y: 225 });
    assert.deepEqual(config.tables.members.pagination.firstPageFrom, { x: 1700, y: 700 });
    assert.deepEqual(config.tables.members.pagination.firstPageTo, { x: 1700, y: 225 });
    assert.deepEqual(config.tables.members.pagination.fullPageRegion, {
      left: 115,
      top: 285,
      right: 1800,
      bottom: 810
    });
    assert.equal(config.tables.members.pagination.fullPageRows, 7);
    assert.deepEqual(
      config.flows.resetMemberPanelForRescan.map((action) => action.op),
      ["clickText", "waitAnyText", "clickText", "waitAnyText"]
    );
    assert.equal(config.flows.resetMemberPanelForRescan[0].text, "首页");
    assert.equal(config.flows.resetMemberPanelForRescan[2].text, "成员");
  }
});

test("contribution completeness accepts a raw full scan with one filtered OCR row", () => {
  assert.doesNotThrow(() =>
    assertContributionComplete(
      Array.from({ length: 99 }, (_, index) => ({ name: `成员${index}` })),
      { minimumCompleteRows: 100 },
      Array.from({ length: 100 }, (_, index) => ({ name: `成员${index}` }))
    )
  );
  assert.throws(
    () =>
      assertContributionComplete(
        Array.from({ length: 98 }, (_, index) => ({ name: `成员${index}` })),
        { minimumCompleteRows: 100 },
        Array.from({ length: 99 }, (_, index) => ({ name: `成员${index}` }))
      ),
    /CONTRIBUTION_INCOMPLETE/
  );
});

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

test("member profile pagination reaches the bottom before organizing to the header total", async () => {
  let swipes = 0;
  const reports = [];
  const pages = [
    [
      { name: "成员一" },
      { name: "成员二" },
      { name: "成员三", profession: "步枪兵", weeklyContribution: "300" }
    ],
    [
      { name: "成员参", profession: "步枪兵", weeklyContribution: "300" },
      { name: "成员四" },
      { name: "成员五" }
    ]
  ];
  const context = {
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async extractTableRows(_path, _definition, label) {
        const page = Number(label.match(/-(\d+)(?:-retry|$)/)?.[1] || 1);
        return pages[Math.min(page - 1, pages.length - 1)];
      }
    },
    adb: {
      async mouseSwipe() {
        swipes += 1;
      }
    },
    ui: { async afterAction() {} },
    async report(_level, step) {
      reports.push(step);
    }
  };
  const rows = await capturePagedTable(
    context,
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      pagination: {
        maxPages: 30,
        minimumRowsPerPage: 1,
        stopAfterStagnantPages: 3,
        from: { x: 1, y: 2 },
        to: { x: 1, y: 1 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 5 }
  );
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["成员一", "成员二", "成员三", "成员四", "成员五"]
  );
  assert.equal(swipes, 4);
  assert.ok(
    reports.includes("member_details_bottom_reached")
  );
});

test("member profile scan uses five-row pages and a full tail page", async () => {
  const swipes = [];
  const definitions = [];
  const pages = [
    Array.from({ length: 5 }, (_, index) => ({ name: `成员${index + 1}` })),
    Array.from({ length: 5 }, (_, index) => ({ name: `成员${index + 6}` })),
    Array.from({ length: 5 }, (_, index) => ({ name: `成员${index + 11}` })),
    Array.from({ length: 5 }, (_, index) => ({ name: `成员${index + 11}` }))
  ];
  const context = {
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async extractTableRows(_path, definition, label) {
        definitions.push({
          label,
          region: definition.region,
          rowsPerPage: definition.pagination.rowsPerPage
        });
        if (definition.region.bottom === 810) {
          return Array.from({ length: 5 }, (_, index) => ({ name: `成员${index + 12}` }));
        }
        const page = Number(label.match(/-(\d+)(?:-retry|$)/)?.[1] || 1);
        return pages[Math.min(page - 1, pages.length - 1)];
      }
    },
    adb: {
      async mouseSwipe(from, to) {
        swipes.push({ from, to });
      }
    },
    ui: { async afterAction() {} },
    async report() {}
  };
  const rows = await capturePagedTable(
    context,
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
      pagination: {
        maxPages: 10,
        rowsPerPage: 5,
        minimumRowsPerPage: 1,
        stopAfterStagnantPages: 3,
        fullPageRegion: { left: 115, top: 285, right: 1800, bottom: 810 },
        fullPageRows: 5,
        from: { x: 1700, y: 700 },
        to: { x: 1700, y: 225 },
        firstPageFrom: { x: 1700, y: 700 },
        firstPageTo: { x: 1700, y: 225 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 16 }
  );
  assert.equal(rows.length, 16);
  assert.equal(swipes.length, 3);
  assert.deepEqual(swipes.slice(0, 2), [
    {
      from: { x: 1700, y: 700 },
      to: { x: 1700, y: 225 }
    },
    {
      from: { x: 1700, y: 700 },
      to: { x: 1700, y: 225 }
    }
  ]);
  assert.deepEqual(
    definitions.map(({ region, rowsPerPage }) => ({ bottom: region.bottom, rowsPerPage })),
    [
      { bottom: 780, rowsPerPage: 5 },
      { bottom: 780, rowsPerPage: 5 },
      { bottom: 780, rowsPerPage: 5 },
      { bottom: 810, rowsPerPage: 5 },
      { bottom: 810, rowsPerPage: 5 }
    ]
  );
});

test("incomplete calculated tail keeps both continuation pages in full-page mode", async () => {
  const swipes = [];
  const definitions = [];
  const tailPages = [
    [{ name: "成员6" }, { name: "成员7" }],
    [{ name: "成员8" }, { name: "成员9" }],
    [{ name: "成员10" }]
  ];
  const context = {
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async extractTableRows(_path, definition, label) {
        definitions.push({
          page: Number(label.match(/member-details-(\d+)/)?.[1] || 1),
          bottom: definition.region.bottom,
          rowsPerPage: definition.pagination.rowsPerPage
        });
        const page = Number(label.match(/member-details-(\d+)/)?.[1] || 1);
        if (definition.region.bottom === 810) {
          return tailPages[page - 2] || [];
        }
        return Array.from({ length: 5 }, (_, index) => ({
          name: `成员${index + 1}`
        }));
      }
    },
    adb: {
      async mouseSwipe(from, to, durationMs) {
        swipes.push({ from, to, durationMs });
      }
    },
    ui: { async afterAction() {} },
    async report() {}
  };
  const rows = await capturePagedTable(
    context,
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      region: { left: 115, top: 285, right: 1800, bottom: 780 },
      pagination: {
        maxPages: 30,
        rowsPerPage: 5,
        minimumRowsPerPage: 1,
        stopAfterStagnantPages: 10,
        maxExtraPagesAfterExpected: 2,
        fullPageRegion: { left: 115, top: 285, right: 1800, bottom: 810 },
        fullPageRows: 7,
        from: { x: 1700, y: 700 },
        to: { x: 1700, y: 225 },
        firstPageFrom: { x: 1700, y: 700 },
        firstPageTo: { x: 1700, y: 225 },
        durationMs: 1000
      }
    },
    undefined,
    { expectedCount: 10 }
  );
  assert.equal(rows.length, 10);
  assert.deepEqual(
    definitions.map(({ bottom, rowsPerPage }) => ({ bottom, rowsPerPage })),
    [
      { bottom: 780, rowsPerPage: 5 },
      { bottom: 810, rowsPerPage: 5 },
      { bottom: 810, rowsPerPage: 5 },
      { bottom: 810, rowsPerPage: 5 }
    ]
  );
  assert.deepEqual(
    swipes.map(({ durationMs }) => durationMs),
    [700, 700, 700]
  );
});

test("tail recovery keeps a valid native row when OCR drops it", async () => {
  const recoveryCalls = [];
  const context = {
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async extractTableRows(_path, definition, label) {
        if (label.includes("page-recovery")) {
          recoveryCalls.push(label);
          return [
            { name: "送你颗星星" },
            { name: "长乐未央" },
            { name: "是你吻开笔墨" },
            { name: "可见一斑" }
          ];
        }
        if (definition.region.bottom === 810) {
          return [
            { name: "长乐未央" },
            { name: "长乐未央" },
            { name: "是你吻开笔墨" },
            { name: "Orange" },
            { name: "可见一斑" }
          ];
        }
        return Array.from({ length: 5 }, (_, index) => ({
          name: `成员${index + 1}`
        }));
      }
    },
    adb: { async mouseSwipe() {} },
    ui: { async afterAction() {} },
    async report() {}
  };
  const rows = await capturePagedTable(
    context,
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      region: { left: 115, top: 285, right: 1800, bottom: 780 },
      pagination: {
        maxPages: 10,
        rowsPerPage: 5,
        minimumRowsPerPage: 1,
        stopAfterStagnantPages: 3,
        fullPageRegion: { left: 115, top: 285, right: 1800, bottom: 810 },
        fullPageRows: 5,
        from: { x: 1700, y: 700 },
        to: { x: 1700, y: 225 },
        firstPageFrom: { x: 1700, y: 700 },
        firstPageTo: { x: 1700, y: 225 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 10 }
  );
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.slice(5).map((row) => row.name),
    ["送你颗星星", "长乐未央", "是你吻开笔墨", "可见一斑", "Orange"]
  );
  assert.equal(recoveryCalls.length, 1);
});

test("member profile scan allows at most two pages after an incomplete calculated tail", async () => {
  const swipes = [];
  const reports = [];
  const pages = [
    Array.from({ length: 5 }, (_, index) => ({ name: `成员${index + 1}` })),
    Array.from({ length: 5 }, (_, index) => ({ name: `成员${index + 6}` })),
    [
      { name: "成员12" },
      { name: "成员13" },
      { name: "成员14" },
      { name: "成员15" },
      { name: "成员11" }
    ],
    [
      { name: "成员13" },
      { name: "成员14" },
      { name: "成员15" },
      { name: "成员11" },
      { name: "成员12" }
    ],
    [
      { name: "成员14" },
      { name: "成员15" },
      { name: "成员11" },
      { name: "成员12" },
      { name: "成员13" }
    ],
    [
      { name: "成员15" },
      { name: "成员11" },
      { name: "成员12" },
      { name: "成员13" },
      { name: "成员14" }
    ]
  ];
  const context = {
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async extractTableRows(_path, definition, label) {
        const page = Number(label.match(/member-details-(\d+)/)?.[1] || 1);
        if (definition.region.bottom === 810) {
          return pages[3];
        }
        return pages[Math.min(page - 1, pages.length - 1)];
      }
    },
    adb: {
      async mouseSwipe(from, to) {
        swipes.push({ from, to });
      }
    },
    ui: { async afterAction() {} },
    async report(_level, step, message, payload) {
      reports.push({ step, message, payload });
    }
  };
  const rows = await capturePagedTable(
    context,
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      region: { left: 115, top: 285, right: 1800, bottom: 780 },
      pagination: {
        maxPages: 30,
        rowsPerPage: 5,
        minimumRowsPerPage: 1,
        stopAfterStagnantPages: 10,
        maxExtraPagesAfterExpected: 2,
        from: { x: 1700, y: 700 },
        to: { x: 1700, y: 225 },
        firstPageFrom: { x: 1700, y: 700 },
        firstPageTo: { x: 1700, y: 225 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 16 }
  );
  assert.equal(rows.length, 15);
  assert.ok(swipes.length <= 5);
  assert.ok(reports.some(({ step }) => step === "member_details_expected_page_incomplete"));
  assert.ok(reports.some(({ step }) => step === "member-details_page_limit_reached"));
});

test("member profile reconciliation never exceeds the header total", async () => {
  const rows = await capturePagedTable(
    {
      vision: {
        async capture(label) {
          return { path: `${label}.png`, observations: [] };
        },
        async extractTableRows() {
          return [
            { name: "成员一" },
            { name: "成员二" },
            { name: "成员三" },
            { name: "成员四" },
            { name: "成员五" },
            { name: "COSGH" },
            { name: "LSGH" }
          ];
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      pagination: {
        maxPages: 1,
        minimumRowsPerPage: 1,
        stopAfterStagnantPages: 1,
        from: { x: 1, y: 2 },
        to: { x: 1, y: 1 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 5 }
  );

  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["成员一", "成员二", "成员三", "成员四", "成员五"]
  );
});

test("member profile reconciliation never undercounts a complete raw roster", async () => {
  const rows = await capturePagedTable(
    {
      vision: {
        async capture(label) {
          return { path: `${label}.png`, observations: [] };
        },
        async extractTableRows() {
          return [
            {
              name: "模型一",
              weeklyContribution: "100",
              roommateName: "同居"
            },
            {
              name: "模型一号",
              weeklyContribution: "100",
              roommateName: "同居"
            }
          ];
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      pagination: {
        maxPages: 1,
        minimumRowsPerPage: 1,
        stopAfterStagnantPages: 1,
        from: { x: 1, y: 2 },
        to: { x: 1, y: 1 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 2 }
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.name).sort(),
    ["模型一", "模型一号"].sort()
  );
});

test("member profiles keep names that differ by decorative symbols", async () => {
  const rows = await capturePagedTable(
    {
      vision: {
        async capture(label) {
          return { path: `${label}.png`, observations: [] };
        },
        async extractTableRows() {
          return [
            { name: "#愿✨", profession: "步枪兵", weeklyContribution: "100" },
            { name: "愿", profession: "步枪兵", weeklyContribution: "100" },
            { name: "成员二" },
            { name: "成员三" },
            { name: "成员四" }
          ];
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      pagination: {
        maxPages: 1,
        minimumRowsPerPage: 5,
        stopAfterStagnantPages: 1,
        from: { x: 1, y: 2 },
        to: { x: 1, y: 1 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 5 }
  );

  assert.equal(rows.length, 5);
  assert.equal(rows[0].name, "#愿✨");
});

test("member profiles promote same-text visual variants even when they are on different pages", async () => {
  const pages = [
    [
      { name: "花", profession: "步枪兵" },
      { name: "成员一" },
      { name: "成员二" },
      { name: "成员三" },
      { name: "成员四" }
    ],
    [
      { name: "✿花✿", profession: "采集工" },
      { name: "成员五" },
      { name: "成员六" },
      { name: "成员七" },
      { name: "成员八" }
    ]
  ];
  const rows = await capturePagedTable(
    {
      vision: {
        async capture(label) {
          return { path: `${label}.png`, observations: [] };
        },
        async extractTableRows(_path, _definition, label) {
          const page = Number(label.match(/member-details-(\d+)/)?.[1] || 1);
          return pages[page - 1] || [];
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      pagination: {
        maxPages: 2,
        rowsPerPage: 5,
        minimumRowsPerPage: 5,
        stopAfterStagnantPages: 1,
        from: { x: 1, y: 2 },
        to: { x: 1, y: 1 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 10 }
  );

  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.filter((row) => row.name.includes("花")).map((row) => row.name),
    ["花", "✿花✿"]
  );
});

test("member profiles retain three same-text flower variants independently", async () => {
  const flowerVariants = ["✿慕离✿", "❀慕离❀", "※慕离※"];
  const rows = await capturePagedTable(
    {
      vision: {
        async capture(label) {
          return { path: `${label}.png`, observations: [] };
        },
        async extractTableRows(_path, _definition, label) {
          const page = Number(label.match(/member-details-(\d+)/)?.[1] || 1);
          const pageRows = page === 1
            ? [
                { name: flowerVariants[0] },
                { name: "成员一" },
                { name: "成员二" },
                { name: "成员三" },
                { name: "成员四" }
              ]
            : page === 2
              ? [
                  { name: flowerVariants[1] },
                  { name: "成员五" },
                  { name: "成员六" },
                  { name: "成员七" },
                  { name: "成员八" }
                ]
              : [
                  { name: flowerVariants[2] },
                  { name: "成员九" },
                  { name: "成员十" },
                  { name: "成员十一" },
                  { name: "成员十二" }
                ];
          return pageRows;
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      pagination: {
        maxPages: 3,
        rowsPerPage: 5,
        minimumRowsPerPage: 3,
        stopAfterStagnantPages: 1,
        from: { x: 1, y: 2 },
        to: { x: 1, y: 1 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 15 }
  );

  const names = rows
    .map((row) => row.name)
    .filter((name) => name.includes("慕离"));
  assert.equal(names.length, 3);
  assert.deepEqual(names, flowerVariants);
});

test("member profiles retain pure-symbol names as independent roster keys", async () => {
  const rows = await capturePagedTable(
    {
      vision: {
        async capture(label) {
          return { path: `${label}.png`, observations: [] };
        },
        async extractTableRows() {
          return [
            { name: "- ☻ -" },
            { name: "♤" },
            { name: "♠" },
            { name: "成员一" },
            { name: "成员二" }
          ];
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      pagination: {
        maxPages: 1,
        rowsPerPage: 5,
        minimumRowsPerPage: 5,
        stopAfterStagnantPages: 1,
        from: { x: 1, y: 2 },
        to: { x: 1, y: 1 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 5 }
  );

  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.slice(0, 3).map((row) => row.name),
    ["- ☻ -", "♤", "♠"]
  );
});

test("member scans discard avatar year text and collapse exact duplicate rows", async () => {
  const recoveryLabels = [];
  const context = {
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async extractTableRows(_path, _definition, label) {
        if (label.includes("page-recovery")) {
          recoveryLabels.push(label);
          return [
            { name: "成员一" },
            { name: "成员二" },
            { name: "成员三" },
            { name: "成员四" },
            { name: "成员五" }
          ];
        }
        return [
          { name: "成员一" },
          { name: "成员二" },
          { name: "成员三" },
          { name: "成员三" },
          { name: "2025" },
          { name: "成员四" },
          { name: "成员五" }
        ];
      }
    },
    adb: { async mouseSwipe() {} },
    ui: { async afterAction() {} },
    async report() {}
  };
  const rows = await capturePagedTable(
    context,
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      region: { left: 115, top: 285, right: 1800, bottom: 780 },
      pagination: {
        maxPages: 1,
        rowsPerPage: 5,
        minimumRowsPerPage: 1,
        stopAfterStagnantPages: 1,
        fullPageRegion: { left: 115, top: 285, right: 1800, bottom: 810 },
        fullPageRows: 7
      }
    },
    undefined,
    { expectedCount: 5 }
  );

  assert.deepEqual(rows.map((row) => row.name), [
    "成员一",
    "成员二",
    "成员三",
    "成员四",
    "成员五"
  ]);
  assert.equal(recoveryLabels.length, 1);
});

test("conflicting data under the same OCR name triggers strengthened name recovery", async () => {
  let recoveryCalls = 0;
  const rows = await capturePagedTable(
    {
      vision: {
        async capture(label) {
          return { path: `${label}.png`, observations: [] };
        },
        async extractTableRows(_path, _definition, _label, _signal, options) {
          if (options?.forceOcrRecovery) {
            recoveryCalls += 1;
            return [
              { name: "成员一", profession: "步枪兵", weeklyContribution: "100" },
              { name: "成员壹", profession: "采集工", weeklyContribution: "200" },
              { name: "成员二" },
              { name: "成员三" },
              { name: "成员四" }
            ];
          }
          return [
            { name: "成员一", profession: "步枪兵", weeklyContribution: "100" },
            { name: "成员一", profession: "采集工", weeklyContribution: "200" },
            { name: "成员二" },
            { name: "成员三" },
            { name: "成员四" }
          ];
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-details",
    {
      extractionMode: "hybrid",
      headerPattern: [],
      pagination: {
        maxPages: 1,
        minimumRowsPerPage: 5,
        stopAfterStagnantPages: 1,
        from: { x: 1, y: 2 },
        to: { x: 1, y: 1 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 5 }
  );

  assert.equal(recoveryCalls, 1);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["成员一", "成员壹", "成员二", "成员三", "成员四"]
  );
});

test("staff assignments keep every role and member name unique", () => {
  assert.deepEqual(
    dedupeStaffAssignments([
      { roleKey: "mayor", roleName: "市长", memberName: "雨梦" },
      { roleKey: "mayor-copy", roleName: "市长", memberName: "雨梦" },
      { roleKey: "staff-1", roleName: "#W月之歌", memberName: "萤萤空心菜" },
      { roleKey: "staff-2", roleName: "#W圣之雪", memberName: "七晓白" },
      { roleKey: "staff-3", roleName: "#P营地助手", memberName: "七晓白✨" }
    ]),
    [
      { roleKey: "mayor", roleName: "市长", memberName: "雨梦" },
      { roleKey: "staff-1", roleName: "#W月之歌", memberName: "萤萤空心菜" },
      { roleKey: "staff-2", roleName: "#W圣之雪", memberName: "七晓白" }
    ]
  );
});

test("staff names remove rendered ordinals and reconcile OCR decoration to the roster", async () => {
  const { normalizeStaffGrid } = await import("../src/table-parser.mjs");
  const rows = normalizeStaffGrid(
    [
      { text: "4. 纸鸢”）", x: 600, y: 500, width: 160, height: 32 },
      { text: "#G春之音", x: 600, y: 540, width: 160, height: 32 },
      { text: "雨梦", x: 250, y: 800, width: 80, height: 32 },
      { text: "市长", x: 250, y: 840, width: 80, height: 32 }
    ],
    {
      slots: [
        { roleKey: "staff-4", roleName: "公职席位 4", region: { left: 560, top: 470, right: 850, bottom: 590 } },
        { roleKey: "mayor", roleName: "市长", region: { left: 230, top: 780, right: 500, bottom: 900 } }
      ]
    }
  );
  assert.equal(rows[0].memberName, "纸鸢");
  assert.equal(rows[0].roleName, "春之音");
  assert.equal(rows[1].memberName, "雨梦");
  assert.equal(rows[1].roleName, "市长");
  assert.equal(
    normalizeStaffGrid(
      [
        { text: "Alice", x: 600, y: 500, width: 100, height: 32 },
        { text: "#Z保留颜色文本", x: 600, y: 540, width: 160, height: 32 }
      ],
      {
        slots: [
          { roleKey: "staff-z", roleName: "公职席位 1", region: { left: 560, top: 470, right: 850, bottom: 590 } }
        ]
      }
    )[0].roleName,
    "#Z保留颜色文本"
  );
  assert.equal(
    alignStaffNamesToRoster(rows, [{ name: "纸鸢" }])[0].memberName,
    "纸鸢"
  );
  assert.equal(
    alignStaffNamesToRoster(
      [{ roleKey: "staff-3", roleName: "公职席位 3", memberName: "蛮蛮空心票" }],
      [{ name: "蛮蛮空心菜" }]
    )[0].memberName,
    "蛮蛮空心菜"
  );
  assert.equal(
    alignStaffNamesToRoster(
      [{ roleKey: "staff-1", roleName: "公职席位 1", memberName: "9.纸变”" }],
      [{ name: "纸鸢" }]
    )[0].memberName,
    "纸鸢"
  );
});
