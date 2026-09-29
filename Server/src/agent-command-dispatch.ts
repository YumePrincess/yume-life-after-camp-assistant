import {
  claimNextCommand,
  completeCommand,
  expireUnclaimedRuns,
  finalizeAgentCancellations,
  finalizeExpiredCancellations,
  getConfigBundle,
  reconcileStaleCommands,
  updateRun
} from "./db";
import { normalizeLocale } from "./locale";
import { builtPluginForTask, effectiveWorkerPlugins } from "./plugin-system";

export interface AgentCommandEnvelope {
  id: string;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
  leaseToken: string | null;
  attemptCount: number;
}

export interface AgentCommandClaim {
  enabled: boolean;
  activeAgentId: string | null;
  claimTimeoutMinutes: number;
  command: AgentCommandEnvelope | null;
}

export async function claimAgentCommand(
  env: Env,
  input: { agentId: string; busy: boolean; locale?: unknown }
): Promise<AgentCommandClaim> {
  const bundle = await getConfigBundle(env);
  const enabled = Boolean(bundle.campConfig.agentId) &&
    bundle.campConfig.agentId === input.agentId;
  await reconcileStaleCommands(env);
  await finalizeAgentCancellations(env, {
    agentId: input.agentId,
    activeRunId: null
  });
  await finalizeExpiredCancellations(env);
  await expireUnclaimedRuns(env, bundle.automationConfig.agent.claimTimeoutMinutes);

  let row = enabled
    ? await claimNextCommand(env, {
        agentId: input.agentId,
        busy: input.busy
      })
    : null;
  if (!row) {
    return {
      enabled,
      activeAgentId: bundle.campConfig.agentId || null,
      claimTimeoutMinutes: bundle.automationConfig.agent.claimTimeoutMinutes,
      command: null
    };
  }

  const payload = safeParseObject(row.payload_json);
  const commandPayload: Record<string, unknown> = {
    ...payload,
    ...(row.run_id ? { runId: row.run_id } : {})
  };
  if (row.type === "run_task") {
    const detail = objectValue(commandPayload.detail);
    commandPayload.locale = normalizeLocale(
      input.locale ?? payload.locale ?? detail.locale
    );
    const disabledTasks = taskKeysFromCommandPayload(commandPayload).filter(
      (taskKey) => builtPluginForTask(taskKey)
    );
    const enabledTasks = new Set(
      (await effectiveWorkerPlugins(env))
        .filter((plugin) => plugin.enabled)
        .flatMap((plugin) => plugin.tasks.map((task) => task.key))
    );
    const unavailableTasks = disabledTasks.filter((taskKey) => !enabledTasks.has(taskKey));
    if (unavailableTasks.length && row.lease_token) {
      await completeCommand(env, {
        commandId: row.id,
        leaseToken: row.lease_token,
        state: "cancelled",
        message: `Workers 插件已停用：${unavailableTasks.join(", ")}`
      });
      if (row.run_id) {
        await updateRun(env, {
          runId: row.run_id,
          state: "interrupted",
          message: `对应 Workers 插件已停用：${unavailableTasks.join(", ")}`,
          currentStep: null
        });
      }
      row = null;
    }
  }

  return {
    enabled,
    activeAgentId: bundle.campConfig.agentId || null,
    claimTimeoutMinutes: bundle.automationConfig.agent.claimTimeoutMinutes,
    command: row
      ? {
          id: row.id,
          runId: row.run_id,
          type: row.type,
          payload: commandPayload,
          leaseToken: row.lease_token,
          attemptCount: row.attempt_count
        }
      : null
  };
}

function safeParseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function taskKeysFromCommandPayload(payload: Record<string, unknown>): string[] {
  const direct = typeof payload.taskKey === "string" ? [payload.taskKey] : [];
  const detail = objectValue(payload.detail);
  const routine = objectValue(detail.routine);
  const groups = Array.isArray(routine.groups) ? routine.groups : [];
  return [...new Set([
    ...direct,
    ...groups.flatMap((group) =>
      Array.isArray(group)
        ? group.filter((item): item is string => typeof item === "string")
        : []
    )
  ])];
}
