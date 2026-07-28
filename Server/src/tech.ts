import type {
  TechnologyConfig,
  TechnologyDefinition,
  TechnologyPlan,
  VoteOption
} from "./domain";
import { weekdayForDateKey } from "./time";

function byVotesThenOrder(a: VoteOption, b: VoteOption): number {
  return b.votes - a.votes || a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);
}

export function buildTechnologyPlan(input: {
  targetDate: string;
  currentCampType: string;
  technologyConfig: TechnologyConfig;
  voteOptions: VoteOption[];
  generatedAt?: string;
}): TechnologyPlan {
  const { targetDate, currentCampType, technologyConfig } = input;
  const weekday = weekdayForDateKey(targetDate);
  const fixedKeys =
    technologyConfig.fixedByDate[targetDate] ??
    technologyConfig.fixedByWeekday[String(weekday)] ??
    [];
  const catalogByKey = new Map(technologyConfig.catalog.map((item) => [item.key, item]));
  const core: TechnologyDefinition[] = [];
  const general: TechnologyDefinition[] = [];
  const rejectedFixed: Array<{ key: string; reason: string }> = [];
  const selected = new Set<string>();

  for (const key of fixedKeys) {
    const item = catalogByKey.get(key);
    if (!item) {
      rejectedFixed.push({ key, reason: "科技不存在或已删除" });
      continue;
    }
    if (selected.has(key)) continue;
    if (item.lane === "core" && item.category !== currentCampType) {
      rejectedFixed.push({ key, reason: "第一行科技必须属于当前营地科技类型" });
      continue;
    }
    const lane = item.lane === "core" ? core : general;
    const limit =
      item.lane === "core" ? technologyConfig.limits.core : technologyConfig.limits.general;
    if (lane.length >= limit) {
      rejectedFixed.push({ key, reason: "固定科技超过该行开启上限" });
      continue;
    }
    lane.push(item);
    selected.add(key);
  }

  for (const option of [...input.voteOptions].sort(byVotesThenOrder)) {
    if (selected.has(option.key) || !option.enabledForVoting) continue;
    if (
      option.category === currentCampType &&
      core.length < technologyConfig.limits.core
    ) {
      core.push(option);
      selected.add(option.key);
      continue;
    }
    if (general.length < technologyConfig.limits.general) {
      general.push(option);
      selected.add(option.key);
    }
  }

  return {
    targetDate,
    targetWeekday: weekday,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    clearExistingFirst: true,
    core,
    general,
    rejectedFixed
  };
}
