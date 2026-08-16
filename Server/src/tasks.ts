import {
  createCommand,
  createRun,
  listBallots,
  saveTechnologyVoteHistory,
  type SessionRow
} from "./db";
import type {
  ConfigBundle,
  AutomationRoutine,
  TaskKey,
  TechnologyPlan,
  VoteSummary
} from "./domain";
import {
  buildTechnologyPlan,
  technologyCatalogWithPrerequisites
} from "./tech";
import {
  isWithinDueWindow,
  isWithinDailyClockWindow,
  nextTechnologyTargetDate,
  technologyEffectiveDateAtDailyReset,
  targetDateForTechnologyRun,
  weekdayForDateKey,
  zonedDateKey,
  zonedDateTimeToIso
} from "./time";
import { builtPluginForTask, isWorkerPluginEnabled } from "./plugin-system";

const MANUAL_RETRY_GRACE_MINUTES = 15;

/**
 * Manual runs inherit the configured retry policy only when they are started
 * from the same window in which the corresponding scheduled run is due. The
 * eligibility is persisted on the run so a later failure does not depend on
 * the clock still being inside that window.
 */
export function isManualRetryEligible(
  bundle: ConfigBundle,
  taskKey: TaskKey,
  now: Date
): boolean {
  const { automationConfig } = bundle;
  const timezone = automationConfig.timezone;
  if (taskKey === "patrol") {
    const patrol = automationConfig.tasks.patrol;
    return isWithinDailyClockWindow(now, timezone, patrol.time, patrol.deadline);
  }
  if (
    taskKey !== "tech_switch" &&
    taskKey !== "contribution_sync" &&
    taskKey !== "inactivity_sync" &&
    taskKey !== "member_profile_sync"
  ) {
    return false;
  }
  return automationConfig.tasks[taskKey].times.some((scheduledTime) =>
    isWithinDueWindow(
      now,
      timezone,
      scheduledTime,
      MANUAL_RETRY_GRACE_MINUTES
    )
  );
}

export async function buildVoteSummary(
  env: Env,
  bundle: ConfigBundle,
  now = new Date(),
  pollDateOverride?: string
): Promise<VoteSummary> {
  const timezone = bundle.automationConfig.timezone;
  const isOpen = isWithinDailyClockWindow(
    now,
    timezone,
    bundle.campConfig.voteWindowStart,
    bundle.campConfig.voteWindowEnd
  );
  const pollDate =
    pollDateOverride ??
    nextTechnologyTargetDate(
      now,
      timezone,
      bundle.automationConfig.tasks.tech_switch.time,
      bundle.campConfig.gameResetTime
    );
  const ballots = await listBallots(env, pollDate);
  const fixed = new Set(
    bundle.technologyConfig.fixedByDate[pollDate] ??
      bundle.technologyConfig.fixedByWeekday[
        String(weekdayForDateKey(pollDate))
      ] ??
      []
  );
  const counts = new Map<string, number>();
  for (const ballot of ballots) {
    for (const key of new Set(ballot.selections)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const options = technologyCatalogWithPrerequisites(
    bundle.technologyConfig.catalog
  )
    .filter((item) => item.enabledForVoting && !fixed.has(item.key))
    .map((item) => ({
      ...item,
      lane:
        item.category === bundle.campConfig.currentCampType
          ? ("core" as const)
          : ("general" as const),
      votes: counts.get(item.key) ?? 0
    }))
    .sort((a, b) => b.votes - a.votes || a.sortOrder - b.sortOrder);
  const projectedPlan = buildTechnologyPlan({
    targetDate: pollDate,
    currentCampType: bundle.campConfig.currentCampType,
    technologyConfig: bundle.technologyConfig,
    voteOptions: options
  });
  return {
    pollDate,
    opensAt: bundle.campConfig.voteWindowStart,
    closesAt: bundle.campConfig.voteWindowEnd,
    isOpen,
    timezone,
    voteLimit: bundle.technologyConfig.voteLimit,
    options,
    ballotCount: ballots.length,
    projectedPlan: {
      core: projectedPlan.core,
      general: projectedPlan.general
    }
  };
}

export async function snapshotTechnologyVoteHistory(
  env: Env,
  bundle: ConfigBundle,
  pollDate: string,
  now = new Date()
): Promise<void> {
  const summary = await buildVoteSummary(env, bundle, now, pollDate);
  const fixedKeys = new Set(
    bundle.technologyConfig.fixedByDate[pollDate] ??
      bundle.technologyConfig.fixedByWeekday[
        String(weekdayForDateKey(pollDate))
      ] ??
      []
  );
  await saveTechnologyVoteHistory(env, {
    pollDate,
    finalizedAt: zonedDateTimeToIso(
      pollDate,
      bundle.campConfig.gameResetTime,
      bundle.automationConfig.timezone
    ),
    ballotCount: summary.ballotCount,
    options: summary.options,
    projectedPlan: summary.projectedPlan,
    fixedTechnologies: bundle.technologyConfig.catalog.filter((item) =>
      fixedKeys.has(item.key)
    )
  });
}

export async function archiveTechnologyVoteHistoryAtDailyReset(
  env: Env,
  bundle: ConfigBundle,
  now = new Date()
): Promise<string | null> {
  const pollDate = technologyEffectiveDateAtDailyReset(
    now,
    bundle.automationConfig.timezone,
    bundle.campConfig.gameResetTime
  );
  await snapshotTechnologyVoteHistory(env, bundle, pollDate, now);
  return pollDate;
}

async function technologyPlanForRun(
  env: Env,
  bundle: ConfigBundle,
  now: Date,
  targetDate?: string
): Promise<TechnologyPlan> {
  const resolvedTarget =
    targetDate ??
    targetDateForTechnologyRun(
      now,
      bundle.automationConfig.timezone,
      bundle.campConfig.gameResetTime
    );
  const voteSummary = await buildVoteSummary(env, bundle, now, resolvedTarget);
  const plan = buildTechnologyPlan({
    targetDate: resolvedTarget,
    currentCampType: bundle.campConfig.currentCampType,
    technologyConfig: bundle.technologyConfig,
    voteOptions: voteSummary.options
  });
  return plan;
}

export async function enqueueTask(
  env: Env,
  input: {
    bundle: ConfigBundle;
    taskKey: TaskKey;
    triggerMode: "scheduled" | "manual";
    scheduleKey?: string | null;
    localDate?: string;
    now?: Date;
    requestedBy?: SessionRow | null;
    targetDate?: string;
    routine?: AutomationRoutine;
    payloadDetail?: Record<string, unknown>;
  }
): Promise<{ run: Awaited<ReturnType<typeof createRun>>; commandId: string | null }> {
  const owningPlugin = builtPluginForTask(input.taskKey);
  if (owningPlugin && !(await isWorkerPluginEnabled(env, owningPlugin.id))) {
    throw new Error(`Workers plugin ${owningPlugin.id} is disabled`);
  }
  const now = input.now ?? new Date();
  const localDate =
    input.localDate ?? zonedDateKey(now, input.bundle.automationConfig.timezone);
  const manualRetryEligible =
    input.triggerMode === "manual" &&
    isManualRetryEligible(input.bundle, input.taskKey, now);
  const retryPolicy =
    input.triggerMode === "scheduled"
      ? "scheduled"
      : manualRetryEligible
        ? "scheduled_window"
        : "manual";
  const detail: Record<string, unknown> = {
    requestedAt: now.toISOString(),
    requestedBy: input.requestedBy?.email ?? input.triggerMode,
    scheduledRetryLimit:
      input.triggerMode === "scheduled" || manualRetryEligible
        ? input.bundle.automationConfig.scheduledRetryCount
        : input.bundle.automationConfig.manualRetryCount,
    scheduledRetryAttempt: 0,
    manualRetryEligible,
    retryPolicy,
    ...(input.payloadDetail ?? {})
  };
  if (input.taskKey === "tech_switch") {
    detail.technologyPlan = await technologyPlanForRun(
      env,
      input.bundle,
      now,
      input.targetDate
    );
  }
  if (input.taskKey === "patrol") {
    detail.patrol = input.bundle.automationConfig.tasks.patrol;
    detail.patrolDeadlineAt = zonedDateTimeToIso(
      localDate,
      input.bundle.automationConfig.tasks.patrol.deadline,
      input.bundle.automationConfig.timezone
    );
  }
  if (input.taskKey === "automation_routine") {
    if (!input.routine) throw new Error("Automation routine payload is required");
    detail.routine = input.routine;
    const routineTasks = new Set(input.routine.groups.flat());
    if (routineTasks.has("tech_switch")) {
      detail.technologyPlan = await technologyPlanForRun(
        env,
        input.bundle,
        now,
        input.targetDate
      );
    }
    if (routineTasks.has("patrol")) {
      detail.patrol = input.bundle.automationConfig.tasks.patrol;
      detail.patrolDeadlineAt = zonedDateTimeToIso(
        localDate,
        input.bundle.automationConfig.tasks.patrol.deadline,
        input.bundle.automationConfig.timezone
      );
    }
  }

  const run = await createRun(env, {
    taskKey: input.taskKey,
    scheduleKey: input.scheduleKey,
    triggerMode: input.triggerMode,
    message: input.triggerMode === "manual" ? "管理员手工任务已入队" : "定时任务已入队",
    detail,
    localDate
  });
  if (!run) return { run: null, commandId: null };

  const command = await createCommand(env, {
    runId: run.id,
    agentId: input.bundle.campConfig.agentId,
    type: "run_task",
    payload: {
      runId: run.id,
      taskKey: input.taskKey,
      triggerMode: input.triggerMode,
      detail
    }
  });
  return { run, commandId: command.id };
}
