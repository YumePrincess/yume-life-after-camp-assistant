import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  captureContribution,
  capturePagedTable,
  alignContributionRowsToRoster,
  dedupeStaffAssignments,
  dedupeContributionRows,
  assertContributionComplete,
  containsSailingTitleLeak,
  reconcilePageRows,
  mergeActivityRecoveryRows,
  selectActivityWarningRows,
  stripStaffColorCodes,
  tableRowAlignmentAdjustment
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
      assert.equal(config.tables[table].pagination.durationMs, 1000);
      assert.equal(config.tables[table].ocrMinimumConfidence, 0.3);
      assert.equal(
        config.tables[table].pagination.settleAfterSwipeMs,
        2000
      );
      assert.equal(config.tables[table].pagination.rowsPerPage, 11);
      assert.equal(config.tables[table].pagination.minimumRowsPerPage, 11);
      assert.equal(config.tables[table].pagination.visibleRowsPerPage, 11);
      assert.equal(config.tables[table].pagination.lastPageRows, 11);
      assert.equal(config.tables[table].pagination.swipeStartY, 980);
      assert.equal(config.tables[table].pagination.rowAnchorTop, 285);
      assert.equal(config.tables[table].pagination.rowHeightPx, 66);
      assert.equal(config.tables[table].pagination.measurePageHeightFromRows, true);
      assert.equal(config.tables[table].pagination.pageHeightPx, 730);
      assert.equal(config.tables[table].pagination.pageHeightExtraPx, 0);
      assert.equal(config.tables[table].pagination.rowResidualMaxPx, 18);
      assert.equal(config.tables[table].pagination.to.y, 250);
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

test("member profile helpers clean staff color codes and detect leaked sailing titles", () => {
  assert.equal(stripStaffColorCodes("#P 营地助手"), "营地助手");
  assert.equal(stripStaffColorCodes("#B#G 资源官"), "资源官");
  assert.equal(stripStaffColorCodes("市长"), "市长");
  assert.equal(containsSailingTitleLeak("启航"), true);
  assert.equal(containsSailingTitleLeak("#B XXX"), true);
  assert.equal(containsSailingTitleLeak("#YXXX"), true);
  assert.equal(containsSailingTitleLeak("#B XXX #YXXX"), true);
  assert.equal(containsSailingTitleLeak("#B启航"), false);
  assert.equal(containsSailingTitleLeak("#Y启航"), false);
  assert.equal(containsSailingTitleLeak("#P 启航"), false);
  assert.equal(containsSailingTitleLeak("#W#Y 启航"), false);
  assert.equal(containsSailingTitleLeak("雨梦"), false);
});

test("member scan rereads a full page when a sailing title leaks into the name", async () => {
  const advisorOptions = [];
  const context = {
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations: [
            "#B XXX",
            "成员二",
            "成员三",
            "成员四",
            "成员五"
          ].map((text, index) => ({
            text,
            x: 300,
            y: 320 + index * 95,
            width: 120,
            height: 36
          }))
        };
      },
      async extractTableRows(_path, _definition, _label, _signal, options) {
        advisorOptions.push(options);
        return [
          { name: "成员一" },
          { name: "成员二" },
          { name: "成员三" },
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
      region: { left: 115, top: 285, right: 1800, bottom: 780 },
      rowAnchorTop: 315,
      columns: [
        { key: "identity", left: 0, right: 1, stackedKeys: ["name"] }
      ],
      headerPattern: [],
      pagination: {
        maxPages: 1,
        rowsPerPage: 5,
        minimumRowsPerPage: 5,
        stopAfterStagnantPages: 1
      }
    }
  );

  assert.deepEqual(rows.map((row) => row.name), [
    "成员一",
    "成员二",
    "成员三",
    "成员四",
    "成员五"
  ]);
  assert.equal(advisorOptions.length, 1);
  assert.equal(advisorOptions[0].forceMemberAdvisor, true);
});

test("contribution and activity pages use 11-row calibrated segmented swipes", async () => {
  for (const label of ["member-contribution", "member-activity"]) {
    const swipes = [];
    const shellCalls = [];
    let probeCalls = 0;
    const reports = [];
    const context = {
      config: { localVisionModel: { enabled: false, transport: "http" } },
      vision: {
        async capture(currentLabel) {
          const capturePage = Number(currentLabel.match(/-(\d+)/)?.[1] || 1);
          return {
            path: `${currentLabel}.png`,
            observations: Array.from({ length: 11 }, (_, index) => ({
              text: `raw-${label}-${capturePage}-${index}`,
              x: 1240,
              y: 290 + index * 68,
              width: 100,
              height: 20
            }))
          };
        },
        async probe(_path, points) {
          probeCalls += 1;
          return points.map(({ x, y }) => {
            const level =
              probeCalls === 1
                ? y < 295
                  ? 0.1
                  : Math.floor((y - 295) / 66) % 2
                    ? 0.1
                    : 0.3
                : probeCalls === 2
                  ? y < 295
                    ? 0.1
                    : Math.floor((y - 295) / 66) % 2
                      ? 0.1
                      : 0.3
                  : Math.floor((y - 285) / 66) % 2
                    ? 0.1
                    : 0.3;
            return {
              x,
              y,
              meanRed: level,
              meanGreen: level,
              meanBlue: level
            };
          });
        },
        async extractTableRows(_path, _definition, currentLabel) {
          const page = Number(currentLabel.match(/-(\d+)/)?.[1] || 1);
          return Array.from({ length: 11 }, (_, index) => ({
            name: `${label}-${page}-${index}`,
            ...(label === "member-contribution"
              ? {
                  weeklyContribution: "1",
                  technologyPointsUsed: "2",
                  materialContribution: "3"
                }
              : { onlineState: "在线" })
          }));
        }
      },
      adb: {
        async mouseSwipe(from, to, durationMs) {
          swipes.push({ from, to, durationMs });
        },
        async shell(args) {
          shellCalls.push(args);
        }
      },
      ui: { async afterAction() {} },
      async sleep() {},
      async report(_level, step, message, detail) {
        reports.push({ step, message, detail });
      }
    };
    const rows = await capturePagedTable(
      context,
      label,
      {
        region: { left: 1220, top: 270, right: 1900, bottom: 1000 },
        columns: [{ key: "name", left: 0, right: 1 }],
        headerPattern: [],
        pagination: {
          maxPages: 2,
          stopAfterStagnantPages: 2,
          pageHeightPx: 0,
          pageHeightExtraPx: 5
        }
      }
    );
    assert.equal(rows.length, 22);
    assert.equal(swipes.length, 0);
    assert.ok(probeCalls >= 1);
    assert.ok(shellCalls.some((args) => args[0] === "input" && args[2] === "motionevent"));
    const motionY = shellCalls
      .filter((args) => args[0] === "input" && args[2] === "motionevent")
      .map((args) => Number(args[5]));
    const alignmentStart = motionY.indexOf(577);
    assert.ok(alignmentStart >= 0);
    assert.ok(motionY.includes(567));
    assert.ok(motionY.includes(980));
    assert.ok(motionY.includes(227));
    assert.ok(reports.some(({ step }) => step === "table_row_alignment"));
    assert.equal(reports.find(({ step }) => step === "table_row_alignment").detail.distance, 10);
    assert.equal(reports.find(({ step }) => step === "table_row_alignment").detail.direction, "up");
    assert.equal(
      reports.find(({ step }) => step === "table_page_height_calibrated").detail.totalHeightPx,
      748
    );
    assert.equal(
      reports.find(({ step }) => step === "table_page_height_calibrated").detail.swipeHeightPx,
      753
    );
  }
});

test("contribution pages recover a missing name without shifting later rows", async () => {
  const recoveryOptions = [];
  const nativeRows = Array.from({ length: 11 }, (_, index) => ({
    name: index === 4 ? "" : `原生${index + 1}`,
    weeklyContribution: "0",
    technologyPointsUsed: String(index + 1),
    materialContribution: String(index + 10)
  }));
  const nativeObservations = nativeRows.flatMap((row, index) => [
    ...(row.name
      ? [{
          text: row.name,
          x: 120,
          y: 290 + index * 66,
          width: 60,
          height: 20
        }]
      : []),
    { text: row.weeklyContribution, x: 380, y: 290 + index * 66, width: 20, height: 20 },
    { text: row.technologyPointsUsed, x: 560, y: 290 + index * 66, width: 40, height: 20 },
    { text: row.materialContribution, x: 760, y: 290 + index * 66, width: 50, height: 20 }
  ]);
  const recoveredRows = nativeRows.map((row, index) => ({
    ...row,
    name: `恢复${index + 1}`
  }));
  const rows = await capturePagedTable(
    {
      vision: {
        async capture() {
          return { path: "contribution-missing-name.png", observations: nativeObservations };
        },
        async extractTableRows(_path, _definition, _label, _signal, options) {
          recoveryOptions.push(options);
          return recoveredRows;
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-contribution",
    {
      region: { left: 100, top: 270, right: 900, bottom: 1000 },
      columns: [
        { key: "name", left: 0, right: 0.32 },
        { key: "weeklyContribution", left: 0.32, right: 0.54 },
        { key: "technologyPointsUsed", left: 0.54, right: 0.76 },
        { key: "materialContribution", left: 0.76, right: 1 }
      ],
      headerPattern: [],
      pagination: {
        maxPages: 1,
        rowsPerPage: 11,
        minimumRowsPerPage: 11,
        stopAfterStagnantPages: 1
      }
    }
  );

  assert.equal(rows.length, 11);
  assert.deepEqual(rows.map((row) => row.name), [
    "原生1",
    "原生2",
    "原生3",
    "原生4",
    "恢复5",
    "原生6",
    "原生7",
    "原生8",
    "原生9",
    "原生10",
    "原生11"
  ]);
  assert.deepEqual(recoveryOptions, [{ forceContributionRecovery: true }]);
});

test("contribution scans continue past the roster count and retain raw page overlap", async () => {
  const swipes = [];
  const pages = [
    Array.from({ length: 11 }, (_, index) => ({ name: `成员${index + 1}` })),
    Array.from({ length: 11 }, (_, index) => ({ name: `成员${index + 12}` })),
    [
      { name: "成员22" },
      ...Array.from({ length: 10 }, (_, index) => ({ name: `成员${index + 12}` }))
    ]
  ];
  const rows = await capturePagedTable(
    {
      vision: {
        async capture() {
          return { path: "contribution-tail.png", observations: [] };
        },
        async extractTableRows(_path, _definition, label) {
          const page = Number(label.match(/-(\d+)/)?.[1] || 1);
          return pages[Math.min(page - 1, pages.length - 1)];
        }
      },
      adb: {
        async mouseSwipe() {
          swipes.push(true);
        }
      },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-contribution",
    {
      headerPattern: [],
      pagination: {
        maxPages: 6,
        rowsPerPage: 11,
        minimumRowsPerPage: 11,
        stopAfterStagnantPages: 2,
        pageHeightPx: 730,
        from: { x: 1550, y: 980 },
        to: { x: 1550, y: 250 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 23 }
  );

  assert.equal(rows.length, 44);
  assert.equal(rows.filter((row) => row.name === "成员22").length, 3);
  assert.equal(rows.filter((row) => row.name === "成员12").length, 3);
  assert.equal(swipes.length, 3);
});

test("contribution rows are deduplicated only after the complete scan", () => {
  const rows = dedupeContributionRows([
    {
      name: "成员一",
      weeklyContribution: "1",
      technologyPointsUsed: "",
      materialContribution: "3"
    },
    {
      name: "成员一",
      weeklyContribution: "1",
      technologyPointsUsed: "2",
      materialContribution: "3"
    },
    {
      name: "成员二",
      weeklyContribution: "4",
      technologyPointsUsed: "5",
      materialContribution: "6"
    }
  ]);

  assert.deepEqual(rows, [
    {
      name: "成员一",
      weeklyContribution: "1",
      technologyPointsUsed: "2",
      materialContribution: "3"
    },
    {
      name: "成员二",
      weeklyContribution: "4",
      technologyPointsUsed: "5",
      materialContribution: "6"
    }
  ]);
});

test("contribution count mismatch does not reopen the page for an Agent retry", async () => {
  const flows = [];
  const reports = [];
  const rows = await captureContribution(
    {
      config: {
        tables: {
          contribution: {
            region: { left: 100, top: 270, right: 900, bottom: 1000 },
            columns: [
              { key: "name", left: 0, right: 0.32 },
              { key: "weeklyContribution", left: 0.32, right: 0.54 },
              { key: "technologyPointsUsed", left: 0.54, right: 0.76 },
              { key: "materialContribution", left: 0.76, right: 1 }
            ],
            headerPattern: [],
            pagination: {
              maxPages: 1,
              rowsPerPage: 11,
              minimumRowsPerPage: 1,
              stopAfterStagnantPages: 1
            }
          }
        }
      },
      ui: {
        async executeFlow(name) {
          flows.push(name);
        },
        async afterAction() {}
      },
      vision: {
        async capture() {
          return { path: "contribution-count-mismatch.png", observations: [] };
        },
        async extractTableRows() {
          return [{
            name: "成员一",
            weeklyContribution: "1",
            technologyPointsUsed: "2",
            materialContribution: "3"
          }];
        }
      },
      async sleep() {},
      async report(_level, step) {
        reports.push(step);
      }
    },
    undefined,
    { expectedCount: 2 }
  );

  assert.equal(rows.length, 1);
  assert.equal(flows.filter((name) => name === "openContribution").length, 1);
  assert.ok(reports.includes("contribution_count_mismatch_no_retry"));
  assert.ok(!reports.includes("contribution_empty_retry"));
});

test("contribution and activity color bands choose the correction direction", () => {
  const definition = { region: { left: 1220, top: 270, right: 1900, bottom: 1000 } };
  const pagination = {
    rowHeightPx: 66,
    rowResidualMaxPx: 18,
    rowsPerPage: 11,
    from: { x: 1550, y: 980 }
  };
  const down = tableRowAlignmentAdjustment(
    [
      { kind: "light", start: 285, end: 295, length: 10 },
      { kind: "dark", start: 295, end: 361, length: 66 }
    ],
    definition,
    pagination,
    1,
    "dark"
  );
  assert.equal(down.direction, "down");
  assert.equal(down.distance, 56);

  const up = tableRowAlignmentAdjustment(
    [
      { kind: "dark", start: 285, end: 295, length: 10 },
      { kind: "light", start: 295, end: 361, length: 66 }
    ],
    definition,
    pagination,
    1,
    "dark"
  );
  assert.equal(up.direction, "up");
  assert.equal(up.distance, 10);
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

test("activity boundary reread restores a warning row before stopping", async () => {
  const recoveryCalls = [];
  const reports = [];
  const firstPage = Array.from({ length: 11 }, (_, index) => ({
    name: `第${index + 1}名`,
    onlineState: "2天前"
  }));
  const secondPageBeforeRecovery = [
    { name: "第12名", onlineState: "2天前" },
    { name: "第13名", onlineState: "2天前" },
    { name: "第14名", onlineState: "2天前" },
    { name: "第15名", onlineState: "12小时前" }
  ];
  const secondPageAfterRecovery = [
    ...secondPageBeforeRecovery.slice(0, 3),
    { name: "第16名", onlineState: "2天前" },
    secondPageBeforeRecovery[3]
  ];
  const context = {
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async extractTableRows(_path, _definition, label, _signal, options) {
        if (options?.forceActivityRecovery) {
          recoveryCalls.push(label);
          return secondPageAfterRecovery;
        }
        return label.includes("-1") ? firstPage : secondPageBeforeRecovery;
      }
    },
    adb: { async mouseSwipe() {} },
    ui: { async afterAction() {} },
    async report(_level, step, message, detail) {
      reports.push({ step, message, detail });
    }
  };
  const rows = await capturePagedTable(
    context,
    "member-activity",
    {
      region: { left: 100, top: 200, right: 900, bottom: 900 },
      columns: [
        { key: "name", left: 0, right: 0.5 },
        { key: "onlineState", left: 0.5, right: 1 }
      ],
      headerPattern: [],
      pagination: {
        maxPages: 3,
        rowsPerPage: 11,
        minimumRowsPerPage: 11,
        stopAfterStagnantPages: 2,
        from: { x: 800, y: 850 },
        to: { x: 800, y: 120 },
        durationMs: 1,
        pageHeightPx: 730
      }
    },
    undefined,
    { minimumInactiveDays: 1 }
  );

  assert.equal(rows.length, 15);
  assert.deepEqual(rows.map((row) => row.name), [
    "第1名", "第2名", "第3名", "第4名", "第5名", "第6名", "第7名",
    "第8名", "第9名", "第10名", "第11名", "第12名", "第13名", "第14名", "第16名"
  ]);
  assert.equal(recoveryCalls.length, 1);
  assert.ok(reports.some(({ step }) => step === "activity_boundary_recovered"));
  assert.ok(reports.some(({ step }) => step === "activity_threshold_reached"));
});

test("activity recovery merge keeps the first row data and adds only new names", () => {
  const merged = mergeActivityRecoveryRows(
    [
      { name: "成员一", onlineState: "2天前" },
      { name: "成员二", onlineState: "12小时前" }
    ],
    [
      { name: "成员一", onlineState: "3天前" },
      { name: "成员三", onlineState: "2天前" }
    ]
  );
  assert.deepEqual(merged, [
    { name: "成员一", onlineState: "2天前" },
    { name: "成员二", onlineState: "12小时前" },
    { name: "成员三", onlineState: "2天前" }
  ]);
});

test("activity pages below eleven rows force a scaled OCR recovery", async () => {
  const recoveryOptions = [];
  const definition = {
    region: { left: 1220, top: 270, right: 1900, bottom: 1000 },
    columns: [
      { key: "name", left: 0, right: 0.58 },
      { key: "onlineState", left: 0.58, right: 1 }
    ],
    headerPattern: [],
    pagination: {
      maxPages: 1,
      rowsPerPage: 11,
      minimumRowsPerPage: 11,
      stopAfterStagnantPages: 1
    }
  };
  const nativeRows = Array.from({ length: 10 }, (_, index) => [
    { text: `原生${index}`, x: 1300, y: 290 + index * 66, width: 50, height: 20 },
    { text: "23小时前", x: 1700, y: 290 + index * 66, width: 80, height: 20 }
  ]).flat();
  const recoveredRows = Array.from({ length: 11 }, (_, index) => ({
    name: `恢复${index + 1}`,
    onlineState: "23小时前"
  }));
  const rows = await capturePagedTable(
    {
      vision: {
        async capture() {
          return { path: "activity-partial.png", observations: nativeRows };
        },
        async extractTableRows(_path, _definition, _label, _signal, options) {
          recoveryOptions.push(options);
          return recoveredRows;
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-activity",
    definition,
    undefined,
    {}
  );

  assert.equal(rows.length, 11);
  assert.equal(recoveryOptions.length, 1);
  assert.deepEqual(recoveryOptions[0], { forceActivityRecovery: true });
  assert.deepEqual(rows.map((row) => row.name), recoveredRows.map((row) => row.name));
});

test("activity pages with a missing online state force a scaled OCR recovery", async () => {
  const recoveryOptions = [];
  const nativeRows = Array.from({ length: 11 }, (_, index) => ({
    name: `成员${index + 1}`,
    onlineState: index === 0 ? "" : "1天前"
  }));
  const recoveredRows = nativeRows.map((row, index) => ({
    ...row,
    onlineState: index === 0 ? "1天前" : row.onlineState
  }));
  const nativeObservations = nativeRows.flatMap((row, index) => [
    {
      text: row.name,
      x: 200,
      y: 290 + index * 66,
      width: 50,
      height: 20
    },
    ...(row.onlineState
      ? [{
          text: row.onlineState,
          x: 600,
          y: 290 + index * 66,
          width: 80,
          height: 20
        }]
      : [])
  ]);
  const rows = await capturePagedTable(
    {
      vision: {
        async capture() {
          return {
            path: "activity-missing-state.png",
            observations: nativeObservations
          };
        },
        async extractTableRows(_path, _definition, _label, _signal, options) {
          recoveryOptions.push(options);
          return recoveredRows;
        }
      },
      adb: { async mouseSwipe() {} },
      ui: { async afterAction() {} },
      async report() {}
    },
    "member-activity",
    {
      region: { left: 100, top: 200, right: 900, bottom: 900 },
      columns: [
        { key: "name", left: 0, right: 0.58 },
        { key: "onlineState", left: 0.58, right: 1 }
      ],
      headerPattern: [],
      pagination: {
        maxPages: 1,
        rowsPerPage: 11,
        minimumRowsPerPage: 11,
        stopAfterStagnantPages: 1
      }
    }
  );

  assert.equal(rows.length, 11);
  assert.deepEqual(recoveryOptions, [{ forceActivityRecovery: true }]);
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
    async report(_level, step, message, detail) {
      reports.push({ step, message, detail });
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
    reports.some(({ step }) => step === "member_details_bottom_reached")
  );
  const pageReport = reports.find(({ step }) => step === "member-details_page");
  assert.deepEqual(pageReport.detail.finalPlayerNames, [
    "成员一",
    "成员二",
    "成员三"
  ]);
  assert.match(pageReport.message, /最终玩家：成员一、成员二、成员三/);
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

test("member profile scan stops immediately when a page remains incomplete", async () => {
  let swipes = 0;
  const reports = [];
  const reportMessages = [];
  const aiOptions = [];
  const context = {
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async extractTableRows(_path, _definition, _label, _signal, options) {
        aiOptions.push(options || {});
        return Array.from({ length: 4 }, (_, index) => ({
          name: `成员${index + 1}`
        }));
      }
    },
    adb: {
      async mouseSwipe() {
        swipes += 1;
      }
    },
    ui: { async afterAction() {} },
    async report(_level, step, message, detail) {
      reports.push(step);
      reportMessages.push({ step, message, detail });
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
        minimumRowsPerPage: 5,
        maxIncompletePageRetries: 6,
        fullPageRegion: { left: 115, top: 285, right: 1800, bottom: 810 },
        fullPageRows: 7,
        stopAfterStagnantPages: 3,
        from: { x: 1700, y: 700 },
        to: { x: 1700, y: 225 },
        durationMs: 1
      }
    },
    undefined,
    { expectedCount: 90 }
  );

  assert.equal(rows.length, 4);
  assert.equal(swipes, 0);
  assert.ok(aiOptions.length >= 6);
  assert.ok(aiOptions.every((options) => options.forceMemberAdvisor === true));
  assert.ok(
    reportMessages
      .filter(({ step }) => step === "member_details_page_incomplete_retry")
      .every(({ message }) => message.includes("成员1、成员2、成员3、成员4"))
  );
  assert.equal(
    reports.filter((step) => step === "member_details_page_incomplete_retry").length,
    6
  );
  assert.ok(reports.includes("member_details_incomplete_stop"));
  assert.ok(reports.includes("member_details_scan_stopped_incomplete"));
  assert.ok(!reports.includes("member_details_bottom_reached"));
});

test("tail recovery keeps a valid native row when the advisor drops it", async () => {
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
          if (options?.forceMemberAdvisor) {
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
      { roleKey: "staff-3", roleName: "#P营地助手", memberName: "七晓白✨" },
      { roleKey: "staff-4", roleName: "公职席位 4", memberName: "错误占位" }
    ]),
    [
      { roleKey: "mayor", roleName: "市长", memberName: "雨梦" },
      { roleKey: "staff-1", roleName: "#W月之歌", memberName: "萤萤空心菜" },
      { roleKey: "staff-2", roleName: "#W圣之雪", memberName: "七晓白" }
    ]
  );
});
