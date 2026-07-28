import {
  createCommand,
  createRun,
  listBallots,
  type SessionRow
} from "./db";
import type {
  ConfigBundle,
  AutomationRoutine,
  TaskKey,
  TechnologyPlan,
  VoteSummary
} from "./domain";
import { buildTechnologyPlan } from "./tech";
import {
  isWithinDailyClockWindow,
  nextTechnologyTargetDate,
  targetDateForTechnologyRun,
  zonedDateKey
} from "./time";

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
  const counts = new Map<string, number>();
  for (const ballot of ballots) {
    for (const key of new Set(ballot.selections)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const options = bundle.technologyConfig.catalog
    .filter((item) => item.enabledForVoting)
    .map((item) => ({ ...item, votes: counts.get(item.key) ?? 0 }))
    .sort((a, b) => b.votes - a.votes || a.sortOrder - b.sortOrder);
  return {
    pollDate,
    opensAt: bundle.campConfig.voteWindowStart,
    closesAt: bundle.campConfig.voteWindowEnd,
    isOpen,
    timezone,
    options,
    ballotCount: ballots.length
  };
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
  return buildTechnologyPlan({
    targetDate: resolvedTarget,
    currentCampType: bundle.campConfig.currentCampType,
    technologyConfig: bundle.technologyConfig,
    voteOptions: voteSummary.options
  });
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
  const now = input.now ?? new Date();
  const localDate =
    input.localDate ?? zonedDateKey(now, input.bundle.automationConfig.timezone);
  const detail: Record<string, unknown> = {
    requestedAt: now.toISOString(),
    requestedBy: input.requestedBy?.email ?? input.triggerMode,
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
