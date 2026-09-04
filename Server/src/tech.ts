import type {
  TechnologyConfig,
  TechnologyDefinition,
  TechnologyFixedPreset,
  TechnologyPlan,
  VoteOption
} from "./domain";
import { weekdayForDateKey } from "./time";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dateKeyToUtcDay(dateKey: string): number {
  const [year = 0, month = 0, day = 0] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function isWithinPresetRange(
  preset: TechnologyFixedPreset,
  targetDate: string
): boolean {
  const startDate = preset.startDate;
  if (!startDate) return false;
  if (targetDate < startDate) return false;
  return !preset.endDate || targetDate <= preset.endDate;
}

export function technologyFixedPresetApplies(
  preset: TechnologyFixedPreset,
  targetDate: string
): boolean {
  if (preset.mode === "date") return preset.date === targetDate;
  if (!isWithinPresetRange(preset, targetDate)) return false;
  if (preset.mode === "weekday") {
    return (preset.weekdays ?? []).includes(weekdayForDateKey(targetDate));
  }
  const startDate = preset.startDate;
  const intervalDays = preset.intervalDays ?? -1;
  if (!startDate || !Number.isInteger(intervalDays) || intervalDays < 0) {
    return false;
  }
  const elapsedDays = dateKeyToUtcDay(targetDate) - dateKeyToUtcDay(startDate);
  return elapsedDays >= 0 && elapsedDays % (intervalDays + 1) === 0;
}

/**
 * Resolve fixed technology keys for an effective day. Exact-date presets have
 * priority over recurring presets, matching the legacy date override behavior.
 * Multiple active recurring presets are combined and de-duplicated.
 */
export function fixedTechnologyKeysForDate(
  technologyConfig: TechnologyConfig,
  targetDate: string
): string[] {
  if (Array.isArray(technologyConfig.fixedPresets)) {
    const presets = technologyConfig.fixedPresets;
    const exact = presets.filter(
      (preset) => preset.mode === "date" && technologyFixedPresetApplies(preset, targetDate)
    );
    const active = exact.length
      ? exact
      : presets.filter(
          (preset) => preset.mode !== "date" && technologyFixedPresetApplies(preset, targetDate)
        );
    return [...new Set(active.flatMap((preset) => preset.technologyKeys))];
  }
  return [
    ...(technologyConfig.fixedByDate[targetDate] ??
      technologyConfig.fixedByWeekday[String(weekdayForDateKey(targetDate))] ??
      [])
  ];
}

function byVotesThenOrder(a: VoteOption, b: VoteOption): number {
  return b.votes - a.votes || a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);
}

export function prerequisiteNameForTechnology(name: string): string | null {
  return String(name).match(/[（(]([^（）()]+)[）)]\s*$/)?.[1]?.trim() || null;
}

export function technologyCatalogWithPrerequisites(
  catalog: TechnologyDefinition[]
): TechnologyDefinition[] {
  const byName = new Map(catalog.map((item) => [item.name.trim(), item]));
  return catalog.map((item) => {
    const prerequisiteName = prerequisiteNameForTechnology(item.name);
    const prerequisite = prerequisiteName
      ? byName.get(prerequisiteName)
      : undefined;
    return prerequisite
      ? {
          ...item,
          prerequisiteKey: prerequisite.key,
          prerequisiteName: prerequisite.name
        }
      : { ...item };
  });
}

export function normalizeBallotSelections(input: {
  selections: string[];
  catalog: TechnologyDefinition[];
  allowedKeys: Set<string>;
  satisfiedKeys?: Set<string>;
  maximum?: number;
}): { selections: string[]; error?: string } {
  const catalog = technologyCatalogWithPrerequisites(input.catalog);
  const byKey = new Map(catalog.map((item) => [item.key, item]));
  const satisfied = input.satisfiedKeys ?? new Set<string>();
  const maximum = input.maximum ?? 6;
  const normalized: string[] = [];
  const selected = new Set<string>();
  const visiting = new Set<string>();

  const include = (key: string): string | null => {
    if (selected.has(key) || satisfied.has(key)) return null;
    const item = byKey.get(key);
    if (!item || !input.allowedKeys.has(key)) {
      return `科技 ${item?.name ?? key} 当前不可投票`;
    }
    if (visiting.has(key)) return `科技 ${item.name} 的前置科技配置形成循环`;
    visiting.add(key);
    if (item.prerequisiteKey) {
      const error = include(item.prerequisiteKey);
      if (error) return error;
    }
    visiting.delete(key);
    if (!selected.has(key)) {
      selected.add(key);
      normalized.push(key);
    }
    return null;
  };

  for (const key of input.selections) {
    const error = include(key);
    if (error) return { selections: [], error };
  }
  if (normalized.length > maximum) {
    return {
      selections: [],
      error: `所选科技及其前置科技合计超过 ${maximum} 票`
    };
  }
  return { selections: normalized };
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
  const fixedKeys = fixedTechnologyKeysForDate(technologyConfig, targetDate);
  const catalog = technologyCatalogWithPrerequisites(technologyConfig.catalog);
  const catalogByKey = new Map(catalog.map((item) => [item.key, item]));
  const votesByKey = new Map(input.voteOptions.map((item) => [item.key, item.votes]));
  const core: TechnologyDefinition[] = [];
  const general: TechnologyDefinition[] = [];
  const rejectedFixed: Array<{ key: string; reason: string }> = [];
  const selected = new Set<string>();
  const blocked = new Set<string>();

  const effectiveLane = (item: TechnologyDefinition) =>
    item.category === currentCampType ? "core" : "general";
  const laneFor = (item: TechnologyDefinition) =>
    effectiveLane(item) === "core" ? core : general;
  const missingChain = (
    key: string,
    visiting = new Set<string>()
  ): TechnologyDefinition[] | null => {
    if (selected.has(key)) return [];
    if (visiting.has(key)) return null;
    const item = catalogByKey.get(key);
    if (!item) return null;
    visiting.add(key);
    const before = item.prerequisiteKey
      ? missingChain(item.prerequisiteKey, visiting)
      : [];
    visiting.delete(key);
    if (!before) return null;
    return [...before, item].filter(
      (candidate, index, list) =>
        !selected.has(candidate.key) &&
        list.findIndex((value) => value.key === candidate.key) === index
    );
  };
  const chainFits = (items: TechnologyDefinition[]) => {
    let coreNeeded = 0;
    let generalNeeded = 0;
    for (const item of items) {
      if (effectiveLane(item) === "core") coreNeeded += 1;
      else generalNeeded += 1;
    }
    return (
      core.length + coreNeeded <= technologyConfig.limits.core &&
      general.length + generalNeeded <= technologyConfig.limits.general
    );
  };
  const addChain = (items: TechnologyDefinition[]) => {
    for (const item of items) {
      if (selected.has(item.key)) continue;
      laneFor(item).push(item);
      selected.add(item.key);
    }
  };

  for (const key of fixedKeys) {
    const item = catalogByKey.get(key);
    if (!item) {
      rejectedFixed.push({ key, reason: "科技不存在或已删除" });
      continue;
    }
    if (selected.has(key)) continue;
    const chain = missingChain(key);
    if (!chain) {
      rejectedFixed.push({ key, reason: "找不到前置科技或前置关系形成循环" });
      continue;
    }
    if (!chainFits(chain)) {
      rejectedFixed.push({ key, reason: "固定科技及其前置科技超过该行开启上限" });
      continue;
    }
    addChain(chain);
  }

  for (const option of [...input.voteOptions].sort(byVotesThenOrder)) {
    if (
      selected.has(option.key) ||
      blocked.has(option.key) ||
      !option.enabledForVoting ||
      option.votes <= 0
    ) {
      continue;
    }
    const item = catalogByKey.get(option.key);
    if (!item) continue;
    if (item.prerequisiteKey) {
      const prerequisiteVotes = votesByKey.get(item.prerequisiteKey) ?? 0;
      if (option.votes < prerequisiteVotes) {
        const prerequisiteChain = missingChain(item.prerequisiteKey);
        if (prerequisiteChain && chainFits(prerequisiteChain)) {
          addChain(prerequisiteChain);
        }
        continue;
      }
    }
    const chain = missingChain(item.key);
    if (!chain) continue;
    if (!chainFits(chain)) {
      if (item.prerequisiteKey && !selected.has(item.prerequisiteKey)) {
        blocked.add(item.key);
        blocked.add(item.prerequisiteKey);
      }
      continue;
    }
    addChain(chain);
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
