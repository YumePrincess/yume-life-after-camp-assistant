import { describe, expect, it } from "vitest";
import type { TechnologyConfig, VoteOption } from "../src/domain";
import { BUILT_IN_TECHNOLOGY_CATALOG } from "../plugins/technology/catalog";
import {
  buildTechnologyPlan,
  fixedTechnologyKeysForDate,
  normalizeBallotSelections,
  prerequisiteNameForTechnology,
  technologyCatalogWithPrerequisites
} from "../src/tech";
import { validateTechnologyConfig } from "../src/validate";

function technology(
  key: string,
  lane: "core" | "general",
  category: "military" | "agriculture" | "industry",
  sortOrder: number
) {
  return {
    key,
    name: key,
    category,
    lane,
    enabledForVoting: true,
    sortOrder,
    uiLabel: key
  } as const;
}

const technologyConfig: TechnologyConfig = {
  catalog: [
    {
      key: "fixed-core",
      name: "固定军事",
      category: "military",
      lane: "core",
      enabledForVoting: false,
      sortOrder: 0,
      uiLabel: "固定军事"
    },
    {
      key: "wrong-core",
      name: "农业核心",
      category: "agriculture",
      lane: "core",
      enabledForVoting: true,
      sortOrder: 1,
      uiLabel: "农业核心"
    },
    {
      key: "vote-core",
      name: "票选军事",
      category: "military",
      lane: "core",
      enabledForVoting: true,
      sortOrder: 2,
      uiLabel: "票选军事"
    },
    {
      key: "general-a",
      name: "农业通用",
      category: "agriculture",
      lane: "general",
      enabledForVoting: true,
      sortOrder: 3,
      uiLabel: "农业通用"
    }
  ],
  fixedByWeekday: {
    "1": ["fixed-core"],
    "2": [],
    "3": [],
    "4": [],
    "5": [],
    "6": [],
    "7": []
  },
  fixedByDate: {},
  voteLimit: 6,
  limits: { core: 2, general: 1 }
};

describe("buildTechnologyPlan", () => {
  it("resolves weekday and skipped-day presets within their inclusive range", () => {
    const config: TechnologyConfig = {
      ...technologyConfig,
      fixedPresets: [
        {
          id: "weekday",
          mode: "weekday",
          startDate: "2026-06-01",
          endDate: "2026-06-10",
          weekdays: [1, 3],
          technologyKeys: ["fixed-core"]
        },
        {
          id: "interval",
          mode: "interval",
          startDate: "2026-06-01",
          endDate: "2026-06-07",
          intervalDays: 1,
          technologyKeys: ["general-a"]
        }
      ]
    };

    expect(fixedTechnologyKeysForDate(config, "2026-06-01")).toEqual([
      "fixed-core",
      "general-a"
    ]);
    expect(fixedTechnologyKeysForDate(config, "2026-06-02")).toEqual([]);
    expect(fixedTechnologyKeysForDate(config, "2026-06-03")).toEqual([
      "fixed-core",
      "general-a"
    ]);
    expect(fixedTechnologyKeysForDate(config, "2026-06-08")).toEqual([
      "fixed-core"
    ]);
    expect(fixedTechnologyKeysForDate(config, "2026-06-07")).toEqual([
      "general-a"
    ]);
    expect(fixedTechnologyKeysForDate(config, "2026-06-10")).toEqual([
      "fixed-core"
    ]);
    expect(fixedTechnologyKeysForDate(config, "2026-06-11")).toEqual([]);
  });

  it("gives an exact-date preset priority over recurring presets", () => {
    const config: TechnologyConfig = {
      ...technologyConfig,
      fixedPresets: [
        {
          id: "weekday",
          mode: "weekday",
          startDate: "2026-06-01",
          endDate: null,
          weekdays: [1],
          technologyKeys: ["fixed-core"]
        },
        {
          id: "date",
          mode: "date",
          date: "2026-06-01",
          technologyKeys: ["vote-core"]
        }
      ]
    };

    expect(fixedTechnologyKeysForDate(config, "2026-06-01")).toEqual([
      "vote-core"
    ]);
  });

  it("keeps fixed technologies ahead of vote fill within each row limit", () => {
    const config: TechnologyConfig = {
      ...technologyConfig,
      fixedPresets: [
        {
          id: "interval",
          mode: "interval",
          startDate: "2026-06-01",
          endDate: "2026-06-03",
          intervalDays: 1,
          technologyKeys: ["fixed-core"]
        }
      ],
      limits: { core: 2, general: 1 }
    };
    const plan = buildTechnologyPlan({
      targetDate: "2026-06-03",
      currentCampType: "military",
      technologyConfig: config,
      voteOptions: config.catalog.map((item) => ({
        ...item,
        votes: item.key === "wrong-core" ? 99 : item.key === "vote-core" ? 5 : 4
      }))
    });

    expect(plan.core.map((item) => item.key)).toEqual([
      "fixed-core",
      "vote-core"
    ]);
    expect(plan.general.map((item) => item.key)).toEqual(["wrong-core"]);
  });

  it("defaults both row capacities to six for legacy configurations", () => {
    const legacy = { ...technologyConfig, limits: undefined };
    expect(validateTechnologyConfig(legacy).limits).toEqual({
      core: 6,
      general: 6
    });
  });

  it("rejects an empty ballot instead of treating it as a withdrawal", () => {
    const result = normalizeBallotSelections({
      selections: [],
      catalog: technologyConfig.catalog,
      allowedKeys: new Set(technologyConfig.catalog.map((item) => item.key))
    });

    expect(result.selections).toEqual([]);
    expect(result.error).toBe("请至少选择一项科技");
  });

  it("enforces the configured per-person vote limit", () => {
    const result = normalizeBallotSelections({
      selections: ["wrong-core", "vote-core", "general-a"],
      catalog: technologyConfig.catalog,
      allowedKeys: new Set(technologyConfig.catalog.map((item) => item.key)),
      maximum: 2
    });
    expect(result.selections).toEqual([]);
    expect(result.error).toContain("超过 2 票");
  });

  it("keeps fixed tech and fills remaining slots by vote", () => {
    const voteOptions: VoteOption[] = technologyConfig.catalog.map((item) => ({
      ...item,
      votes: item.key === "wrong-core" ? 99 : item.key === "vote-core" ? 5 : 4
    }));
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-27",
      currentCampType: "military",
      technologyConfig,
      voteOptions
    });
    expect(plan.core.map((item) => item.key)).toEqual(["fixed-core", "vote-core"]);
    expect(plan.general.map((item) => item.key)).toEqual(["wrong-core"]);
  });

  it("does not apply fixed or voted technologies beyond a zero row capacity", () => {
    const config: TechnologyConfig = {
      ...technologyConfig,
      fixedByDate: { "2026-07-27": ["fixed-core"] },
      limits: { core: 0, general: 0 }
    };
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-27",
      currentCampType: "military",
      technologyConfig: config,
      voteOptions: config.catalog.map((item) => ({ ...item, votes: 10 }))
    });

    expect(plan.core).toEqual([]);
    expect(plan.general).toEqual([]);
    expect(plan.rejectedFixed).toEqual([
      {
        key: "fixed-core",
        reason: "固定科技及其前置科技超过该行开启上限"
      }
    ]);
  });

  it("keeps the plan within four configured slots while the physical row remains six slots", () => {
    const core = Array.from({ length: 6 }, (_, index) =>
      technology(`limited-core-${index + 1}`, "core", "agriculture", index)
    );
    const general = Array.from({ length: 6 }, (_, index) =>
      technology(`limited-general-${index + 1}`, "general", "military", index + 10)
    );
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-29",
      currentCampType: "agriculture",
      technologyConfig: {
        catalog: [...core, ...general],
        fixedByWeekday: {
          "1": [],
          "2": [],
          "3": [],
          "4": [],
          "5": [],
          "6": [],
          "7": []
        },
        fixedByDate: {},
        voteLimit: 6,
        limits: { core: 4, general: 4 }
      },
      voteOptions: [...core, ...general].map((item, index) => ({
        ...item,
        votes: 100 - index
      }))
    });

    expect(plan.core).toHaveLength(4);
    expect(plan.general).toHaveLength(4);
    expect(plan.core.map((item) => item.key)).toEqual([
      "limited-core-1",
      "limited-core-2",
      "limited-core-3",
      "limited-core-4"
    ]);
    expect(plan.general.map((item) => item.key)).toEqual([
      "limited-general-1",
      "limited-general-2",
      "limited-general-3",
      "limited-general-4"
    ]);
  });

  it("fills six agricultural first-row technologies and six other technologies", () => {
    const agriculture = Array.from({ length: 7 }, (_, index) =>
      technology(`agriculture-${index + 1}`, "core", "agriculture", index)
    );
    const other = Array.from({ length: 7 }, (_, index) =>
      technology(`other-${index + 1}`, "general", "military", index + 20)
    );
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-29",
      currentCampType: "agriculture",
      technologyConfig: {
        catalog: [...agriculture, ...other],
        fixedByWeekday: {
          "1": [],
          "2": [],
          "3": [],
          "4": [],
          "5": [],
          "6": [],
          "7": []
        },
        fixedByDate: {},
        voteLimit: 6,
        limits: { core: 6, general: 6 }
      },
      voteOptions: [...agriculture, ...other].map((item, index) => ({
        ...item,
        votes: 100 - index
      }))
    });

    expect(plan.clearExistingFirst).toBe(true);
    expect(plan.core).toHaveLength(6);
    expect(plan.general).toHaveLength(6);
    expect(plan.core.every((item) => item.category === "agriculture")).toBe(true);
  });

  it("uses independent date-specific fixed technology before weekday defaults", () => {
    const config: TechnologyConfig = {
      ...technologyConfig,
      fixedByDate: { "2026-07-27": ["vote-core"] }
    };
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-27",
      currentCampType: "military",
      technologyConfig: config,
      voteOptions: []
    });
    expect(plan.core.map((item) => item.key)).toEqual(["vote-core"]);
  });

  it("keeps both prediction rows empty without fixed technology or votes", () => {
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-28",
      currentCampType: "military",
      technologyConfig,
      voteOptions: technologyConfig.catalog.map((item) => ({
        ...item,
        votes: 0
      }))
    });
    expect(plan.core).toEqual([]);
    expect(plan.general).toEqual([]);
  });
});

describe("built-in technology catalog", () => {
  it("contains the verified 22 agriculture, 16 industry and 18 military items", () => {
    const count = (category: string) =>
      BUILT_IN_TECHNOLOGY_CATALOG.filter(
        (item) => item.category === category
      ).length;
    expect(BUILT_IN_TECHNOLOGY_CATALOG).toHaveLength(56);
    expect(count("agriculture")).toBe(22);
    expect(count("industry")).toBe(16);
    expect(count("military")).toBe(18);
    expect(
      new Set(BUILT_IN_TECHNOLOGY_CATALOG.map((item) => item.key)).size
    ).toBe(56);
    expect(
      BUILT_IN_TECHNOLOGY_CATALOG.every(
        (item) => item.iconUrl && item.description
      )
    ).toBe(true);
    expect(
      BUILT_IN_TECHNOLOGY_CATALOG.find(
        (item) => item.key === "tech-7c5e9a4d3b2f1e6087ab"
      )
    ).toMatchObject({
      name: "采购优惠",
      category: "agriculture",
      lane: "core",
      enabledForVoting: true,
      sortOrder: 2
    });
    expect(
      [...BUILT_IN_TECHNOLOGY_CATALOG]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => item.sortOrder)
    ).toEqual(Array.from({ length: 56 }, (_, index) => index));
    expect(
      BUILT_IN_TECHNOLOGY_CATALOG.find(
        (item) => item.key === "tech-c44f0496491a0c867687"
      )
    ).toMatchObject({
      name: "资源收购商",
      description: "莱文市郊的杰克每天会用500金条收购绿色以上的物资。",
      category: "agriculture",
      lane: "core",
      enabledForVoting: true,
      sortOrder: 5,
      uiLabel: "资源收购商",
      iconUrl: "/images/technology/tech-c44f0496491a0c867687.png"
    });
  });

  it("emits the purchase discount OCR label and asset in the Agent plan", () => {
    const purchaseDiscount = BUILT_IN_TECHNOLOGY_CATALOG.find(
      (item) => item.key === "tech-7c5e9a4d3b2f1e6087ab"
    );
    expect(purchaseDiscount).toBeDefined();
    const plan = buildTechnologyPlan({
      targetDate: "2026-08-24",
      currentCampType: "agriculture",
      technologyConfig: {
        catalog: BUILT_IN_TECHNOLOGY_CATALOG,
        fixedByWeekday: {
          "1": [],
          "2": [],
          "3": [],
          "4": [],
          "5": [],
          "6": [],
          "7": []
        },
        fixedByDate: {},
        voteLimit: 6,
        limits: { core: 6, general: 6 }
      },
      voteOptions: [{ ...purchaseDiscount!, votes: 1 }]
    });
    expect(plan.core).toEqual([
      expect.objectContaining({
        key: "tech-7c5e9a4d3b2f1e6087ab",
        uiLabel: "采购优惠",
        iconUrl: "/images/technology/tech-7c5e9a4d3b2f1e6087ab.png"
      })
    ]);
  });

  it("resolves the technology named in full-width or half-width parentheses", () => {
    expect(prerequisiteNameForTechnology("加速印刷（墙纸印刷师）")).toBe(
      "墙纸印刷师"
    );
    expect(prerequisiteNameForTechnology("加速印刷(墙纸印刷师)")).toBe(
      "墙纸印刷师"
    );
    expect(prerequisiteNameForTechnology("墙纸印刷师")).toBeNull();

    const catalog = technologyCatalogWithPrerequisites(
      BUILT_IN_TECHNOLOGY_CATALOG
    );
    const acceleratedPrinting = catalog.find(
      (item) => item.name === "加速印刷（墙纸印刷师）"
    );
    const printer = catalog.find((item) => item.name === "墙纸印刷师");
    expect(acceleratedPrinting?.prerequisiteKey).toBe(printer?.key);
    expect(acceleratedPrinting?.prerequisiteName).toBe("墙纸印刷师");
  });
});

describe("technology prerequisites", () => {
  const prerequisite = {
    ...technology("prerequisite", "core", "agriculture", 2),
    name: "前置科技"
  };
  const dependent = {
    ...technology("dependent", "core", "agriculture", 1),
    name: "后置科技（前置科技）"
  };
  const next = {
    ...technology("next", "core", "agriculture", 3),
    name: "顺延科技"
  };

  function config(limit = 6): TechnologyConfig {
    return {
      catalog: [dependent, prerequisite, next],
      fixedByWeekday: {
        "1": [],
        "2": [],
        "3": [],
        "4": [],
        "5": [],
        "6": [],
        "7": []
      },
      fixedByDate: {},
      voteLimit: 6,
      limits: { core: limit, general: 6 }
    };
  }

  it("forces the prerequisite into a ballot selection", () => {
    expect(
      normalizeBallotSelections({
        selections: ["dependent"],
        catalog: config().catalog,
        allowedKeys: new Set(["dependent", "prerequisite", "next"])
      })
    ).toEqual({ selections: ["prerequisite", "dependent"] });
  });

  it("rejects a forced prerequisite when the ballot would exceed six votes", () => {
    const extras = Array.from({ length: 5 }, (_, index) =>
      technology(`extra-${index}`, "general", "military", index + 10)
    );
    const result = normalizeBallotSelections({
      selections: [...extras.map((item) => item.key), "dependent"],
      catalog: [...config().catalog, ...extras],
      allowedKeys: new Set([
        "dependent",
        "prerequisite",
        ...extras.map((item) => item.key)
      ])
    });
    expect(result.selections).toEqual([]);
    expect(result.error).toContain("超过 6 票");
  });

  it("only opens the prerequisite when the dependent has fewer votes", () => {
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-29",
      currentCampType: "agriculture",
      technologyConfig: config(2),
      voteOptions: [
        { ...dependent, votes: 9 },
        { ...prerequisite, votes: 10 },
        { ...next, votes: 8 }
      ]
    });
    expect(plan.core.map((item) => item.key)).toEqual([
      "prerequisite",
      "next"
    ]);
  });

  it("opens a dependent and prerequisite atomically when both fit", () => {
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-29",
      currentCampType: "agriculture",
      technologyConfig: config(2),
      voteOptions: [
        { ...dependent, votes: 10 },
        { ...prerequisite, votes: 9 },
        { ...next, votes: 8 }
      ]
    });
    expect(plan.core.map((item) => item.key)).toEqual([
      "prerequisite",
      "dependent"
    ]);
  });

  it("skips both members of a pair that cannot fit and advances to the next vote", () => {
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-29",
      currentCampType: "agriculture",
      technologyConfig: config(1),
      voteOptions: [
        { ...dependent, votes: 10 },
        { ...prerequisite, votes: 9 },
        { ...next, votes: 8 }
      ]
    });
    expect(plan.core.map((item) => item.key)).toEqual(["next"]);
  });

  it("automatically places a fixed technology prerequisite first", () => {
    const technologyConfig = config(2);
    technologyConfig.fixedByDate["2026-07-29"] = ["dependent"];
    const plan = buildTechnologyPlan({
      targetDate: "2026-07-29",
      currentCampType: "agriculture",
      technologyConfig,
      voteOptions: []
    });
    expect(plan.core.map((item) => item.key)).toEqual([
      "prerequisite",
      "dependent"
    ]);
  });
});
