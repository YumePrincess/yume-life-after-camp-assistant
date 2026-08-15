import type {
  AutomationConfig,
  AuthConfig,
  CampConfig,
  ConfigBundle,
  PublicOverview,
  TechnologyCategory,
  TechnologyConfig,
  TechnologyDefinition,
  TechnologyLane
} from "./domain";
import { assertClock, assertTimezone, assertWindowEndClock } from "./time";

const CATEGORY_VALUES = new Set<TechnologyCategory>([
  "military",
  "agriculture",
  "industry"
]);
const LANE_VALUES = new Set<TechnologyLane>(["core", "general"]);
const TECH_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  field: string,
  options: { max?: number; allowEmpty?: boolean } = {}
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (!options.allowEmpty && !result) throw new Error(`${field} is required`);
  if (result.length > (options.max ?? 200)) throw new Error(`${field} is too long`);
  return result;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function category(value: unknown, field: string): TechnologyCategory {
  if (typeof value !== "string" || !CATEGORY_VALUES.has(value as TechnologyCategory)) {
    throw new Error(`${field} is invalid`);
  }
  return value as TechnologyCategory;
}

function lane(value: unknown, field: string): TechnologyLane {
  if (typeof value !== "string" || !LANE_VALUES.has(value as TechnologyLane)) {
    throw new Error(`${field} is invalid`);
  }
  return value as TechnologyLane;
}

function assetUrl(value: unknown, field: string): string {
  if (value === undefined || value === null || value === "") return "";
  const result = text(value, field, { max: 500 });
  if (result.startsWith("/")) return result;
  try {
    const url = new URL(result);
    if (url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${field} must be a root-relative or HTTPS URL`);
  }
}

function taskSchedule(
  value: unknown,
  field: string,
  allowMultiple = true
): { source: Record<string, unknown>; enabled: boolean; time: string; times: string[] } {
  const source = object(value, field);
  const rawTimes = source.times === undefined ? [source.time] : source.times;
  if (!Array.isArray(rawTimes) || rawTimes.length < 1 || rawTimes.length > 12) {
    throw new Error(`${field}.times must contain between 1 and 12 times`);
  }
  if (!allowMultiple && rawTimes.length > 1) {
    throw new Error(`${field}.times supports only one time`);
  }
  const times = rawTimes.map((item, index) => {
    const parsed = text(item, `${field}.times[${index}]`, { max: 5 });
    assertClock(parsed, `${field}.times[${index}]`);
    return parsed;
  });
  const time =
    source.time === undefined || source.time === ""
      ? times[0] ?? ""
      : text(source.time, `${field}.time`, { max: 5 });
  assertClock(time, `${field}.time`);
  return {
    source,
    enabled: boolean(source.enabled, `${field}.enabled`),
    time: times[0] ?? time,
    times
  };
}

type AutomationTasks = AutomationConfig["tasks"];

/**
 * Older admin clients only submit `time`. Keep any later execution slots that
 * are already persisted when one of those clients saves the task section.
 * Current clients always submit `times`, so an intentional removal to one
 * execution remains possible.
 */
export function preserveAutomationScheduleTimes(
  current: AutomationTasks,
  submitted: AutomationTasks,
  rawConfig: unknown
): AutomationTasks {
  const root =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? rawConfig as Record<string, unknown>
      : {};
  const rawAutomation =
    root.automationConfig &&
    typeof root.automationConfig === "object" &&
    !Array.isArray(root.automationConfig)
      ? root.automationConfig as Record<string, unknown>
      : {};
  const rawTasks =
    rawAutomation.tasks &&
    typeof rawAutomation.tasks === "object" &&
    !Array.isArray(rawAutomation.tasks)
      ? rawAutomation.tasks as Record<string, unknown>
      : {};
  const result = { ...submitted } as AutomationTasks;

  for (const taskKey of Object.keys(result) as Array<keyof AutomationTasks>) {
    const rawSchedule = rawTasks[taskKey];
    const includesTimes =
      rawSchedule &&
      typeof rawSchedule === "object" &&
      !Array.isArray(rawSchedule) &&
      Object.prototype.hasOwnProperty.call(rawSchedule, "times");
    const explicitlyReplacesTimes =
      rawSchedule &&
      typeof rawSchedule === "object" &&
      !Array.isArray(rawSchedule) &&
      (rawSchedule as Record<string, unknown>).replaceTimes === true;
    const currentSchedule = current[taskKey];
    const submittedSchedule = result[taskKey];
    const submittedTimes = submittedSchedule?.times || [];
    if (
      explicitlyReplacesTimes ||
      !currentSchedule ||
      !submittedSchedule ||
      currentSchedule.times.length < 2 ||
      (includesTimes && submittedTimes.length >= currentSchedule.times.length)
    ) {
      continue;
    }
    const firstTime = submittedSchedule.time || currentSchedule.times[0];
    result[taskKey] = {
      ...submittedSchedule,
      time: firstTime,
      times: [firstTime, ...currentSchedule.times.slice(1)]
    } as AutomationTasks[typeof taskKey];
  }
  return result;
}

export function validateCampConfig(value: unknown): CampConfig {
  const source = object(value, "campConfig");
  const timezone = text(source.timezone, "campConfig.timezone", { max: 80 });
  assertTimezone(timezone);
  const gameResetTime = text(source.gameResetTime, "campConfig.gameResetTime", { max: 5 });
  assertClock(gameResetTime, "campConfig.gameResetTime");
  const specialDailyRefreshTime =
    source.specialDailyRefreshTime === undefined
      ? "00:00"
      : text(source.specialDailyRefreshTime, "campConfig.specialDailyRefreshTime", { max: 5 });
  assertClock(specialDailyRefreshTime, "campConfig.specialDailyRefreshTime");
  const voteWindowStart =
    source.voteWindowStart === undefined
      ? "06:30"
      : text(source.voteWindowStart, "campConfig.voteWindowStart", { max: 5 });
  const voteWindowEnd =
    source.voteWindowEnd === undefined
      ? "24:00"
      : text(source.voteWindowEnd, "campConfig.voteWindowEnd", { max: 5 });
  assertClock(voteWindowStart, "campConfig.voteWindowStart");
  assertWindowEndClock(voteWindowEnd, "campConfig.voteWindowEnd");
  if (voteWindowStart === voteWindowEnd) {
    throw new Error("campConfig vote window cannot be empty");
  }
  return {
    timezone,
    gameResetTime,
    specialDailyRefreshTime,
    voteWindowStart,
    voteWindowEnd,
    currentCampType: category(source.currentCampType, "campConfig.currentCampType"),
    agentId: text(source.agentId, "campConfig.agentId", {
      max: 80,
      allowEmpty: true
    }),
    publicSiteName: text(source.publicSiteName, "campConfig.publicSiteName", { max: 80 }),
    campName: text(source.campName, "campConfig.campName", { max: 80 }),
    serverName: text(source.serverName, "campConfig.serverName", { max: 80 }),
    publicMembersEnabled: boolean(
      source.publicMembersEnabled,
      "campConfig.publicMembersEnabled"
    ),
    inactivityWarningDays:
      source.inactivityWarningDays === undefined
        ? 1
        : integer(
            source.inactivityWarningDays,
            "campConfig.inactivityWarningDays",
            1,
            3650
          )
  };
}

export function validatePublicOverview(value: unknown): PublicOverview {
  const source = object(value, "publicOverview");
  if (!Array.isArray(source.highlights)) {
    throw new Error("publicOverview.highlights must be an array");
  }
  const announcement = text(source.announcement, "publicOverview.announcement", {
      max: 1000,
      allowEmpty: true
    });
  const highlights = source.highlights
      .slice(0, 12)
      .map((item, index) =>
        text(item, `publicOverview.highlights[${index}]`, { max: 240 })
      );
  const localizedSource =
    source.localized && typeof source.localized === "object" && !Array.isArray(source.localized)
      ? (source.localized as Record<string, unknown>)
      : {};
  const localized = Object.fromEntries(
    ["zh-cn", "zh-tw", "en", "fr", "ja"].map((locale) => {
      const raw =
        localizedSource[locale] &&
        typeof localizedSource[locale] === "object" &&
        !Array.isArray(localizedSource[locale])
          ? (localizedSource[locale] as Record<string, unknown>)
          : {};
      const rawHighlights = Array.isArray(raw.highlights) ? raw.highlights : highlights;
      return [
        locale,
        {
          announcement:
            typeof raw.announcement === "string"
              ? text(raw.announcement, `publicOverview.localized.${locale}.announcement`, {
                  max: 1000,
                  allowEmpty: true
                })
              : announcement,
          highlights: rawHighlights.slice(0, 12).map((item, index) =>
            text(
              item,
              `publicOverview.localized.${locale}.highlights[${index}]`,
              { max: 240 }
            )
          )
        }
      ];
    })
  ) as PublicOverview["localized"];
  return {
    announcement,
    highlights,
    localized
  };
}

export function validateAuthConfig(value: unknown): AuthConfig {
  const source = object(value, "authConfig");
  return {
    temporaryKeyLoginEnabled: boolean(
      source.temporaryKeyLoginEnabled,
      "authConfig.temporaryKeyLoginEnabled"
    )
  };
}

export function validateTechnologyConfig(value: unknown): TechnologyConfig {
  const source = object(value, "technologyConfig");
  if (!Array.isArray(source.catalog)) throw new Error("technologyConfig.catalog must be an array");
  if (source.catalog.length > 200) throw new Error("technologyConfig.catalog is too large");

  const seen = new Set<string>();
  const catalog: TechnologyDefinition[] = source.catalog.map((raw, index) => {
    const item = object(raw, `technologyConfig.catalog[${index}]`);
    const key = text(item.key, `technologyConfig.catalog[${index}].key`, { max: 64 });
    if (!TECH_KEY_PATTERN.test(key)) throw new Error(`Invalid technology key: ${key}`);
    if (seen.has(key)) throw new Error(`Duplicate technology key: ${key}`);
    seen.add(key);
    return {
      key,
      name: text(item.name, `technologyConfig.catalog[${index}].name`, { max: 80 }),
      iconUrl: assetUrl(
        item.iconUrl,
        `technologyConfig.catalog[${index}].iconUrl`
      ),
      description:
        typeof item.description === "string"
          ? text(item.description, `technologyConfig.catalog[${index}].description`, {
              max: 500,
              allowEmpty: true
            })
          : "",
      category: category(item.category, `technologyConfig.catalog[${index}].category`),
      lane: lane(item.lane, `technologyConfig.catalog[${index}].lane`),
      enabledForVoting: boolean(
        item.enabledForVoting,
        `technologyConfig.catalog[${index}].enabledForVoting`
      ),
      sortOrder: integer(
        item.sortOrder,
        `technologyConfig.catalog[${index}].sortOrder`,
        0,
        100_000
      ),
      uiLabel: text(item.uiLabel, `technologyConfig.catalog[${index}].uiLabel`, {
        max: 80
      })
    };
  });

  const fixedSource = object(source.fixedByWeekday, "technologyConfig.fixedByWeekday");
  const fixedByWeekday: Record<string, string[]> = {};
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const raw = fixedSource[String(weekday)];
    if (!Array.isArray(raw)) {
      throw new Error(`technologyConfig.fixedByWeekday.${weekday} must be an array`);
    }
    const values = [...new Set(raw.map((item) => text(item, "fixed technology key", { max: 64 })))];
    const unknown = values.find((key) => !seen.has(key));
    if (unknown) throw new Error(`Unknown fixed technology: ${unknown}`);
    fixedByWeekday[String(weekday)] = values;
  }
  const fixedDateSource =
    source.fixedByDate && typeof source.fixedByDate === "object"
      ? object(source.fixedByDate, "technologyConfig.fixedByDate")
      : {};
  const fixedByDate: Record<string, string[]> = {};
  const fixedDateEntries = Object.entries(fixedDateSource);
  if (fixedDateEntries.length > 21) {
    throw new Error("technologyConfig.fixedByDate is too large");
  }
  for (const [date, raw] of fixedDateEntries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(raw)) {
      throw new Error(`technologyConfig.fixedByDate.${date} is invalid`);
    }
    const values = [
      ...new Set(
        raw.map((item) => text(item, "fixed technology key", { max: 64 }))
      )
    ];
    const unknown = values.find((key) => !seen.has(key));
    if (unknown) throw new Error(`Unknown fixed technology: ${unknown}`);
    fixedByDate[date] = values;
  }

  const limits: Record<string, unknown> =
    source.limits === undefined
      ? {}
      : object(source.limits, "technologyConfig.limits");
  return {
    catalog,
    fixedByWeekday,
    fixedByDate,
    voteLimit: integer(
      source.voteLimit === undefined ? 6 : source.voteLimit,
      "technologyConfig.voteLimit",
      0,
      12
    ),
    limits: {
      core: integer(
        limits.core === undefined ? 6 : limits.core,
        "technologyConfig.limits.core",
        0,
        6
      ),
      general: integer(
        limits.general === undefined ? 6 : limits.general,
        "technologyConfig.limits.general",
        0,
        6
      )
    }
  };
}

export function validateAutomationConfig(value: unknown): AutomationConfig {
  const source = object(value, "automationConfig");
  const timezone = text(source.timezone, "automationConfig.timezone", { max: 80 });
  assertTimezone(timezone);
  const tasks = object(source.tasks, "automationConfig.tasks");
  const tech = taskSchedule(
    tasks.tech_switch ?? { enabled: true, time: "02:00" },
    "automationConfig.tasks.tech_switch",
    false
  );
  const contribution = taskSchedule(
    tasks.contribution_sync ?? { enabled: true, time: "02:30" },
    "automationConfig.tasks.contribution_sync"
  );
  const inactivity = taskSchedule(
    tasks.inactivity_sync ?? { enabled: true, time: "02:45" },
    "automationConfig.tasks.inactivity_sync"
  );
  const profile = taskSchedule(
    tasks.member_profile_sync ?? { enabled: true, time: "02:15" },
    "automationConfig.tasks.member_profile_sync"
  );
  const patrol = taskSchedule(tasks.patrol, "automationConfig.tasks.patrol", false);

  const patrolTeamReadyTime = text(
    patrol.source.teamReadyTime,
    "automationConfig.tasks.patrol.teamReadyTime",
    { max: 5 }
  );
  const patrolDeadline = text(
    patrol.source.deadline,
    "automationConfig.tasks.patrol.deadline",
    { max: 5 }
  );
  const clocks: Array<[string, string]> = [
    ["patrol.teamReadyTime", patrolTeamReadyTime],
    ["patrol.deadline", patrolDeadline]
  ];
  for (const [field, clock] of clocks) {
    assertClock(clock, field);
  }

  const pollingSource =
    source.agentPolling && typeof source.agentPolling === "object"
      ? object(source.agentPolling, "automationConfig.agentPolling")
      : {};
  const pollingWindows = Array.isArray(pollingSource.windows)
    ? pollingSource.windows.map((raw, index) => {
        const window = object(raw, `automationConfig.agentPolling.windows[${index}]`);
        const start = text(
          window.start,
          `automationConfig.agentPolling.windows[${index}].start`,
          { max: 5 }
        );
        const end = text(
          window.end,
          `automationConfig.agentPolling.windows[${index}].end`,
          { max: 5 }
        );
        assertClock(start, `automationConfig.agentPolling.windows[${index}].start`);
        assertClock(end, `automationConfig.agentPolling.windows[${index}].end`);
        return {
          id: text(window.id, `automationConfig.agentPolling.windows[${index}].id`, {
            max: 64
          }),
          name: text(
            window.name,
            `automationConfig.agentPolling.windows[${index}].name`,
            { max: 80 }
          ),
          start,
          end,
          seconds: integer(
            window.seconds,
            `automationConfig.agentPolling.windows[${index}].seconds`,
            1,
            3600
          ),
          weekdays: weekdays(
            window.weekdays,
            `automationConfig.agentPolling.windows[${index}].weekdays`
          )
        };
      })
    : [];
  if (pollingWindows.length > 24) {
    throw new Error("automationConfig.agentPolling.windows is too large");
  }

  const watchdogSource =
    source.gameWatchdog && typeof source.gameWatchdog === "object"
      ? object(source.gameWatchdog, "automationConfig.gameWatchdog")
      : {};
  return {
    timezone,
    schedulerGraceMinutes: integer(
      source.schedulerGraceMinutes,
      "automationConfig.schedulerGraceMinutes",
      1,
      15
    ),
    scheduledRetryCount:
      source.scheduledRetryCount === undefined
        ? 2
        : integer(source.scheduledRetryCount, "automationConfig.scheduledRetryCount", 0, 6),
    agentPolling: {
      activeSeconds:
        pollingSource.activeSeconds === undefined
          ? 2
          : integer(
              pollingSource.activeSeconds,
              "automationConfig.agentPolling.activeSeconds",
              1,
              60
            ),
      idleSeconds:
        pollingSource.idleSeconds === undefined
          ? 300
          : integer(
              pollingSource.idleSeconds,
              "automationConfig.agentPolling.idleSeconds",
              2,
              3600
            ),
      claimTimeoutMinutes:
        pollingSource.claimTimeoutMinutes === undefined
          ? 45
          : integer(
              pollingSource.claimTimeoutMinutes,
              "automationConfig.agentPolling.claimTimeoutMinutes",
              1,
              10_080
            ),
      windows: pollingWindows
    },
    gameWatchdog: {
      enabled:
        watchdogSource.enabled === undefined
          ? true
          : boolean(watchdogSource.enabled, "automationConfig.gameWatchdog.enabled"),
      healthCheckSeconds:
        watchdogSource.healthCheckSeconds === undefined
          ? 10
          : integer(
              watchdogSource.healthCheckSeconds,
              "automationConfig.gameWatchdog.healthCheckSeconds",
              2,
              120
            ),
      actionTimeoutSeconds:
        watchdogSource.actionTimeoutSeconds === undefined
          ? 45
          : integer(
              watchdogSource.actionTimeoutSeconds,
              "automationConfig.gameWatchdog.actionTimeoutSeconds",
              10,
              600
            ),
      frozenScreenSeconds:
        watchdogSource.frozenScreenSeconds === undefined
          ? 60
          : integer(
              watchdogSource.frozenScreenSeconds,
              "automationConfig.gameWatchdog.frozenScreenSeconds",
              30,
              900
            ),
      maxRestarts:
        watchdogSource.maxRestarts === undefined
          ? 2
          : integer(
              watchdogSource.maxRestarts,
              "automationConfig.gameWatchdog.maxRestarts",
              0,
              10
            ),
      restartCooldownSeconds:
        watchdogSource.restartCooldownSeconds === undefined
          ? 8
          : integer(
              watchdogSource.restartCooldownSeconds,
              "automationConfig.gameWatchdog.restartCooldownSeconds",
              1,
              120
            )
    },
    tasks: {
      tech_switch: { enabled: tech.enabled, time: tech.time, times: tech.times },
      contribution_sync: {
        enabled: contribution.enabled,
        time: contribution.time,
        times: contribution.times
      },
      inactivity_sync: { enabled: inactivity.enabled, time: inactivity.time, times: inactivity.times },
      member_profile_sync: { enabled: profile.enabled, time: profile.time, times: profile.times },
      patrol: {
        enabled: patrol.enabled,
        time: patrol.time,
        times: [patrol.time],
        teamReadyTime: patrolTeamReadyTime,
        shareIntervalMinutes: integer(
          patrol.source.shareIntervalMinutes,
          "automationConfig.tasks.patrol.shareIntervalMinutes",
          1,
          60
        ),
        chatPollSeconds: integer(
          patrol.source.chatPollSeconds,
          "automationConfig.tasks.patrol.chatPollSeconds",
          2,
          60
        ),
        deadline: patrolDeadline
      }
    },
    routines: []
  };
}

function weekdays(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 7) {
    throw new Error(`${field} must contain weekdays`);
  }
  return [
    ...new Set(
      value.map((item, index) =>
        integer(item, `${field}[${index}]`, 1, 7)
      )
    )
  ];
}

export function validateConfigBundle(value: unknown): ConfigBundle {
  const source = object(value, "config");
  return {
    campConfig: validateCampConfig(source.campConfig),
    authConfig: validateAuthConfig(source.authConfig),
    publicOverview: validatePublicOverview(source.publicOverview),
    technologyConfig: validateTechnologyConfig(source.technologyConfig),
    automationConfig: validateAutomationConfig(source.automationConfig)
  };
}
