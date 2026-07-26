import { describe, expect, it } from "vitest";
import type { TechnologyConfig, VoteOption } from "../src/domain";
import { buildTechnologyPlan } from "../src/tech";

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
    expect(plan.general.map((item) => item.key)).toEqual(["general-a"]);
  });
});
