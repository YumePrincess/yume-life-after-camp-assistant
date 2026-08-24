import {
  appendRunEvent,
  createCommand,
  expireUnclaimedRuns,
  finalizeExpiredCancellations,
  findActiveRunForAgent,
  getConfigBundle,
  listQueueGuardRuns,
  requestRunCancellation,
  suppressScheduledRetry,
  updateRun
} from "./db";
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
  await finalizeExpiredCancellations(env, now);
  await enforceQueueProtection(env, bundle.campConfig.agentId, now);
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
  const queueGuard = await queueGuardForActiveRun(
    env,
    bundle.campConfig.agentId,
    now
  );
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
    payloadDetail: {
      scheduleSlot: slot,
      scheduledTime,
      ...queueGuard
    }
  });
  if (queued.run) {
    result.enqueued.push(taskKey);
    if (queueGuard.queueGuard) {
      await appendRunEvent(env, {
        runId: queued.run.id,
        level: "warning",
        step: "scheduled_queue_waiting",
        message: "定时任务到达时 Agent 仍被前一任务占用；先等待 15 分钟，超时后终止前一任务",
        detail: queueGuard.queueGuard
      });
    }
  }
}

async function queueGuardForActiveRun(
  env: Env,
  agentId: string,
  now: Date
): Promise<Record<string, unknown>> {
  const active = await findActiveRunForAgent(env, agentId);
  if (!active) return {};
  return {
    queueGuard: {
      blockedRunId: active.id,
      blockedAt: now.toISOString(),
      waitUntil: new Date(now.getTime() + 15 * 60_000).toISOString()
    }
  };
}

async function enforceQueueProtection(
  env: Env,
  agentId: string,
  now: Date
): Promise<void> {
  if (!agentId) return;
  const waitingRuns = await listQueueGuardRuns(env, agentId);
  for (const waitingRun of waitingRuns) {
    const detail = parseObject(waitingRun.detail_json);
    const guard = parseObject(detail.queueGuard);
    const waitUntil = Date.parse(String(guard.waitUntil || ""));
    if (!Number.isFinite(waitUntil) || now.getTime() < waitUntil) continue;
    if (guard.interruptSentAt) continue;
    const active = await findActiveRunForAgent(env, agentId, waitingRun.id, false);
    if (!active) continue;

    const reason = "scheduled_queue_guard_timeout";
    await suppressScheduledRetry(env, active.id, reason);
    await requestRunCancellation(env, active.id);
    await createCommand(env, {
      runId: active.id,
      agentId,
      type: "interrupt_task",
      payload: {
        runId: active.id,
        taskKey: active.task_key,
        requestedBy: "scheduler",
        requestedAt: now.toISOString(),
        reason
      },
      priority: 100
    });
    await updateRun(env, {
      runId: waitingRun.id,
      detail: {
        ...detail,
        queueGuard: {
          ...guard,
          interruptSentAt: now.toISOString(),
          interruptedRunId: active.id
        }
      }
    });
    await appendRunEvent(env, {
      runId: waitingRun.id,
      level: "warning",
      step: "scheduled_queue_guard_force_interrupt",
      message: "前一任务占用 Agent 已超过 15 分钟；已发送强制终止指令，前一任务不再进入失败重试队列",
      detail: { activeRunId: active.id, waitMinutes: 15 }
    });
    await appendRunEvent(env, {
      runId: active.id,
      level: "warning",
      step: "scheduled_queue_guard_interrupted",
      message: "定时任务队列保护已强制终止当前任务；本次任务不再进入失败重试队列",
      detail: { waitingRunId: waitingRun.id, waitMinutes: 15 }
    });
  }
}

function parseObject(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}
