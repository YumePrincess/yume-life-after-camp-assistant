export const TASK_KEYS = [
  "tech_switch",
  "member_sync",
  "contribution_sync",
  "inactivity_sync",
  "member_profile_sync",
  "weekly_activity_sync",
  "trading_city_apply",
  "patrol",
  "automation_routine"
] as const;

export type TaskKey = (typeof TASK_KEYS)[number];
export type TriggerMode = "scheduled" | "manual";
export type RunState =
  | "queued"
  | "claimed"
  | "running"
  | "cancelling"
  | "interrupted"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "timed_out"
  | "skipped";

export type TechnologyCategory = "military" | "agriculture" | "industry";
export type TechnologyLane = "core" | "general";

export interface CampConfig {
  campGroupDataUrl: string;
  timezone: string;
  gameResetTime: string;
  specialDailyRefreshTime: string;
  voteWindowStart: string;
  voteWindowEnd: string;
  currentCampType: TechnologyCategory;
  agentId: string;
  publicSiteName: string;
  campName: string;
  serverName: string;
  publicMembersEnabled: boolean;
  inactivityWarningDays: number;
}

export interface PublicOverview {
  announcement: string;
  highlights: PublicOverviewItem[];
  localized: Record<
    "zh-cn" | "zh-tw" | "en" | "fr" | "ja",
    { announcement: string; highlights: PublicOverviewItem[] }
  >;
}

export type PublicOverviewBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string };

export interface PublicOverviewItem {
  blocks: PublicOverviewBlock[];
}

export interface AuthConfig {
  temporaryKeyLoginEnabled: boolean;
}

export interface TechnologyDefinition {
  key: string;
  name: string;
  iconUrl?: string;
  description?: string;
  category: TechnologyCategory;
  lane: TechnologyLane;
  enabledForVoting: boolean;
  sortOrder: number;
  uiLabel: string;
  prerequisiteKey?: string;
  prerequisiteName?: string;
}

export type TechnologyFixedPresetMode = "date" | "weekday" | "interval";

export interface TechnologyFixedPreset {
  id: string;
  mode: TechnologyFixedPresetMode;
  technologyKeys: string[];
  /** Used by the one-off date mode. */
  date?: string;
  /** Inclusive range for recurring presets. A null end date means forever. */
  startDate?: string;
  endDate?: string | null;
  /** ISO weekdays, Monday = 1 through Sunday = 7. */
  weekdays?: number[];
  /** Number of technology days to skip between activations. 0 = every day. */
  intervalDays?: number;
}

export interface TechnologyConfig {
  catalog: TechnologyDefinition[];
  /** Canonical fixed-technology rules. Legacy maps remain for old clients/configs. */
  fixedPresets?: TechnologyFixedPreset[];
  fixedByWeekday: Record<string, string[]>;
  fixedByDate: Record<string, string[]>;
  voteLimit: number;
  voteEligibilityEnabled?: boolean;
  limits: {
    core: number;
    general: number;
  };
}

export interface TaskSchedule {
  enabled: boolean;
  time: string;
  times: string[];
  /** ISO weekday numbers (1 = Monday, 7 = Sunday) on which this task may run. */
  weekdays?: number[];
}

export interface TradingCitySchedule extends TaskSchedule {
  /** The single recurring execution weekday; ISO weekday numbering. */
  executionWeekday: number;
  /** The single weekday selected on the trading city application form. */
  targetWeekday: number;
}

export interface AutomationConfig {
  timezone: string;
  schedulerGraceMinutes: number;
  scheduledRetryCount: number;
  manualRetryCount: number;
  agent: {
    claimTimeoutMinutes: number;
  };
  gameWatchdog: {
    enabled: boolean;
    healthCheckSeconds: number;
    actionTimeoutSeconds: number;
    frozenScreenSeconds: number;
    maxRestarts: number;
    restartCooldownSeconds: number;
  };
  tasks: {
    tech_switch: TaskSchedule;
    contribution_sync: TaskSchedule;
    inactivity_sync: TaskSchedule;
    member_profile_sync: TaskSchedule;
    weekly_activity_sync: TaskSchedule;
    trading_city_apply: TradingCitySchedule;
    patrol: TaskSchedule & {
      teamReadyTime: string;
      shareIntervalMinutes: number;
      chatPollSeconds: number;
      deadline: string;
    };
  };
  routines: AutomationRoutine[];
}

export interface AutomationRoutine {
  id: string;
  name: string;
  enabled: boolean;
  time: string;
  weekdays: number[];
  groups: Array<Array<Exclude<TaskKey, "automation_routine">>>;
}

export interface ConfigBundle {
  campConfig: CampConfig;
  authConfig: AuthConfig;
  publicOverview: PublicOverview;
  technologyConfig: TechnologyConfig;
  automationConfig: AutomationConfig;
}

export interface VoteOption extends TechnologyDefinition {
  votes: number;
}

export interface VoteSummary {
  pollDate: string;
  opensAt: string;
  closesAt: string;
  opensAtDisplay?: string;
  closesAtDisplay?: string;
  isOpen: boolean;
  timezone: string;
  voteLimit: number;
  options: VoteOption[];
  ballotCount: number;
  fixedTechnologies: TechnologyDefinition[];
  projectedPlan: {
    core: TechnologyDefinition[];
    general: TechnologyDefinition[];
  };
}

export interface TechnologyVoteHistory {
  pollDate: string;
  finalizedAt: string;
  ballotCount: number;
  options: VoteOption[];
  projectedPlan: {
    core: TechnologyDefinition[];
    general: TechnologyDefinition[];
  };
  fixedTechnologies: TechnologyDefinition[];
}

export interface TechnologyPlan {
  targetDate: string;
  targetWeekday: number;
  generatedAt: string;
  clearExistingFirst: true;
  core: TechnologyDefinition[];
  general: TechnologyDefinition[];
  rejectedFixed: Array<{ key: string; reason: string }>;
}

export interface TaskRun {
  id: string;
  task_key: TaskKey;
  schedule_key: string | null;
  trigger_mode: TriggerMode;
  state: RunState;
  message: string | null;
  current_step: string | null;
  progress: number;
  cancel_requested: number;
  detail_json: string | null;
  local_date: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommandRow {
  id: string;
  run_id: string | null;
  agent_id: string;
  type: "run_task" | "interrupt_task";
  payload_json: string;
  state: "queued" | "claimed" | "completed" | "failed" | "cancelled";
  priority: number;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  available_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  message: string | null;
}

export interface AgentHeartbeat {
  agent_id: string;
  display_name: string | null;
  active_run_id: string | null;
  active_task_key: TaskKey | null;
  status: string;
  capabilities_json: string | null;
  detail_json: string | null;
  first_seen_at: string | null;
  updated_at: string;
}

export function isTaskKey(value: string): value is TaskKey {
  return (TASK_KEYS as readonly string[]).includes(value);
}
