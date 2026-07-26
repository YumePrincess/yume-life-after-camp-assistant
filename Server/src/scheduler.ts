import { getConfigBundle } from "./db";
import type { ConfigBundle } from "./domain";
import { enqueueTask } from "./tasks";
import {
  clockIsInsideWindow,
  dateKey,
  isWithinDueWindow,
  targetDateForTechnologyRun,
  weekKeyForDateKey,
  zonedParts
} from "./time";

interface SchedulerResult {
  checkedAt: string;
  timezone: string;
  enqueued: string[];
  skipped: string[];
}

export async function runScheduler(
  env: Env,
  now = new Date()
): Promise<SchedulerResult> {
  const bundle = await getConfigBundle(env);
  const timezone = bundle.automationConfig.timezone;
  const parts = zonedParts(now, timezone);
  const localDate = dateKey(parts);
  const result: SchedulerResult = {
    checkedAt: now.toISOString(),
    timezone,
    enqueued: [],
    skipped: []
  };

  await maybeEnqueueDaily(env, bundle, now, localDate, "tech_switch", result, {
    targetDate: targetDateForTechnologyRun(
      now,
      timezone,
      bundle.campConfig.gameResetTime
    )
  });
  await maybeEnqueueDaily(env, bundle, now, localDate, "member_sync", result);
  await maybeEnqueueDaily(env, bundle, now, localDate, "contribution_sync", result);
  await maybeEnqueueDaily(env, bundle, now, localDate, "inactivity_sync", result);
  await maybeEnqueueDaily(env, bundle, now, localDate, "member_profile_sync", result);
  await maybeEnqueueDaily(env, bundle, now, localDate, "patrol", result);

  const patrol = bundle.automationConfig.tasks.patrol;
  const brick = bundle.automationConfig.tasks.brick_transport;
  const inline =
    brick.inlineWithPatrol &&
    clockIsInsideWindow(brick.time, patrol.time, patrol.deadline);
  if (!inline) {
    await maybeEnqueueDaily(env, bundle, now, localDate, "brick_transport", result);
  } else {
    result.skipped.push("brick_transport:inline_with_patrol");
  }

  const weekly = bundle.automationConfig.tasks.weekly_schedule_update;
  if (
    weekly.enabled &&
    parts.weekday === weekly.weekday &&
    isWithinDueWindow(
      now,
      timezone,
      weekly.time,
      bundle.automationConfig.schedulerGraceMinutes
    )
  ) {
    const currentWeek = weekKeyForDateKey(localDate);
    const eligible =
      (!weekly.onlyWhenDirty || bundle.weeklySchedule.dirty) &&
      bundle.weeklySchedule.pendingApplyWeek === currentWeek;
    if (eligible) {
      const queued = await enqueueTask(env, {
        bundle,
        taskKey: "weekly_schedule_update",
        triggerMode: "scheduled",
        scheduleKey: `weekly_schedule_update:${currentWeek}`,
        localDate,
        now
      });
      if (queued.run) result.enqueued.push("weekly_schedule_update");
    } else {
      result.skipped.push("weekly_schedule_update:not_dirty_or_not_due_week");
    }
  }

  for (const routine of bundle.automationConfig.routines) {
    if (
      !routine.enabled ||
      !routine.weekdays.includes(parts.weekday) ||
      !isWithinDueWindow(
        now,
        timezone,
        routine.time,
        bundle.automationConfig.schedulerGraceMinutes
      )
    ) {
      continue;
    }
    const queued = await enqueueTask(env, {
      bundle,
      taskKey: "automation_routine",
      triggerMode: "scheduled",
      scheduleKey: `automation_routine:${routine.id}:${localDate}`,
      localDate,
      now,
      routine
    });
    if (queued.run) result.enqueued.push(`automation_routine:${routine.id}`);
  }

  return result;
}

async function maybeEnqueueDaily(
  env: Env,
  bundle: ConfigBundle,
  now: Date,
  localDate: string,
  taskKey: Exclude<keyof ConfigBundle["automationConfig"]["tasks"], "weekly_schedule_update">,
  result: SchedulerResult,
  options: { targetDate?: string } = {}
): Promise<void> {
  const schedule = bundle.automationConfig.tasks[taskKey];
  if (!schedule.enabled) {
    result.skipped.push(`${taskKey}:disabled`);
    return;
  }
  if (
    !isWithinDueWindow(
      now,
      bundle.automationConfig.timezone,
      schedule.time,
      bundle.automationConfig.schedulerGraceMinutes
    )
  ) {
    return;
  }
  const keyDate = options.targetDate ?? localDate;
  const queued = await enqueueTask(env, {
    bundle,
    taskKey,
    triggerMode: "scheduled",
    scheduleKey: `${taskKey}:${keyDate}`,
    localDate,
    targetDate: options.targetDate,
    now
  });
  if (queued.run) result.enqueued.push(taskKey);
}
