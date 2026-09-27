import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import {
  inferMemberIdentity,
  isPlausibleMemberName,
  parsePopulationCapacity,
  parsePopulationFraction,
  safeSipsCropRegion
} from "../src/vision.mjs";
import { Vision } from "../src/vision.mjs";
import {
  isMemberAvatarArtifact,
  isMemberIdentityBadge,
  isMemberProfessionArtifact,
  isMemberSymbolOnlyName
} from "../src/member-name.mjs";

test("game-mouse icon detection uses two pixel probes and OCR only as a conservative fallback", async () => {
  const vision = new Vision({
    adb: {
      screenWidth: 1920,
      screenHeight: 1200,
      gameMouseIcon: {
        probePoints: [
          { x: 1728, y: 1000 },
          { x: 1728, y: 1055 }
        ],
        probeRadius: 18,
        luminanceDeviationThreshold: 0.12,
        ocrFallback: {
          texts: ["Space"],
          minimumConfidence: 0.35,
          luminanceDeviationThreshold: 0.08
        }
      }
    },
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.captureSource = async () => ({ path: "/private/tmp/icon-test.png" });
  vision.ocrRegion = async () => [{ text: "Space", confidence: 1 }];
  let probes = [
    { luminanceDeviation: 0.13 },
    { luminanceDeviation: 0.12 }
  ];
  vision.probe = async () => probes;

  assert.equal(await vision.gameMouseIconVisible(), true);
  probes = [
    { luminanceDeviation: 0.03 },
    { luminanceDeviation: 0.04 }
  ];
  assert.equal(await vision.gameMouseIconVisible(), false);
  probes = [
    { luminanceDeviation: 0.09 },
    { luminanceDeviation: 0.08 }
  ];
  assert.equal(await vision.gameMouseIconVisible(), true);
});

test("C icon state uses warm-color pixels to distinguish lit from dim", async () => {
  const vision = new Vision({
    adb: {
      gameMouseCIcon: {
        probePoints: [
          { x: 1865, y: 1130 },
          { x: 1848, y: 1130 },
          { x: 1882, y: 1130 }
        ],
        minimumLitPoints: 2,
        redBlueDelta: 0.08,
        greenBlueDelta: 0.03,
        minimumSaturation: 0.15
      }
    },
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.captureSource = async () => ({ path: "/private/tmp/c-icon-test.png" });
  vision.probe = async () => [
    { meanRed: 0.59, meanGreen: 0.49, meanBlue: 0.38, meanSaturation: 0.27 },
    { meanRed: 0.59, meanGreen: 0.49, meanBlue: 0.39, meanSaturation: 0.26 },
    { meanRed: 0.66, meanGreen: 0.63, meanBlue: 0.62, meanSaturation: 0.10 }
  ];
  assert.equal(await vision.gameMouseCIconLit(), true);

  vision.probe = async () => [
    { meanRed: 0.66, meanGreen: 0.63, meanBlue: 0.62, meanSaturation: 0.10 },
    { meanRed: 0.58, meanGreen: 0.52, meanBlue: 0.50, meanSaturation: 0.16 },
    { meanRed: 0.60, meanGreen: 0.58, meanBlue: 0.59, meanSaturation: 0.11 }
  ];
  assert.equal(await vision.gameMouseCIconLit(), false);
});

test("C icon background contamination is not treated as yellow", async () => {
  const vision = new Vision({
    adb: {
      gameMouseCIcon: {
        probePoints: [
          { x: 1865, y: 1130 },
          { x: 1848, y: 1130 },
          { x: 1882, y: 1130 }
        ],
        minimumLitPoints: 2,
        redBlueDelta: 0.08,
        greenBlueDelta: 0.07,
        minimumSaturation: 0.20
      }
    },
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.captureSource = async () => ({ path: "/private/tmp/c-icon-warm-scene.png" });
  vision.probe = async () => [
    { meanRed: 0.66, meanGreen: 0.60, meanBlue: 0.51, meanSaturation: 0.17 },
    { meanRed: 0.63, meanGreen: 0.57, meanBlue: 0.48, meanSaturation: 0.18 },
    { meanRed: 0.70, meanGreen: 0.63, meanBlue: 0.56, meanSaturation: 0.19 }
  ];
  assert.equal(await vision.gameMouseCIconLit(), false);
});

test("staff advisor keeps the bottom role and never emits seat placeholders", async () => {
  const vision = new Vision(
    {
      vision: {},
      localVisionModel: { enabled: false }
    },
    {}
  );
  vision.advisor.extractStaff = async () => [
    { slot: "staff1", name: "萤萤空心菜", campTitle: "" },
    { slot: "staff2", name: "七晓白", campTitle: "#W圣之雪" },
    { slot: "mayor", name: "雨梦", campTitle: "" }
  ];

  assert.deepEqual(await vision.extractStaffRows("/private/tmp/staff.png"), [
    {
      roleKey: "staff-2",
      roleName: "#W圣之雪",
      memberName: "七晓白",
      campTitle: "#W圣之雪"
    },
    {
      roleKey: "mayor",
      roleName: "市长",
      memberName: "雨梦",
      campTitle: null
    }
  ]);
});

test("member table OCR starts at the identity column and excludes avatar artwork", async () => {
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: { mode: "fast", memberTableTimeoutSeconds: 2 },
    localVisionModel: { enabled: false }
  }, {});
  let ocrRegion = null;
  vision.captureSource = async () => ({ path: "/private/tmp/member-table.png" });
  vision.ocrRegion = async (_path, region) => {
    ocrRegion = region;
    return [];
  };

  const frame = await vision.captureTable("member-details", {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ]
  });

  assert.equal(frame.path, "/private/tmp/member-table.png");
  assert.equal(ocrRegion.left, 249.8);
  assert.equal(ocrRegion.right, 1800);
});

test("member table masks avatar, status, scene and sticky-row regions before OCR", async () => {
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: { mode: "fast", memberTableTimeoutSeconds: 2 },
    localVisionModel: { enabled: false }
  }, {
    async screenshot() {}
  });
  const masks = [];
  vision.captureSource = async () => ({ path: "/private/tmp/member-table.png" });
  vision.maskImage = async (path, region, label) => {
    masks.push({ path, region, label });
    return `/private/tmp/${label}.png`;
  };
  let ocrPath = null;
  vision.ocrRegion = async (path) => {
    ocrPath = path;
    return [];
  };

  const frame = await vision.captureTable("member-details", {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    avatarMaskRegion: { left: 115, top: 285, right: 250, bottom: 945 },
    onlineStateMaskRegion: { left: 1209, top: 285, right: 1370, bottom: 945 },
    sceneMaskRegion: { left: 1370, top: 285, right: 1563, bottom: 945 },
    fixedRowMaskRegion: { left: 115, top: 810, right: 1800, bottom: 945 },
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ]
  });

  assert.deepEqual(masks, [
    {
      path: "/private/tmp/member-table.png",
      region: { left: 115, top: 285, right: 250, bottom: 945 },
      label: "member-details-avatar-column"
    },
    {
      path: "/private/tmp/member-details-avatar-column.png",
      region: { left: 1209, top: 285, right: 1370, bottom: 945 },
      label: "member-details-online-state-column"
    },
    {
      path: "/private/tmp/member-details-online-state-column.png",
      region: { left: 1370, top: 285, right: 1563, bottom: 945 },
      label: "member-details-scene-column"
    },
    {
      path: "/private/tmp/member-details-scene-column.png",
      region: { left: 115, top: 810, right: 1800, bottom: 945 },
      label: "member-details-fixed-current-player-row"
    }
  ]);
  assert.equal(frame.path, "/private/tmp/member-details-fixed-current-player-row.png");
  assert.equal(ocrPath, frame.path);
  assert.deepEqual(frame.sourcePath, "/private/tmp/member-table.png");
});

test("member masks are scoped to member-details captures", async () => {
  const screenshotPaths = [];
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: { mode: "fast", memberTableTimeoutSeconds: 2 },
    localVisionModel: { enabled: false }
  }, {
    async screenshot(path) {
      screenshotPaths.push(path);
    }
  });
  let maskCount = 0;
  vision.maskImage = async () => {
    maskCount += 1;
    return "/private/tmp/staff-masked.png";
  };
  vision.ocrRegion = async () => [];

  const frame = await vision.captureTable("camp-staff", {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    avatarMaskRegion: { left: 115, top: 285, right: 250, bottom: 945 },
    onlineStateMaskRegion: { left: 1209, top: 285, right: 1370, bottom: 945 },
    sceneMaskRegion: { left: 1370, top: 285, right: 1563, bottom: 945 },
    fixedRowMaskRegion: { left: 115, top: 810, right: 1800, bottom: 945 },
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ]
  });

  assert.equal(maskCount, 0);
  assert.equal(frame.path, screenshotPaths[0]);
  assert.match(frame.path, /camp-staff\.png$/u);
});

test("member table OCR restores missing row slots from calibrated geometry", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 5, rowHeightPx: 95 }
  };
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  let pass = 0;
  vision.ocrRegion = async (_path, region) => {
    pass += 1;
    if (pass === 1) {
      return [
        { text: "成员一", x: 320, y: 315, width: 80, height: 24 },
        { text: "在线", x: 1200, y: 315, width: 40, height: 24 },
        { text: "成员二", x: 320, y: 410, width: 80, height: 24 },
        { text: "离线", x: 1200, y: 410, width: 40, height: 24 },
        { text: "成员三", x: 320, y: 505, width: 80, height: 24 },
        { text: "在线", x: 1200, y: 505, width: 40, height: 24 },
        { text: "成员五", x: 320, y: 695, width: 80, height: 24 },
        { text: "在线", x: 1200, y: 695, width: 40, height: 24 }
      ];
    }
    return region.top < 600
      ? [{ text: "成员四", x: 320, y: 600, width: 80, height: 24 }]
      : [];
  };

  const rows = await vision.extractTableRows(
    "/private/tmp/member-table.png",
    definition,
    "member-details-test"
  );

  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.name), [
    "成员一",
    "成员二",
    "成员三",
    "成员四",
    "成员五"
  ]);
  assert.deepEqual(rows.map((row) => row.campTitle), [null, null, null, null, null]);
});

test("member identity keeps the first OCR line as the player name", () => {
  assert.deepEqual(
    inferMemberIdentity([
      { text: "青在\n营地助手", x: 100, y: 300 },
      { text: "称号", x: 100, y: 335 }
    ]),
    { name: "青在", campTitle: "营地助手 称号" }
  );
  assert.deepEqual(
    inferMemberIdentity(
      [{ text: "#W月之歌", x: 100, y: 340, width: 100, height: 20 }],
      { includeCampTitle: false, nameBaselineY: 315, maxNameOffset: 20 }
    ),
    { name: "", campTitle: "" }
  );
  assert.equal(isPlausibleMemberName("COSGH"), false);
  assert.equal(isPlausibleMemberName("青在✨"), true);
  assert.equal(isPlausibleMemberName("✨"), true);
  assert.equal(isPlausibleMemberName("#"), true);
});

test("member identity keeps pure symbol names and drops trailing identity badges", () => {
  assert.deepEqual(
    inferMemberIdentity([
      { text: "-😊-", x: 100, y: 300, width: 80, height: 24 },
      { text: "启航", x: 230, y: 300, width: 48, height: 24 },
      { text: "回归", x: 280, y: 300, width: 48, height: 24 }
    ]),
    { name: "-😊-", campTitle: "" }
  );
  assert.equal(isMemberIdentityBadge("先行者"), true);
  assert.equal(isMemberIdentityBadge("R"), true);
  assert.equal(isPlausibleMemberName("✨"), true);
});

test("avatar year OCR variants are rejected before profile normalization", () => {
  for (const value of ["2025", "20251", "D025", "O025", "2O25"]) {
    assert.equal(isMemberAvatarArtifact(value), true, value);
    assert.equal(isPlausibleMemberName(value), false, value);
  }
  assert.equal(isMemberAvatarArtifact("-😊-"), false);
});

test("member profession text cannot replace a missing symbol-only name", () => {
  assert.equal(
    isMemberProfessionArtifact("特级步枪兵王", "特级步枪兵王"),
    true
  );
  assert.equal(
    isMemberProfessionArtifact("模型0号", "模型0号"),
    false
  );
  assert.equal(isMemberProfessionArtifact("-😊-", "特级步枪兵王"), false);
  assert.equal(isPlausibleMemberName("-😊-"), true);
  assert.equal(isMemberSymbolOnlyName("-😊-"), true);
  assert.equal(isMemberSymbolOnlyName("-😊·"), true);
  assert.equal(isMemberSymbolOnlyName("特级步枪兵王"), false);
});

test("member row recovery preserves a pure-symbol name at every visible row position", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 5, rowHeightPx: 95 }
  };
  const imagePath = "/private/tmp/member-symbol-position.png";
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  for (const missingIndex of [0, 1, 2, 3, 4]) {
    const vision = new Vision({
      adb: { screenWidth: 1920, screenHeight: 1200 },
      vision: {},
      localVisionModel: { enabled: true, transport: "http" }
    }, {});
    vision.advisor.extractMemberName = async () => "-😊·";
    vision.ocrRegion = async (_path, region) => {
      if (region.left < 700 && region.right > 700) {
        return Array.from({ length: 5 }, (_, index) => {
          const y = 315 + index * 95;
          return [
            { text: index === missingIndex ? "" : `成员${index + 1}`, x: 320, y, width: 70, height: 24 },
            { text: "特级步枪兵王", x: 700, y, width: 180, height: 24 },
            { text: "在线", x: 1200, y, width: 40, height: 24 }
          ];
        }).flat().filter((item) => item.text);
      }
      return [];
    };

    const rows = await vision.extractTableRows(
      imagePath,
      definition,
      `member-symbol-position-${missingIndex + 1}`
    );

    assert.equal(rows.length, 5, `missing row ${missingIndex + 1}`);
    assert.equal(rows[missingIndex].name, "-😊·", `missing row ${missingIndex + 1}`);
  }
});

test("member table keeps the native tail row when Qwen returns only four rows", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 5, rowHeightPx: 95 }
  };
  const imagePath = "/private/tmp/member-qwen-four-rows.png";
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: {},
    localVisionModel: { enabled: true, transport: "http" }
  }, {});
  vision.ocrRegion = async () => Array.from({ length: 5 }, (_, index) => ({
    text: `原生${index + 1}`,
    x: 320,
    y: 315 + index * 95,
    width: 80,
    height: 24
  }));
  vision.advisor.extractMemberDetails = async () =>
    Array.from({ length: 4 }, (_, index) => ({
      row: index + 1,
      name: `原生${["一", "二", "三", "四"][index]}`
    }));

  const rows = await vision.extractTableRows(
    imagePath,
    definition,
    "member-qwen-four-rows",
    undefined,
    { forceMemberAdvisor: true, forceLocalVision: true }
  );

  assert.deepEqual(rows.map((row) => row.name), [
    "原生一",
    "原生二",
    "原生三",
    "原生四",
    "原生5"
  ]);
});

test("member vision keeps a decorated same-core name separate from a plain name", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 2, rowHeightPx: 95 }
  };
  const imagePath = "/private/tmp/member-decorated-same-core.png";
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: {},
    localVisionModel: { enabled: true, transport: "http" }
  }, {});
  vision.ocrRegion = async (_path, region) => {
    if (region.left < 700 && region.right > 700) {
      return [
        { text: "*慕离米", x: 320, y: 315, width: 100, height: 24 },
        { text: "特级步枪兵王", x: 700, y: 315, width: 180, height: 24 },
        { text: "在线", x: 1200, y: 315, width: 40, height: 24 },
        { text: "慕离", x: 320, y: 410, width: 80, height: 24 },
        { text: "特级步枪兵王", x: 700, y: 410, width: 180, height: 24 },
        { text: "在线", x: 1200, y: 410, width: 40, height: 24 }
      ];
    }
    return [];
  };
  vision.advisor.extractMemberDetails = async () => [
    { row: 1, name: "慕离" },
    { row: 2, name: "慕离" }
  ];
  vision.advisor.extractMemberName = async () => "慕离";

  const rows = await vision.extractTableRows(
    imagePath,
    definition,
    "member-decorated-same-core",
    undefined,
    { forceMemberAdvisor: true, forceLocalVision: true }
  );

  assert.deepEqual(rows.map((row) => row.name), ["✿慕离✿", "慕离"]);
});

test("member vision applies AI and symbol repair to roommate names", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 500 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 2, rowHeightPx: 95 }
  };
  const imagePath = "/private/tmp/member-roommate-symbols.png";
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: {},
    localVisionModel: { enabled: true, transport: "http" }
  }, {});
  vision.ocrRegion = async (_path, region) => {
    if (region.left < 700 && region.right > 700) {
      return [
        { text: "玩家一", x: 320, y: 315, width: 80, height: 24 },
        { text: "特级步枪兵王", x: 700, y: 315, width: 180, height: 24 },
        { text: "在线", x: 1200, y: 315, width: 40, height: 24 },
        { text: "※橘悠悠米", x: 1600, y: 315, width: 120, height: 24 },
        { text: "玩家二", x: 320, y: 410, width: 80, height: 24 },
        { text: "特级步枪兵王", x: 700, y: 410, width: 180, height: 24 },
        { text: "在线", x: 1200, y: 410, width: 40, height: 24 },
        { text: "踏月追星河卒", x: 1600, y: 410, width: 150, height: 24 }
      ];
    }
    return [];
  };
  let advisorCalled = false;
  vision.advisor.extractMemberDetails = async () => {
    advisorCalled = true;
    return [
      { row: 1, name: "玩家一", roommateName: "橘悠悠" },
      { row: 2, name: "玩家二", roommateName: "踏月追星河" }
    ];
  };

  const rows = await vision.extractTableRows(
    imagePath,
    definition,
    "member-roommate-symbols"
  );

  assert.equal(advisorCalled, true);
  assert.deepEqual(rows.map((row) => row.roommateName), [
    "❀橘悠悠❀",
    "踏月追星河✨"
  ]);
});

test("member vision keeps an unused native name when Qwen collapses numeric rows", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 2, rowHeightPx: 95 }
  };
  const imagePath = "/private/tmp/member-numeric-collision.png";
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: {},
    localVisionModel: { enabled: true, transport: "http" }
  }, {});
  vision.ocrRegion = async () => [
    { text: "模型0号", x: 320, y: 315, width: 90, height: 24 },
    { text: "模型2号", x: 320, y: 410, width: 90, height: 24 },
    { text: "在线", x: 1200, y: 315, width: 40, height: 24 },
    { text: "在线", x: 1200, y: 410, width: 40, height: 24 }
  ];
  vision.advisor.extractMemberDetails = async () => [
    { row: 1, name: "模型2号" },
    { row: 2, name: "模型2号" }
  ];
  vision.advisor.extractMemberName = async () => "";

  const rows = await vision.extractTableRows(
    imagePath,
    definition,
    "member-numeric-collision",
    undefined,
    { forceMemberAdvisor: true, forceLocalVision: true }
  );

  assert.deepEqual(rows.map((row) => row.name), ["模型0号", "模型2号"]);
});

test("member vision repairs common OCR artifacts without treating badges as names", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 5, rowHeightPx: 95 }
  };
  const imagePath = "/private/tmp/member-ocr-artifacts.png";
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: {},
    localVisionModel: { enabled: true, transport: "http" }
  }, {});
  vision.ocrRegion = async () => [
    { text: "*慕离米", x: 320, y: 315, width: 100, height: 24 },
    { text: "※林昭宓米", x: 320, y: 410, width: 120, height: 24 },
    { text: "十^楠^卒", x: 320, y: 505, width: 100, height: 24 },
    { text: "独爱&心", x: 320, y: 600, width: 100, height: 24 },
    { text: "※碎碎念楽", x: 320, y: 695, width: 120, height: 24 }
  ];
  vision.advisor.extractMemberDetails = async () => [
    { row: 1, name: "慕离" },
    { row: 2, name: "林昭宓" },
    { row: 3, name: "✨^楠^✨" },
    { row: 4, name: "独爱" },
    { row: 5, name: "碎碎念" }
  ];
  vision.advisor.extractMemberName = async () => "";

  const rows = await vision.extractTableRows(
    imagePath,
    definition,
    "member-ocr-artifacts",
    undefined,
    { forceMemberAdvisor: true, forceLocalVision: true }
  );

  assert.deepEqual(rows.map((row) => row.name), [
    "✿慕离✿",
    "❀林昭宓❀",
    "✨^楠^✨",
    "独爱",
    "❀碎碎念❀"
  ]);
});

test("member vision repairs screenshot-confirmed symbols and badge noise", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 1300 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 10, rowHeightPx: 95 }
  };
  const imagePath = "/private/tmp/member-screenshot-symbol-artifacts.png";
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: {},
    localVisionModel: { enabled: true, transport: "http" }
  }, {});
  const nativeNames = [
    "中野三玖（",
    "條晔超大&",
    "模型0号&壓",
    "9苏喂G",
    "※林昭宓米",
    "南街九尾狐'？",
    "#^楠^+",
    "海盗猫猫★",
    "q纸鸢5）",
    "甲乙卒"
  ];
  vision.ocrRegion = async () => nativeNames.flatMap((name, index) => [
    { text: name, x: 320, y: 315 + index * 95, width: 120, height: 24 },
    { text: "特级步枪兵王", x: 700, y: 315 + index * 95, width: 180, height: 24 },
    { text: "在线", x: 1200, y: 315 + index * 95, width: 40, height: 24 }
  ]);
  vision.advisor.extractMemberDetails = async () => [
    { row: 1, name: "中野三玖" },
    { row: 2, name: "條晔超大" },
    { row: 3, name: "模型0号" },
    { row: 4, name: "苏喂" },
    { row: 5, name: "林昭宓" },
    { row: 6, name: "南街九尾狐" },
    { row: 7, name: "✨★^楠^✨" },
    { row: 8, name: "海盗猫猫" },
    { row: 9, name: "《纸鸢”）" },
    { row: 10, name: "甲乙" }
  ];
  vision.advisor.extractMemberName = async () => "";

  const rows = await vision.extractTableRows(
    imagePath,
    definition,
    "member-screenshot-symbol-artifacts",
    undefined,
    { forceMemberAdvisor: true, forceLocalVision: true }
  );

  assert.deepEqual(rows.map((row) => row.name), [
    "♥中野三玖♥",
    "條晔超大",
    "模型0号",
    "༺苏喂༻",
    "❀林昭宓❀",
    "南街九尾狐♡",
    "✨^楠^✨",
    "海盗猫猫✨",
    "༺纸鸢༻",
    "甲乙✨"
  ]);
});

test("member vision restores the malformed sparkle pair around 楠", async () => {
  const definition = {
    region: { left: 115, top: 285, right: 1800, bottom: 500 },
    rowAnchorTop: 315,
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ],
    pagination: { rowsPerPage: 1, rowHeightPx: 95 }
  };
  const imagePath = "/private/tmp/member-malformed-sparkle.png";
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: {},
    localVisionModel: { enabled: true, transport: "http" }
  }, {});
  vision.ocrRegion = async () => [
    { text: "★へ楠^平", x: 320, y: 315, width: 120, height: 24 },
    { text: "在线", x: 1200, y: 315, width: 40, height: 24 }
  ];
  vision.advisor.extractMemberDetails = async () => [
    { row: 1, name: "★へ楠^平" }
  ];
  vision.advisor.extractMemberName = async () => "★へ楠^平";

  const rows = await vision.extractTableRows(
    imagePath,
    definition,
    "member-malformed-sparkle",
    undefined,
    { forceMemberAdvisor: true, forceLocalVision: true }
  );

  assert.deepEqual(rows.map((row) => row.name), ["✨^楠^✨"]);
});

test("macOS 27 bottom-edge crops shift inward instead of silently returning the full frame", () => {
  assert.deepEqual(
    safeSipsCropRegion(
      { left: 0, top: 980, right: 760, bottom: 1200 },
      1920,
      1200
    ),
    { left: 0, top: 979, width: 760, height: 220, adjusted: true }
  );
  assert.deepEqual(
    safeSipsCropRegion(
      { left: 100, top: 200, right: 500, bottom: 600 },
      1920,
      1200
    ),
    { left: 100, top: 200, width: 400, height: 400, adjusted: false }
  );
});

test("parses total members from the fraction denominator", () => {
  assert.equal(
    parsePopulationCapacity(
      [{ text: "9/96", x: 350 }, { text: "（", x: 420 }],
      110
    ),
    96
  );
  assert.equal(
    parsePopulationCapacity([{ text: "102/110", x: 350 }], 110),
    110
  );
  assert.deepEqual(
    parsePopulationFraction([{ text: "4/93", x: 350 }], 110, {
      minimumCapacity: 1
    }),
    { current: 4, capacity: 93 }
  );
  assert.deepEqual(
    parsePopulationFraction([{ text: "0/0", x: 490 }], 10, {
      minimumCapacity: 0
    }),
    { current: 0, capacity: 0 }
  );
});

test("member header total accepts 0/0 sailing citizens without fallback contamination", async () => {
  const vision = new Vision({
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.capture = async () => ({ path: "/private/tmp/member-header.png" });
  vision.ocrRegion = async (_path, _region, label) =>
    label.startsWith("member-count-")
      ? [{ text: "4/93", x: 350 }]
      : [{ text: "0/0", x: 490 }];

  assert.deepEqual(await vision.readMemberExpectedBreakdown(), {
    formalCurrent: 4,
    formalTotal: 93,
    sailingCurrent: 0,
    sailingTotal: 0,
    total: 93
  });
  assert.equal(await vision.readMemberExpectedTotal(), 93);
});

test("member header total includes sailing citizens for pagination", async () => {
  const vision = new Vision({
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.capture = async () => ({ path: "/private/tmp/member-header-101.png" });
  vision.ocrRegion = async (_path, _region, label) =>
    label.startsWith("member-count-")
      ? [{ text: "9/100", x: 350 }]
      : [{ text: "0/1", x: 490 }];

  assert.deepEqual(await vision.readMemberExpectedBreakdown(), {
    formalCurrent: 9,
    formalTotal: 100,
    sailingCurrent: 0,
    sailingTotal: 1,
    total: 101
  });
  assert.equal(await vision.readMemberExpectedTotal(), 101);
});

test("accepts zero online citizens and split OCR fragments", () => {
  assert.equal(
    parsePopulationCapacity(
      [
        { text: "0/", x: 475 },
        { text: "5（", x: 500 }
      ],
      10
    ),
    5
  );
  assert.equal(
    parsePopulationCapacity([{ text: "6／10", x: 475 }], 10),
    10
  );
});

test("sailing population parsing never absorbs the adjacent info icon", () => {
  assert.deepEqual(
    parsePopulationFraction(
      [
        { text: "0/0", x: 475 },
        { text: "i", x: 515 },
        { text: "1", x: 540 }
      ],
      10,
      { minimumCapacity: 0 }
    ),
    { current: 0, capacity: 0 }
  );
  assert.deepEqual(
    parsePopulationFraction([{ text: "0/101", x: 475 }], 10, {
      minimumCapacity: 0
    }),
    { current: 0, capacity: 10 }
  );
  assert.deepEqual(
    parsePopulationFraction([{ text: "10/101", x: 475 }], 10, {
      minimumCapacity: 0
    }),
    { current: 10, capacity: 10 }
  );
  assert.equal(
    parsePopulationFraction(
      [
        { text: "0i", x: 475 },
        { text: "1i", x: 500 },
        { text: "2i", x: 525 }
      ],
      10,
      { minimumCapacity: 0 }
    ),
    null
  );
  assert.deepEqual(
    parsePopulationFraction(
      [{ text: "0/", x: 475 }, { text: "0", x: 500 }, { text: "i", x: 525 }],
      10,
      { minimumCapacity: 0 }
    ),
    { current: 0, capacity: 0 }
  );
});

test("rejects icon-contaminated and impossible counts", () => {
  assert.equal(
    parsePopulationCapacity([{ text: "全部成员89/96", x: 100 }], 10),
    null
  );
  assert.equal(
    parsePopulationCapacity([{ text: "12/10", x: 475 }], 10),
    null
  );
});
