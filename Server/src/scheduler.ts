import { getConfigBundle } from "./db";
import type { ConfigBundle } from "./domain";
import { enqueueTask } from "./tasks";
import {
  dateKey,
  isWithinDueWindow,
  targetDateForTechnologyRun,
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
  taskKey: keyof ConfigBundle["automationConfig"]["tasks"],
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
