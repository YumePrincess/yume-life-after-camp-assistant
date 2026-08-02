import { expireUnclaimedRuns, getConfigBundle } from "./db";
import type { ConfigBundle } from "./domain";
import { archiveTechnologyVoteHistoryAtDailyReset, enqueueTask } from "./tasks";
import { effectiveWorkerPlugins } from "./plugin-system";
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
  timedOut: string[];
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
    skipped: [],
    timedOut: []
  };
  result.timedOut = await expireUnclaimedRuns(
    env,
    bundle.automationConfig.agentPolling.claimTimeoutMinutes,
    now
  );
  const enabledTaskKeys = new Set(
    (await effectiveWorkerPlugins(env))
      .filter((plugin) => plugin.enabled)
      .flatMap((plugin) => plugin.tasks.map((task) => task.key))
  );
  if (enabledTaskKeys.has("tech_switch")) {
    await archiveTechnologyVoteHistoryAtDailyReset(env, bundle, now);
  }
  for (const taskKey of Object.keys(bundle.automationConfig.tasks) as Array<
    keyof ConfigBundle["automationConfig"]["tasks"]
  >) {
    if (!enabledTaskKeys.has(taskKey)) {
      result.skipped.push(`${taskKey}:plugin-disabled`);
      continue;
    }
    const schedule = bundle.automationConfig.tasks[taskKey];
    const times = taskKey === "patrol" ? [schedule.time] : schedule.times;
    for (let slot = 0; slot < times.length; slot += 1) {
      await maybeEnqueueDaily(
        env,
        bundle,
        now,
        localDate,
        taskKey,
        times[slot] ?? schedule.time,
        slot,
        result,
        taskKey === "tech_switch"
          ? {
              targetDate: targetDateForTechnologyRun(
                now,
                timezone,
                bundle.campConfig.gameResetTime
              )
            }
          : {}
      );
    }
  }

  return result;
}

async function maybeEnqueueDaily(
  env: Env,
  bundle: ConfigBundle,
  now: Date,
  localDate: string,
  taskKey: keyof ConfigBundle["automationConfig"]["tasks"],
  scheduledTime: string,
  slot: number,
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
      scheduledTime,
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
    // Keep the legacy key for the first execution so deploying this feature
    // cannot enqueue today's already-completed single-run task again.
    scheduleKey: slot === 0 ? `${taskKey}:${keyDate}` : `${taskKey}:${keyDate}:${slot}`,
    localDate,
    targetDate: options.targetDate,
    now,
    payloadDetail: { scheduleSlot: slot, scheduledTime }
  });
  if (queued.run) result.enqueued.push(taskKey);
}
