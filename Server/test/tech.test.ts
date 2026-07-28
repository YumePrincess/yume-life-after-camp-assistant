import { describe, expect, it } from "vitest";
import type { TechnologyConfig, VoteOption } from "../src/domain";
import { BUILT_IN_TECHNOLOGY_CATALOG } from "../src/built-in-technology-catalog";
import { buildTechnologyPlan } from "../src/tech";

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
  limits: { core: 2, general: 1 }
};

describe("buildTechnologyPlan", () => {
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
});

describe("built-in technology catalog", () => {
  it("contains the verified 19 agriculture, 16 industry and 18 military items", () => {
    const count = (category: string) =>
      BUILT_IN_TECHNOLOGY_CATALOG.filter(
        (item) => item.category === category
      ).length;
    expect(BUILT_IN_TECHNOLOGY_CATALOG).toHaveLength(53);
    expect(count("agriculture")).toBe(19);
    expect(count("industry")).toBe(16);
    expect(count("military")).toBe(18);
    expect(
      new Set(BUILT_IN_TECHNOLOGY_CATALOG.map((item) => item.key)).size
    ).toBe(53);
    expect(
      BUILT_IN_TECHNOLOGY_CATALOG.every(
        (item) => item.iconUrl && item.description
      )
    ).toBe(true);
  });
});
