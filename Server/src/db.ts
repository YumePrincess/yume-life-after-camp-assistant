import type {
  AgentHeartbeat,
  CommandRow,
  ConfigBundle,
  RunState,
  TaskKey,
  TaskRun,
  TriggerMode
} from "./domain";
import { BUILT_IN_TECHNOLOGY_CATALOG } from "./built-in-technology-catalog";
import {
  validateAutomationConfig,
  validateAuthConfig,
  validateCampConfig,
  validatePublicOverview,
  validateTechnologyConfig
} from "./validate";

function isoNow(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function getSetting(env: Env, key: string): Promise<unknown> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  if (!row) throw new Error(`Missing setting: ${key}`);
  return JSON.parse(row.value) as unknown;
}

export async function getConfigBundle(env: Env): Promise<ConfigBundle> {
  const [camp, auth, overview, technology, automation] = await Promise.all([
    getSetting(env, "camp_config"),
    getSetting(env, "auth_config"),
    getSetting(env, "public_overview"),
    getSetting(env, "technology_config"),
    getSetting(env, "automation_config")
  ]);
  const technologyConfig = validateTechnologyConfig(technology);
  const technologyOverrides = new Map(
    technologyConfig.catalog.map((item) => [item.key, item])
  );
  const validTechnologyKeys = new Set(
    BUILT_IN_TECHNOLOGY_CATALOG.map((item) => item.key)
  );
  technologyConfig.catalog = BUILT_IN_TECHNOLOGY_CATALOG.map((item) => {
    const override = technologyOverrides.get(item.key);
    return {
      ...item,
      lane: override?.lane ?? item.lane,
      enabledForVoting:
        override?.enabledForVoting ?? item.enabledForVoting
    };
  });
  for (const weekday of Object.keys(technologyConfig.fixedByWeekday)) {
    technologyConfig.fixedByWeekday[weekday] =
      technologyConfig.fixedByWeekday[weekday]!.filter((key) =>
        validTechnologyKeys.has(key)
      );
  }
  for (const date of Object.keys(technologyConfig.fixedByDate)) {
    technologyConfig.fixedByDate[date] =
      technologyConfig.fixedByDate[date]!.filter((key) =>
        validTechnologyKeys.has(key)
      );
  }
  return {
    campConfig: validateCampConfig(camp),
    authConfig: validateAuthConfig(auth),
    publicOverview: validatePublicOverview(overview),
    technologyConfig,
    automationConfig: validateAutomationConfig(automation)
  };
}

export async function saveConfigBundle(env: Env, bundle: ConfigBundle): Promise<void> {
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind("camp_config", JSON.stringify(bundle.campConfig), now),
    env.DB.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind("auth_config", JSON.stringify(bundle.authConfig), now),
    env.DB.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind("public_overview", JSON.stringify(bundle.publicOverview), now),
    env.DB.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind("technology_config", JSON.stringify(bundle.technologyConfig), now),
    env.DB.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind("automation_config", JSON.stringify(bundle.automationConfig), now),
  ]);
}

export interface SessionRow {
  id: string;
  csrf_token: string;
  email: string;
  display_name: string | null;
  auth_method: "oidc" | "temporary_key";
  permissions_json: string;
  oidc_id_token: string | null;
  oidc_last_checked_at: string | null;
  temp_key_id: string | null;
  created_at: string;
  expires_at: string;
  last_checked_at: string;
}

export async function saveSession(env: Env, session: SessionRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions(
       id, csrf_token, email, display_name, auth_method, permissions_json,
       oidc_id_token, oidc_last_checked_at, temp_key_id,
       created_at, expires_at, last_checked_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      session.id,
      session.csrf_token,
      session.email,
      session.display_name,
      session.auth_method,
      session.permissions_json,
      session.oidc_id_token,
      session.oidc_last_checked_at,
      session.temp_key_id,
      session.created_at,
      session.expires_at,
      session.last_checked_at
    )
    .run();
}

export interface TemporaryKeyRow {
  id: string;
  name: string;
  secret_hash: string;
  permissions_json: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function createTemporaryKey(
  env: Env,
  input: Omit<TemporaryKeyRow, "last_used_at" | "revoked_at">
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO temporary_keys(
       id, name, secret_hash, permissions_json, created_by, created_at, expires_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      input.name,
      input.secret_hash,
      input.permissions_json,
      input.created_by,
      input.created_at,
      input.expires_at
    )
    .run();
}

export async function getTemporaryKey(
  env: Env,
  id: string
): Promise<TemporaryKeyRow | null> {
  return env.DB.prepare("SELECT * FROM temporary_keys WHERE id = ?")
    .bind(id)
    .first<TemporaryKeyRow>();
}

export async function markTemporaryKeyUsed(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE temporary_keys SET last_used_at = ? WHERE id = ?")
    .bind(isoNow(), id)
    .run();
}

export async function listTemporaryKeys(env: Env): Promise<
  Omit<TemporaryKeyRow, "secret_hash">[]
> {
  const result = await env.DB.prepare(
    `SELECT id, name, permissions_json, created_by, created_at, expires_at,
            last_used_at, revoked_at
     FROM temporary_keys
     ORDER BY created_at DESC
     LIMIT 100`
  ).all<Omit<TemporaryKeyRow, "secret_hash">>();
  return result.results;
}

export async function revokeTemporaryKey(env: Env, id: string): Promise<boolean> {
  const now = isoNow();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE temporary_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
    ).bind(now, id),
    env.DB.prepare(
      "DELETE FROM sessions WHERE auth_method = 'temporary_key' AND temp_key_id = ?"
    ).bind(id)
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

export async function getSession(env: Env, id: string): Promise<SessionRow | null> {
  return env.DB.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(id, isoNow())
    .first<SessionRow>();
}

export async function deleteSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export async function deleteExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(isoNow()).run();
}

export async function saveBallot(
  env: Env,
  input: {
    pollDate: string;
    voterId: string;
    voterName: string;
    selections: string[];
  }
): Promise<void> {
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO tech_ballots(id, poll_date, voter_id, voter_name, selections_json, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(poll_date, voter_id) DO UPDATE SET
       voter_name = excluded.voter_name,
       selections_json = excluded.selections_json,
       updated_at = excluded.updated_at`
  )
    .bind(
      crypto.randomUUID(),
      input.pollDate,
      input.voterId,
      input.voterName || null,
      JSON.stringify(input.selections),
      now,
      now
    )
    .run();
}

export async function listBallots(
  env: Env,
  pollDate: string
): Promise<Array<{ selections: string[] }>> {
  const result = await env.DB.prepare(
    "SELECT selections_json FROM tech_ballots WHERE poll_date = ?"
  )
    .bind(pollDate)
    .all<{ selections_json: string }>();
  return result.results.map((row) => ({
    selections: parseJson<string[]>(row.selections_json, [])
  }));
}

export async function listMembers(env: Env, limit = 200): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT id, name, profession, manor_level, roommate_name, camp_title,
            weekly_contribution, technology_points_used, material_contribution,
            last_active_text, inactive_days, activity_captured_at, last_seen_at
     FROM members
     ORDER BY weekly_contribution DESC, name ASC
     LIMIT ?`
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function listStaff(env: Env): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT role_key, role_name, member_id, member_name, updated_at
     FROM staff_assignments
     ORDER BY role_key ASC`
  ).all<Record<string, unknown>>();
  return result.results;
}

export async function replaceMemberSnapshot(
  env: Env,
  input: {
    runId: string;
    snapshotDate: string;
    capturedAt: string;
    members: Array<{
      name: string;
      profession: string | null;
      manorLevel: number | null;
      roommateName: string | null;
      campTitle: string | null;
      weeklyContribution: number;
      technologyPointsUsed: number;
      materialContribution: number;
      lastActiveText: string | null;
      inactiveDays: number | null;
    }>;
  }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const member of input.members) {
    const memberId = await stableMemberId(member.name);
    statements.push(
      env.DB.prepare(
        `INSERT INTO members(
           id, name, profession, manor_level, roommate_name, camp_title,
           weekly_contribution, technology_points_used, material_contribution,
           last_active_text, inactive_days, activity_captured_at,
           last_seen_at, source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           profession = excluded.profession,
           manor_level = excluded.manor_level,
           roommate_name = excluded.roommate_name,
           camp_title = excluded.camp_title,
           weekly_contribution = excluded.weekly_contribution,
           technology_points_used = excluded.technology_points_used,
           material_contribution = excluded.material_contribution,
           last_active_text = excluded.last_active_text,
           inactive_days = excluded.inactive_days,
           activity_captured_at = excluded.activity_captured_at,
           last_seen_at = excluded.last_seen_at,
           source_run_id = excluded.source_run_id`
      ).bind(
        memberId,
        member.name,
        member.profession,
        member.manorLevel,
        member.roommateName,
        member.campTitle,
        member.weeklyContribution,
        member.technologyPointsUsed,
        member.materialContribution,
        member.lastActiveText,
        member.inactiveDays,
        input.capturedAt,
        input.capturedAt,
        input.runId
      ),
      env.DB.prepare(
        `INSERT INTO member_snapshots(
           id, member_id, member_name, snapshot_date, profession, manor_level,
           roommate_name, camp_title, weekly_contribution, technology_points_used,
           material_contribution, last_active_text, inactive_days,
           captured_at, source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        memberId,
        member.name,
        input.snapshotDate,
        member.profession,
        member.manorLevel,
        member.roommateName,
        member.campTitle,
        member.weeklyContribution,
        member.technologyPointsUsed,
        member.materialContribution,
        member.lastActiveText,
        member.inactiveDays,
        input.capturedAt,
        input.runId
      )
    );
  }
  if (statements.length) {
    await env.DB.batch(statements);
    await env.DB.prepare(
      "DELETE FROM members WHERE source_run_id IS NULL OR source_run_id <> ?"
    ).bind(input.runId).run();
  }
}

export async function updateContributionSnapshot(
  env: Env,
  input: {
    runId: string;
    capturedAt: string;
    members: Array<{
      name: string;
      weeklyContribution: number;
      technologyPointsUsed: number;
      materialContribution: number;
    }>;
  }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const member of input.members) {
    const memberId = await stableMemberId(member.name);
    statements.push(
      env.DB.prepare(
        `INSERT INTO members(
           id, name, weekly_contribution, technology_points_used,
           material_contribution, last_seen_at, source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           weekly_contribution = excluded.weekly_contribution,
           technology_points_used = excluded.technology_points_used,
           material_contribution = excluded.material_contribution,
           last_seen_at = excluded.last_seen_at,
           source_run_id = excluded.source_run_id`
      ).bind(
        memberId,
        member.name,
        member.weeklyContribution,
        member.technologyPointsUsed,
        member.materialContribution,
        input.capturedAt,
        input.runId
      )
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function updateActivitySnapshot(
  env: Env,
  input: {
    runId: string;
    capturedAt: string;
    members: Array<{
      name: string;
      lastActiveText: string | null;
      inactiveDays: number | null;
    }>;
  }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const member of input.members) {
    const memberId = await stableMemberId(member.name);
    statements.push(
      env.DB.prepare(
        `INSERT INTO members(
           id, name, last_active_text, inactive_days, activity_captured_at,
           last_seen_at, source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           last_active_text = excluded.last_active_text,
           inactive_days = excluded.inactive_days,
           activity_captured_at = excluded.activity_captured_at,
           last_seen_at = excluded.last_seen_at,
           source_run_id = excluded.source_run_id`
      ).bind(
        memberId,
        member.name,
        member.lastActiveText,
        member.inactiveDays,
        input.capturedAt,
        input.capturedAt,
        input.runId
      )
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function updateMemberProfiles(
  env: Env,
  input: {
    runId: string;
    capturedAt: string;
    members: Array<{
      name: string;
      profession: string | null;
      manorLevel: number | null;
      roommateName: string | null;
      campTitle: string | null;
    }>;
  }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const member of input.members) {
    const memberId = await stableMemberId(member.name);
    statements.push(
      env.DB.prepare(
        `INSERT INTO members(
           id, name, profession, manor_level, roommate_name, camp_title,
           last_seen_at, source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           profession = excluded.profession,
           manor_level = excluded.manor_level,
           roommate_name = excluded.roommate_name,
           camp_title = excluded.camp_title,
           last_seen_at = excluded.last_seen_at,
           source_run_id = excluded.source_run_id`
      ).bind(
        memberId,
        member.name,
        member.profession,
        member.manorLevel,
        member.roommateName,
        member.campTitle,
        input.capturedAt,
        input.runId
      )
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function removeCurrentMembers(
  env: Env,
  names: string[]
): Promise<void> {
  if (!names.length) return;
  for (let offset = 0; offset < names.length; offset += 80) {
    const batch = names.slice(offset, offset + 80);
    const placeholders = batch.map(() => "?").join(",");
    await env.DB.prepare(
      `DELETE FROM members WHERE name IN (${placeholders})`
    ).bind(...batch).run();
  }
}

export async function replaceStaffSnapshot(
  env: Env,
  input: {
    runId: string;
    capturedAt: string;
    staff: Array<{ roleKey: string; roleName: string; memberName: string | null }>;
  }
): Promise<void> {
  const statements = input.staff.map((item) =>
    env.DB.prepare(
      `INSERT INTO staff_assignments(
         role_key, role_name, member_id, member_name, updated_at, source_run_id
       ) VALUES(?, ?, (SELECT id FROM members WHERE name = ?), ?, ?, ?)
       ON CONFLICT(role_key) DO UPDATE SET
         role_name = excluded.role_name,
         member_id = excluded.member_id,
         member_name = excluded.member_name,
         updated_at = excluded.updated_at,
         source_run_id = excluded.source_run_id`
    ).bind(
      item.roleKey,
      item.roleName,
      item.memberName,
      item.memberName,
      input.capturedAt,
      input.runId
    )
  );
  if (statements.length) await env.DB.batch(statements);
}

async function stableMemberId(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
  return `member_${Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function createRun(
  env: Env,
  input: {
    taskKey: TaskKey;
    scheduleKey?: string | null;
    triggerMode: TriggerMode;
    message: string;
    detail?: unknown;
    localDate?: string | null;
  }
): Promise<TaskRun | null> {
  const now = isoNow();
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO task_runs(
       id, task_key, schedule_key, trigger_mode, state, message, progress,
       cancel_requested, detail_json, local_date, created_at, updated_at
     ) VALUES(?, ?, ?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?)
     RETURNING *`
  )
    .bind(
      id,
      input.taskKey,
      input.scheduleKey ?? null,
      input.triggerMode,
      input.message,
      JSON.stringify(input.detail ?? {}),
      input.localDate ?? null,
      now,
      now
    )
    .first<TaskRun>();
  return result;
}

export async function getRun(env: Env, runId: string): Promise<TaskRun | null> {
  return env.DB.prepare("SELECT * FROM task_runs WHERE id = ?")
    .bind(runId)
    .first<TaskRun>();
}

export async function listRecentRuns(env: Env, limit = 50): Promise<TaskRun[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM task_runs ORDER BY created_at DESC LIMIT ?"
  )
    .bind(limit)
    .all<TaskRun>();
  return result.results;
}

export async function listRunEvents(
  env: Env,
  runId: string,
  limit = 200
): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    "SELECT id, level, step, message, detail_json, created_at FROM task_events WHERE run_id = ? ORDER BY id DESC LIMIT ?"
  )
    .bind(runId, limit)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function updateRun(
  env: Env,
  input: {
    runId: string;
    state?: RunState;
    message?: string;
    currentStep?: string | null;
    progress?: number;
    detail?: unknown;
  }
): Promise<TaskRun | null> {
  const current = await getRun(env, input.runId);
  if (!current) return null;
  const state = input.state ?? current.state;
  const now = isoNow();
  const startedAt =
    current.started_at ?? (state === "running" || state === "claimed" ? now : null);
  const terminal = ["interrupted", "succeeded", "failed", "skipped"].includes(state);
  return env.DB.prepare(
    `UPDATE task_runs SET
       state = ?,
       message = ?,
       current_step = ?,
       progress = ?,
       detail_json = ?,
       started_at = ?,
       finished_at = ?,
       updated_at = ?
     WHERE id = ?
     RETURNING *`
  )
    .bind(
      state,
      input.message ?? current.message,
      input.currentStep === undefined ? current.current_step : input.currentStep,
      input.progress === undefined
        ? current.progress
        : Math.min(1, Math.max(0, input.progress)),
      input.detail === undefined ? current.detail_json : JSON.stringify(input.detail),
      startedAt,
      terminal ? now : current.finished_at,
      now,
      input.runId
    )
    .first<TaskRun>();
}

export async function requestRunCancellation(env: Env, runId: string): Promise<boolean> {
  const now = isoNow();
  const [runResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_runs SET
         cancel_requested = 1,
         state = CASE WHEN state IN ('queued', 'claimed', 'running') THEN 'cancelling' ELSE state END,
         updated_at = ?
       WHERE id = ? AND state IN ('queued', 'claimed', 'running', 'cancelling')`
    ).bind(now, runId),
    env.DB.prepare(
      `UPDATE command_queue SET
         state = 'cancelled',
         message = '任务在领取前被管理员取消',
         finished_at = ?
       WHERE run_id = ? AND type = 'run_task' AND state = 'queued'`
    ).bind(now, runId)
  ]);
  return (runResult?.meta.changes ?? 0) > 0;
}

export async function appendRunEvent(
  env: Env,
  input: {
    runId: string;
    level: "debug" | "info" | "warning" | "error";
    step?: string | null;
    message: string;
    detail?: unknown;
  }
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO task_events(run_id, level, step, message, detail_json, created_at) VALUES(?, ?, ?, ?, ?, ?)"
  )
    .bind(
      input.runId,
      input.level,
      input.step ?? null,
      input.message,
      JSON.stringify(input.detail ?? {}),
      isoNow()
    )
    .run();
}

export async function createCommand(
  env: Env,
  input: {
    runId?: string | null;
    agentId: string;
    type: "run_task" | "interrupt_task";
    payload: unknown;
    priority?: number;
    availableAt?: string;
  }
): Promise<CommandRow> {
  const id = crypto.randomUUID();
  const now = isoNow();
  return env.DB.prepare(
    `INSERT INTO command_queue(
       id, run_id, agent_id, type, payload_json, state, priority,
       attempt_count, created_at, available_at
     ) VALUES(?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)
     RETURNING *`
  )
    .bind(
      id,
      input.runId ?? null,
      input.agentId,
      input.type,
      JSON.stringify(input.payload),
      input.priority ?? (input.type === "interrupt_task" ? 100 : 0),
      now,
      input.availableAt ?? now
    )
    .first<CommandRow>()
    .then((row) => {
      if (!row) throw new Error("Unable to create command");
      return row;
    });
}

export async function claimNextCommand(
  env: Env,
  input: { agentId: string; busy: boolean }
): Promise<CommandRow | null> {
  const now = isoNow();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const allowedClause = input.busy ? "AND type = 'interrupt_task'" : "";
  return env.DB.prepare(
    `UPDATE command_queue SET
       state = 'claimed',
       lease_token = ?,
       lease_expires_at = ?,
       claimed_at = ?,
       attempt_count = attempt_count + 1
     WHERE id = (
       SELECT id FROM command_queue
       WHERE agent_id = ?
         AND available_at <= ?
         AND (
           state = 'queued'
           OR (state = 'claimed' AND lease_expires_at < ?)
         )
         ${allowedClause}
       ORDER BY priority DESC, created_at ASC
       LIMIT 1
     )
     RETURNING *`
  )
    .bind(leaseToken, leaseExpiresAt, now, input.agentId, now, now)
    .first<CommandRow>();
}

export async function completeCommand(
  env: Env,
  input: {
    commandId: string;
    leaseToken: string;
    state: "completed" | "failed" | "cancelled";
    message: string;
  }
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE command_queue SET
       state = ?, message = ?, finished_at = ?, lease_expires_at = NULL
     WHERE id = ? AND state = 'claimed' AND lease_token = ?`
  )
    .bind(input.state, input.message, isoNow(), input.commandId, input.leaseToken)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function touchHeartbeat(
  env: Env,
  input: {
    agentId: string;
    activeRunId: string | null;
    activeTaskKey: TaskKey | null;
    status: string;
    capabilities: unknown;
    detail: unknown;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_heartbeats(
       agent_id, active_run_id, active_task_key, status,
       capabilities_json, detail_json, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       active_run_id = excluded.active_run_id,
       active_task_key = excluded.active_task_key,
       status = excluded.status,
       capabilities_json = excluded.capabilities_json,
       detail_json = excluded.detail_json,
       updated_at = excluded.updated_at`
  )
    .bind(
      input.agentId,
      input.activeRunId,
      input.activeTaskKey,
      input.status,
      JSON.stringify(input.capabilities),
      JSON.stringify(input.detail),
      isoNow()
    )
    .run();
}

export async function listHeartbeats(env: Env): Promise<AgentHeartbeat[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM agent_heartbeats ORDER BY updated_at DESC"
  ).all<AgentHeartbeat>();
  return result.results;
}

export async function getHeartbeat(
  env: Env,
  agentId: string
): Promise<AgentHeartbeat | null> {
  return env.DB.prepare("SELECT * FROM agent_heartbeats WHERE agent_id = ?")
    .bind(agentId)
    .first<AgentHeartbeat>();
}
