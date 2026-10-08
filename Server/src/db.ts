import type {
  AgentHeartbeat,
  CommandRow,
  ConfigBundle,
  RunState,
  TaskKey,
  TaskRun,
  TriggerMode,
  TechnologyVoteHistory
} from "./domain";
import { BUILT_IN_TECHNOLOGY_CATALOG } from "../plugins/technology/catalog";
import {
  validateAutomationConfig,
  validateAuthConfig,
  validateCampConfig,
  validatePublicOverview,
  validateTechnologyConfig
} from "./validate";
import {
  rebaseTimestampToTimezone,
  zonedDateKey,
  zonedDateTimeToIso
} from "./time";
import { identityPlayerNameKey } from "./identity-code-utils";
import { decryptSecret } from "./crypto";
import { notifyAgentCommandAvailable } from "./agent-notifications";

function isoNow(): string {
  return new Date().toISOString();
}

const TERMINAL_RUN_STATES = [
  "interrupted",
  "succeeded",
  "partially_succeeded",
  "failed",
  "timed_out",
  "skipped"
] as const;

function isTerminalRunState(state: string): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
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

export async function getWorkerPluginStateMap(env: Env): Promise<Record<string, boolean>> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind("worker_plugin_states")
    .first<{ value: string }>();
  const parsed = parseJson<unknown>(row?.value, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
    )
  );
}

export async function saveWorkerPluginStateMap(
  env: Env,
  states: Record<string, boolean>
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind("worker_plugin_states", JSON.stringify(states), isoNow())
    .run();
}

export async function cancelQueuedRunsForTaskKeys(
  env: Env,
  taskKeys: string[]
): Promise<void> {
  const unique = [...new Set(taskKeys.filter(Boolean))];
  if (!unique.length) return;
  const placeholders = unique.map(() => "?").join(", ");
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE command_queue
       SET state = 'cancelled', finished_at = ?, message = '对应 Workers 插件已停用'
       WHERE state = 'queued'
         AND run_id IN (
           SELECT id FROM task_runs WHERE task_key IN (${placeholders}) AND state = 'queued'
         )`
    ).bind(now, ...unique),
    env.DB.prepare(
      `UPDATE task_runs
       SET state = 'interrupted', message = '对应 Workers 插件已停用',
           finished_at = ?, updated_at = ?
       WHERE state = 'queued' AND task_key IN (${placeholders})`
    ).bind(now, now, ...unique)
  ]);
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
  if (Array.isArray(technologyConfig.fixedPresets)) {
    technologyConfig.fixedPresets = technologyConfig.fixedPresets
      .map((preset) => ({
        ...preset,
        technologyKeys: preset.technologyKeys.filter((key) =>
          validTechnologyKeys.has(key)
        )
      }))
      .filter((preset) => preset.technologyKeys.length > 0);
  }
  const campConfig = validateCampConfig(camp);
  const automationConfig = validateAutomationConfig(automation);
  return {
    campConfig,
    authConfig: validateAuthConfig(auth),
    publicOverview: validatePublicOverview(overview),
    technologyConfig,
    // The administrator-facing site timezone is the single source of truth.
    // Older settings may contain a different automation timezone; normalize
    // it on read so all scheduling and vote logic follows the site setting.
    automationConfig: { ...automationConfig, timezone: campConfig.timezone }
  };
}

export async function saveConfigBundle(
  env: Env,
  bundle: ConfigBundle,
  previousTimezone?: string
): Promise<void> {
  const now = isoNow();
  const automationConfig = {
    ...bundle.automationConfig,
    timezone: bundle.campConfig.timezone
  };
  const statements = [
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
    ).bind("automation_config", JSON.stringify(automationConfig), now)
  ];

  if (previousTimezone && previousTimezone !== bundle.campConfig.timezone) {
    const items = await env.DB.prepare(
      "SELECT id, start_at, end_at FROM daily_vote_items WHERE end_at > ?"
    ).bind(now).all<{ id: string; start_at: string; end_at: string }>();
    for (const item of items.results) {
      const startAt = rebaseTimestampToTimezone(
        item.start_at,
        previousTimezone,
        bundle.campConfig.timezone
      );
      const endAt = rebaseTimestampToTimezone(
        item.end_at,
        previousTimezone,
        bundle.campConfig.timezone
      );
      if (startAt === item.start_at && endAt === item.end_at) continue;
      statements.push(env.DB.prepare(
        `UPDATE daily_vote_items
         SET start_at = ?, end_at = ?, updated_at = ?
         WHERE id = ? AND end_at > ?`
      ).bind(startAt, endAt, now, item.id, now));
    }
  }

  await env.DB.batch(statements);
}

export async function activateAgentIdentity(
  env: Env,
  bundle: ConfigBundle,
  agentId: string
): Promise<ConfigBundle> {
  const next: ConfigBundle = {
    ...bundle,
    campConfig: { ...bundle.campConfig, agentId }
  };
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind("camp_config", JSON.stringify(next.campConfig), now),
    env.DB.prepare(
      "UPDATE command_queue SET agent_id = ? WHERE agent_id <> ? AND state = 'queued'"
    ).bind(agentId, agentId)
  ]);
  await notifyAgentCommandAvailable(env, agentId);
  return next;
}

export async function registerAgentDevice(
  env: Env,
  input: { agentId: string; displayName: string }
): Promise<{ activeAgentId: string; enabled: boolean }> {
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_heartbeats(
         agent_id, display_name, active_run_id, active_task_key, status,
         capabilities_json, detail_json, first_seen_at, updated_at
       ) VALUES(?, ?, NULL, NULL, 'registered', '{}', '{}', ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`
    ).bind(input.agentId, input.displayName, now, now),
    env.DB.prepare(
      `UPDATE settings SET
         value = json_set(value, '$.agentId', ?),
         updated_at = ?
       WHERE key = 'camp_config'
         AND COALESCE(json_extract(value, '$.agentId'), '') = ''`
    ).bind(input.agentId, now)
  ]);
  const activeAgentId = (await getConfigBundle(env)).campConfig.agentId;
  return { activeAgentId, enabled: activeAgentId === input.agentId };
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
  permanent: number;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function createTemporaryKey(
  env: Env,
  input: Omit<TemporaryKeyRow, "last_used_at" | "revoked_at">
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO temporary_keys(
       id, name, secret_hash, permissions_json, created_by, created_at, expires_at,
       permanent
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      input.name,
      input.secret_hash,
      input.permissions_json,
      input.created_by,
      input.created_at,
      input.expires_at,
      input.permanent
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

export async function listTemporaryKeys(
  env: Env,
  input: {
    page?: number;
    search?: string;
    status?: string;
  } = {}
): Promise<{
  page: number;
  total: number;
  items: Omit<TemporaryKeyRow, "secret_hash">[];
}> {
  const requestedPage = Number.isFinite(input.page) ? Math.trunc(input.page ?? 1) : 1;
  const search = (input.search ?? "").trim().replace(/[%_]/g, "").slice(0, 120);
  const status = ["active", "expired", "revoked", "permanent"].includes(
    input.status ?? ""
  )
    ? input.status ?? ""
    : "";
  const now = isoNow();
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (search) {
    clauses.push("(id LIKE ? OR name LIKE ? OR created_by LIKE ?)");
    const pattern = `%${search}%`;
    bindings.push(pattern, pattern, pattern);
  }
  if (status === "active") {
    clauses.push("revoked_at IS NULL AND (permanent = 1 OR expires_at > ?)");
    bindings.push(now);
  } else if (status === "expired") {
    clauses.push("revoked_at IS NULL AND permanent = 0 AND expires_at <= ?");
    bindings.push(now);
  } else if (status === "revoked") {
    clauses.push("revoked_at IS NOT NULL");
  } else if (status === "permanent") {
    clauses.push("revoked_at IS NULL AND permanent = 1");
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM temporary_keys${where}`
  )
    .bind(...bindings)
    .first<{ total: number }>();
  const total = Number(count?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / 10));
  const page = Math.min(pages, Math.max(1, requestedPage));
  const result = await env.DB.prepare(
    `SELECT id, name, permissions_json, created_by, created_at, expires_at,
            permanent, last_used_at, revoked_at
     FROM temporary_keys${where}
     ORDER BY created_at DESC
     LIMIT 10 OFFSET ?`
  )
    .bind(...bindings, (page - 1) * 10)
    .all<Omit<TemporaryKeyRow, "secret_hash">>();
  return { page, total, items: result.results };
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

export async function deleteRevokedTemporaryKey(
  env: Env,
  id: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM temporary_keys WHERE id = ? AND revoked_at IS NOT NULL"
  )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateTemporaryKeyPermissions(
  env: Env,
  input: { id: string; permissions: string[] }
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE temporary_keys
       SET permissions_json = ?
       WHERE id = ? AND revoked_at IS NULL`
    ).bind(JSON.stringify(input.permissions), input.id),
    env.DB.prepare(
      "DELETE FROM sessions WHERE auth_method = 'temporary_key' AND temp_key_id = ?"
    ).bind(input.id)
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
): Promise<boolean> {
  const now = isoNow();
  const result = await env.DB.prepare(
    `INSERT INTO tech_ballots(id, poll_date, voter_id, voter_name, selections_json, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(poll_date, voter_id) DO NOTHING`
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
  return (result.meta.changes ?? 0) > 0;
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
  return result.results
    .map((row) => parseJson<unknown>(row.selections_json, []))
    .filter((value): value is unknown[] => Array.isArray(value) && value.length > 0)
    .map((value) => ({ selections: value.map(String) }));
}

export async function listVotePollDates(env: Env): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT poll_date, selections_json FROM tech_ballots ORDER BY poll_date DESC"
  ).all<{ poll_date: string; selections_json: string }>();
  return [
    ...new Set(
      result.results
        .filter((row) => {
          const selections = parseJson<unknown>(row.selections_json, []);
          return Array.isArray(selections) && selections.length > 0;
        })
        .map((row) => row.poll_date)
    )
  ];
}

export async function saveTechnologyVoteHistory(
  env: Env,
  history: TechnologyVoteHistory
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO technology_vote_history(
       poll_date, finalized_at, ballot_count, options_json, projected_plan_json,
     fixed_technologies_json, deleted_at
     ) VALUES(?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(poll_date) DO NOTHING`
  )
    .bind(
      history.pollDate,
      history.finalizedAt,
      history.ballotCount,
      JSON.stringify(history.options),
      JSON.stringify(history.projectedPlan),
      JSON.stringify(history.fixedTechnologies)
    )
    .run();
}

interface TechnologyVoteHistoryRow {
  poll_date: string;
  finalized_at: string;
  ballot_count: number;
  options_json: string;
  projected_plan_json: string;
  fixed_technologies_json: string;
}

function parseTechnologyVoteHistory(
  row: TechnologyVoteHistoryRow
): TechnologyVoteHistory {
  const projectedPlan = parseJson<TechnologyVoteHistory["projectedPlan"]>(
    row.projected_plan_json,
    { core: [], general: [] }
  );
  return {
    pollDate: row.poll_date,
    finalizedAt: row.finalized_at,
    ballotCount: Number(row.ballot_count) || 0,
    options: parseJson<TechnologyVoteHistory["options"]>(row.options_json, []),
    projectedPlan: {
      core: Array.isArray(projectedPlan.core) ? projectedPlan.core : [],
      general: Array.isArray(projectedPlan.general) ? projectedPlan.general : []
    },
    fixedTechnologies: parseJson<TechnologyVoteHistory["fixedTechnologies"]>(
      row.fixed_technologies_json,
      []
    )
  };
}

export async function listTechnologyVoteHistory(
  env: Env
): Promise<Array<Pick<TechnologyVoteHistory, "pollDate" | "finalizedAt" | "ballotCount">>> {
  const result = await env.DB.prepare(
    `SELECT poll_date, finalized_at, ballot_count
     FROM technology_vote_history
     WHERE deleted_at IS NULL
     ORDER BY poll_date DESC`
  ).all<Pick<TechnologyVoteHistoryRow, "poll_date" | "finalized_at" | "ballot_count">>();
  return result.results.map((row) => ({
    pollDate: row.poll_date,
    finalizedAt: row.finalized_at,
    ballotCount: Number(row.ballot_count) || 0
  }));
}

export async function listRecordedTechnologyVoteHistoryDates(
  env: Env
): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT poll_date FROM technology_vote_history"
  ).all<{ poll_date: string }>();
  return result.results.map((row) => row.poll_date);
}

export async function getTechnologyVoteHistory(
  env: Env,
  pollDate: string
): Promise<TechnologyVoteHistory | null> {
  const row = await env.DB.prepare(
    `SELECT poll_date, finalized_at, ballot_count, options_json, projected_plan_json,
            fixed_technologies_json
     FROM technology_vote_history
     WHERE poll_date = ? AND deleted_at IS NULL`
  )
    .bind(pollDate)
    .first<TechnologyVoteHistoryRow>();
  return row ? parseTechnologyVoteHistory(row) : null;
}

export async function deleteTechnologyVoteHistory(
  env: Env,
  pollDate?: string
): Promise<number> {
  const now = isoNow();
  const statement = pollDate
    ? env.DB.prepare(
        `UPDATE technology_vote_history
         SET options_json = '[]', projected_plan_json = '{"core":[],"general":[]}',
             fixed_technologies_json = '[]', deleted_at = ?
         WHERE poll_date = ? AND deleted_at IS NULL`
      ).bind(now, pollDate)
    : env.DB.prepare(
        `UPDATE technology_vote_history
         SET options_json = '[]', projected_plan_json = '{"core":[],"general":[]}',
             fixed_technologies_json = '[]', deleted_at = ?
         WHERE deleted_at IS NULL`
      ).bind(now);
  const result = await statement.run();
  return result.meta.changes ?? 0;
}

export async function listMembers(
  env: Env,
  limit = 200,
  options: { includeIdentityCodes?: boolean } = {}
): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT id, name, profession, manor_level, roommate_name, camp_title,
            weekly_contribution, technology_points_used, material_contribution,
            weekly_activity_points,
            identity_code_id,
            last_seen_at
     FROM members
     ORDER BY weekly_contribution DESC, name ASC
     LIMIT ?`
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  if (!options.includeIdentityCodes) {
    return result.results.map(({ identity_code_id: _identityCodeId, ...member }) => member);
  }
  const identityRows = await env.DB.prepare(
    `SELECT id, code_encrypted, player_name
     FROM identity_codes
     WHERE status = 'active'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY player_name ASC`
  ).bind(isoNow()).all<{
    id: string;
    code_encrypted: string;
    player_name: string | null;
  }>();
  const identityOptions = await Promise.all(identityRows.results.map(async (row) => ({
    id: row.id,
    playerName: row.player_name?.trim() || "",
    code: await decryptSecret(env, "identity-code-value", row.code_encrypted)
  })));
  const byId = new Map(identityOptions.map((item) => [item.id, item]));
  const activeNames = identityOptions
    .filter((item) => item.playerName)
    .map((item) => ({ name: item.playerName }));
  return result.results.map((member) => {
    const explicit = typeof member.identity_code_id === "string"
      ? byId.get(member.identity_code_id)
      : undefined;
    const automaticName = explicit
      ? explicit.playerName
      : calibrateMemberName(String(member.name || ""), activeNames);
    const automatic = explicit || identityOptions.find(
      (item) => item.playerName === automaticName && automaticName
    );
    return {
      ...member,
      identity_code_id: explicit?.id ?? null,
      identity_code: automatic?.code ?? null,
      identity_code_player_name: automatic?.playerName ?? null,
      identity_code_binding: explicit ? "manual" : automatic ? "automatic" : null
    };
  });
}

const MEMBER_DETAILS_SELECT = `
  SELECT id, name, profession, manor_level, roommate_name, camp_title,
         weekly_contribution, technology_points_used, material_contribution,
         weekly_activity_points,
         identity_code_id,
         last_seen_at
  FROM members`;

export type MemberDetailsUpdate = {
  id: string;
  name: string;
  identityCodeId?: string | null;
  profession: string | null;
  manorLevel: number | null;
  roommateName: string | null;
  campTitle: string | null;
  weeklyContribution: number;
  technologyPointsUsed: number;
  materialContribution: number;
  weeklyActivityPoints: number;
};

export async function getMemberById(
  env: Env,
  id: string
): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`${MEMBER_DETAILS_SELECT} WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
}

export async function updateMemberDetails(
  env: Env,
  input: MemberDetailsUpdate
): Promise<Record<string, unknown> | null> {
  if (input.identityCodeId) {
    const identity = await env.DB.prepare(
      `SELECT id FROM identity_codes
       WHERE id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)`
    ).bind(input.identityCodeId, isoNow()).first<{ id: string }>();
    if (!identity) throw new Error("只能绑定有效且未过期的身份识别码");
  }
  const hasIdentityBinding = Object.prototype.hasOwnProperty.call(input, "identityCodeId");
  const result = hasIdentityBinding
    ? await env.DB.prepare(
        `UPDATE members
         SET name = ?, profession = ?, manor_level = ?, roommate_name = ?, camp_title = ?,
             weekly_contribution = ?, technology_points_used = ?,
             material_contribution = ?, weekly_activity_points = ?, identity_code_id = ?
         WHERE id = ?`
      ).bind(
        input.name,
        input.profession,
        input.manorLevel,
        input.roommateName,
        input.campTitle,
        input.weeklyContribution,
        input.technologyPointsUsed,
        input.materialContribution,
        input.weeklyActivityPoints,
        input.identityCodeId ?? null,
        input.id
      ).run()
    : await env.DB.prepare(
        `UPDATE members
         SET name = ?, profession = ?, manor_level = ?, roommate_name = ?, camp_title = ?,
             weekly_contribution = ?, technology_points_used = ?,
             material_contribution = ?, weekly_activity_points = ?
         WHERE id = ?`
      ).bind(
        input.name,
        input.profession,
        input.manorLevel,
        input.roommateName,
        input.campTitle,
        input.weeklyContribution,
        input.technologyPointsUsed,
        input.materialContribution,
        input.weeklyActivityPoints,
        input.id
      ).run();
  if (!(result.meta.changes ?? 0)) return null;
  return getMemberById(env, input.id);
}

export async function listActiveIdentityPlayerNames(
  env: Env
): Promise<Array<{ name: string }>> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT player_name
     FROM identity_codes
     WHERE status = 'active'
       AND player_name IS NOT NULL
       AND trim(player_name) <> ''
       AND (expires_at IS NULL OR expires_at > ?)`
  )
    .bind(isoNow())
    .all<{ player_name: string }>();
  return rows.results.map((row) => ({ name: row.player_name.trim() }));
}

/**
 * Prefer the display name owned by an active identity code when the Worker
 * OCR/source name is the same after Unicode and decorative-symbol cleanup.
 * A small, unique edit-distance match handles one or two OCR mistakes without
 * turning an unrelated player into an identity-code player.
 */
export function calibrateMemberName(
  source: string,
  identityNames: Array<{ name: string }>
): string {
  const original = source.trim();
  if (!original) return original;
  const candidates = [...new Map(
    identityNames
      .map((item) => String(item.name || "").trim())
      .filter(Boolean)
      .map((name) => [name, name])
  ).values()];
  const sourceKey = identityPlayerNameKey(original);
  if (!sourceKey) return original;
  const exact = candidates.filter((name) => identityPlayerNameKey(name) === sourceKey);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return original;

  const fuzzy = candidates
    .map((name) => ({ name, key: identityPlayerNameKey(name) }))
    .filter((item) => {
      const minimumLength = Math.min(sourceKey.length, item.key.length);
      const maximumDistance =
        minimumLength >= 10 ? 2 : minimumLength >= 5 ? 1 : 0;
      return maximumDistance > 0 &&
        levenshteinDistance(sourceKey, item.key) <= maximumDistance;
    })
    .sort(
      (left, right) =>
        levenshteinDistance(sourceKey, left.key) -
          levenshteinDistance(sourceKey, right.key) ||
        right.key.length - left.key.length
    );
  if (!fuzzy.length) return original;
  const bestDistance = levenshteinDistance(sourceKey, fuzzy[0]!.key);
  const tied = fuzzy.filter(
    (item) => levenshteinDistance(sourceKey, item.key) === bestDistance
  );
  return tied.length === 1 ? tied[0]!.name : original;
}

export function calibrateMemberNames<T extends { name: string }>(
  rows: T[],
  identityNames: Array<{ name: string }>
): T[] {
  return rows.map((row) => ({
    ...row,
    name: calibrateMemberName(row.name, identityNames)
  }));
}

export type MemberScanSummary = {
  expectedCount: number;
  recognizedCount: number;
  missingCount: number;
  missingAllowed: boolean;
  finalPage: number | null;
  pages: number | null;
  positionLocked: boolean;
  runId: string;
  capturedAt: string;
};

export async function getMemberScanSummary(
  env: Env
): Promise<MemberScanSummary | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = ?"
  )
    .bind("member_scan_summary")
    .first<{ value: string }>();
  const parsed = parseJson<unknown>(row?.value, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as MemberScanSummary;
}

export async function saveMemberScanSummary(
  env: Env,
  summary: MemberScanSummary
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind("member_scan_summary", JSON.stringify(summary), isoNow())
    .run();
}

export async function listActivityWarnings(
  env: Env,
  limit = 200
): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT name, last_active_text, inactive_days, captured_at
     FROM activity_warnings
     ORDER BY inactive_days DESC, name ASC
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
  const identityNames = await listActiveIdentityPlayerNames(env);
  const calibratedMembers = calibrateMemberNames(input.members, identityNames);
  for (const member of calibratedMembers) {
    const memberId = await stableMemberId(member.name);
    statements.push(
      env.DB.prepare(
        `INSERT INTO members(
           id, name, profession, manor_level, roommate_name, camp_title,
           weekly_contribution, technology_points_used, material_contribution,
           last_active_text, inactive_days, activity_captured_at,
           last_seen_at, source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
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
): Promise<ContributionReconciliation> {
  const identityNames = await listActiveIdentityPlayerNames(env);
  const calibratedMembers = calibrateMemberNames(input.members, identityNames);
  const current = await env.DB.prepare(
    "SELECT name, weekly_contribution FROM members ORDER BY name"
  ).all<{ name: string; weekly_contribution: number }>();
  const reconciliation = reconcileContributionMembers(
    calibratedMembers,
    current.results.map((member) => ({
      name: member.name,
      weeklyContribution: member.weekly_contribution
    }))
  );
  const statements = reconciliation.updates.map((member) =>
    env.DB.prepare(
      `UPDATE members
       SET weekly_contribution = ?,
           technology_points_used = ?,
           material_contribution = ?,
           last_seen_at = ?
       WHERE name = ?`
    ).bind(
      member.weeklyContribution,
      member.technologyPointsUsed,
      member.materialContribution,
      input.capturedAt,
      member.name
    )
  );
  if (statements.length) await env.DB.batch(statements);
  return reconciliation;
}

type WeeklyActivityRow = {
  name: string;
  weeklyActivityPoints: number;
};

export type WeeklyActivityReconciliation = {
  updates: WeeklyActivityRow[];
  ignored: number;
  ambiguous: number;
};

export function reconcileWeeklyActivityMembers(
  incoming: WeeklyActivityRow[],
  masterMembers: Array<{ name: string }> = []
): WeeklyActivityReconciliation {
  const hasMasterRoster = masterMembers.length > 0;
  const rawByName = new Map<string, Array<{ name: string }>>();
  const coreByName = new Map<string, Array<{ name: string }>>();
  for (const member of masterMembers) {
    const name = String(member?.name || "").trim();
    if (!name) continue;
    rawByName.set(rawMemberName(name), [
      ...(rawByName.get(rawMemberName(name)) ?? []),
      { name }
    ]);
    const coreKey = symbolInsensitiveMemberName(name) || comparableMemberName(name);
    coreByName.set(coreKey, [...(coreByName.get(coreKey) ?? []), { name }]);
  }
  const updatesByName = new Map<string, WeeklyActivityRow>();
  let ignored = 0;
  let ambiguous = 0;
  for (const row of incoming) {
    let canonicalName = String(row.name || "").trim();
    if (hasMasterRoster) {
      const rawCandidates = rawByName.get(rawMemberName(canonicalName)) ?? [];
      const coreKey = symbolInsensitiveMemberName(canonicalName) || comparableMemberName(canonicalName);
      const coreCandidates = coreByName.get(coreKey) ?? [];
      const boundaryCandidates = hasMemberCoreBoundaryVariant(canonicalName, masterMembers);
      const candidates = rawCandidates.length
        ? rawCandidates
        : coreCandidates.length
          ? coreCandidates
          : boundaryCandidates;
      if (candidates.length === 1) canonicalName = candidates[0]!.name;
      else {
        if (candidates.length > 1) ambiguous += 1;
        ignored += 1;
        continue;
      }
    }
    const key = hasMasterRoster
      ? rawMemberName(canonicalName)
      : symbolInsensitiveMemberName(canonicalName) || comparableMemberName(canonicalName);
    if (!key || updatesByName.has(key)) {
      ignored += 1;
      continue;
    }
    updatesByName.set(key, { ...row, name: canonicalName });
  }
  return { updates: [...updatesByName.values()], ignored, ambiguous };
}

export async function updateWeeklyActivitySnapshot(
  env: Env,
  input: {
    runId: string;
    capturedAt: string;
    members: WeeklyActivityRow[];
  }
): Promise<WeeklyActivityReconciliation> {
  const identityNames = await listActiveIdentityPlayerNames(env);
  const calibratedMembers = calibrateMemberNames(input.members, identityNames);
  const master = await env.DB.prepare("SELECT name FROM members ORDER BY name")
    .all<{ name: string }>();
  const reconciliation = reconcileWeeklyActivityMembers(
    calibratedMembers,
    master.results
  );
  // The game leaderboard contains only members who earned activity points.
  // A completed scan therefore resets absent roster members to zero first.
  await env.DB.prepare(
    "UPDATE members SET weekly_activity_points = 0, last_seen_at = ?"
  ).bind(input.capturedAt).run();
  const statements = reconciliation.updates.map((member) =>
    env.DB.prepare(
      `UPDATE members
       SET weekly_activity_points = ?, last_seen_at = ?
       WHERE name = ?`
    ).bind(member.weeklyActivityPoints, input.capturedAt, member.name)
  );
  if (statements.length) await env.DB.batch(statements);
  return reconciliation;
}

type ContributionRow = {
  name: string;
  weeklyContribution: number;
  technologyPointsUsed: number;
  materialContribution: number;
};

type ContributionMaster = {
  name: string;
  weeklyContribution: number;
};

export type ContributionReconciliation = {
  updates: ContributionRow[];
  ignored: number;
  ambiguous: number;
};

export function reconcileContributionMembers(
  incoming: ContributionRow[],
  masterMembers: ContributionMaster[]
): ContributionReconciliation {
  const available = new Set(masterMembers.map((member) => member.name));
  const rawByName = new Map<string, ContributionMaster[]>();
  const exactByName = new Map<string, ContributionMaster[]>();
  for (const member of masterMembers) {
    const rawKey = rawMemberName(member.name);
    rawByName.set(rawKey, [...(rawByName.get(rawKey) ?? []), member]);
    const key = comparableMemberName(member.name);
    exactByName.set(key, [...(exactByName.get(key) ?? []), member]);
  }

  const updates: ContributionRow[] = [];
  let ignored = 0;
  let ambiguous = 0;
  for (const row of incoming) {
    const rawCandidates = (rawByName.get(rawMemberName(row.name)) ?? [])
      .filter((member) => available.has(member.name));
    const exactCandidates = (
      rawCandidates.length
        ? rawCandidates
        : exactByName.get(comparableMemberName(row.name)) ?? []
    ).filter((member) => available.has(member.name));
    let candidate: ContributionMaster | null = null;
    if (exactCandidates.length === 1) {
      candidate = exactCandidates[0]!;
    } else if (exactCandidates.length > 1) {
      // If OCR dropped or changed only the decorative boundary, several
      // roster entries can share the same letter/CJK core (for example two
      // differently decorated 慕离 players). A unique contribution value
      // corroboration can disambiguate that collision without trusting the
      // damaged symbol string. If the values are tied or stale, stay safe and
      // leave the row unmatched instead of writing to the wrong member.
      const corroborated = exactCandidates.filter((member) =>
        contributionsCorroborate(
          row.weeklyContribution,
          member.weeklyContribution
        )
      );
      if (corroborated.length === 1) {
        candidate = corroborated[0]!;
      } else {
        ambiguous += 1;
        ignored += 1;
        continue;
      }
    } else {
      const sourceName = comparableMemberName(row.name);
      const fuzzyCandidates = masterMembers.flatMap((member) => {
        if (!available.has(member.name)) return [];
        const targetName = comparableMemberName(member.name);
        const minimumLength = Math.min(sourceName.length, targetName.length);
        const distance = levenshteinDistance(sourceName, targetName);
        const maximumDistance =
          minimumLength >= 10 ? 3 : minimumLength >= 5 ? 2 : 1;
        const boundaryVariant = hasMemberCoreBoundaryVariant(row.name, [
          member
        ]).length === 1;
        return sourceName.length >= 3 &&
          targetName.length >= 3 &&
          (distance <= maximumDistance || boundaryVariant)
          ? [{
              member,
              distance,
              corroborated: contributionsCorroborate(
                row.weeklyContribution,
                member.weeklyContribution
              )
            }]
          : [];
      });
      fuzzyCandidates.sort(
        (left, right) =>
          left.distance - right.distance ||
          Number(right.corroborated) - Number(left.corroborated)
      );
      const best = fuzzyCandidates[0];
      const nearest = best
        ? fuzzyCandidates.filter((item) => item.distance === best.distance)
        : [];
      const corroboratedNearest = nearest.filter((item) => item.corroborated);
      // A unique name candidate is enough to accept a fuzzy OCR correction.
      // The weekly value can legitimately change between the member snapshot
      // and the contribution scan, so it must not block a unique name match.
      // When names are tied, retain the numeric corroboration guard.
      if (best && nearest.length === 1) {
        candidate = best.member;
      } else if (corroboratedNearest.length === 1) {
        candidate = corroboratedNearest[0]!.member;
      } else {
        if (fuzzyCandidates.length > 1) ambiguous += 1;
        ignored += 1;
        continue;
      }
    }

    available.delete(candidate.name);
    updates.push({ ...row, name: candidate.name });
  }
  return { updates, ignored, ambiguous };
}

function comparableMemberName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase();
  // Player names are frequently decorated with full-width punctuation,
  // emoji, middle dots or OCR-inserted separators. Letters and numbers are
  // authoritative; a symbol-only name falls back to its normalized glyphs so
  // unrelated symbol names do not collapse to the same empty key.
  const lettersAndNumbers = normalized.match(/[\p{L}\p{N}]+/gu)?.join("") ?? "";
  return lettersAndNumbers || normalized.replace(/\s+/g, "");
}

function rawMemberName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "");
}

function contributionsCorroborate(left: number, right: number): boolean {
  if (left === right) return true;
  const a = String(Math.max(0, Math.trunc(left)));
  const b = String(Math.max(0, Math.trunc(right)));
  if (a.length < 2 || a.length !== b.length) return false;
  const maximumDistance = a.length >= 7 ? 2 : 1;
  return levenshteinDistance(a, b) <= maximumDistance;
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! +
          (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      current.push(value);
    }
    previous = current;
  }
  return previous[right.length]!;
}

type ActivityRow = {
  name: string;
  lastActiveText: string | null;
  inactiveDays: number | null;
};

export type ActivityReconciliation = {
  updates: ActivityRow[];
  ignored: number;
  ambiguous: number;
};

export function reconcileActivityMembers(
  incoming: ActivityRow[],
  masterMembers: Array<{ name: string }> = []
): ActivityReconciliation {
  const hasMasterRoster = masterMembers.length > 0;
  const rawByName = new Map<string, Array<{ name: string }>>();
  const coreByName = new Map<string, Array<{ name: string }>>();
  for (const member of masterMembers) {
    const name = String(member?.name || "").trim();
    if (!name) continue;
    const rawKey = rawMemberName(name);
    rawByName.set(rawKey, [...(rawByName.get(rawKey) ?? []), { name }]);
    const coreKey = symbolInsensitiveMemberName(name) || comparableMemberName(name);
    coreByName.set(coreKey, [
      ...(coreByName.get(coreKey) ?? []),
      { name }
    ]);
  }
  const updatesByName = new Map<string, ActivityRow>();
  let ignored = 0;
  let ambiguous = 0;

  for (const row of incoming) {
    let canonicalName = String(row.name || "").trim();
    if (hasMasterRoster) {
      const rawCandidates = rawByName.get(rawMemberName(row.name)) ?? [];
      const coreKey = symbolInsensitiveMemberName(row.name) || comparableMemberName(row.name);
      const coreCandidates = coreByName.get(coreKey) ?? [];
      const boundaryCandidates = hasMemberCoreBoundaryVariant(
        row.name,
        masterMembers
      );
      const candidates = rawCandidates.length
        ? rawCandidates
        : coreCandidates.length
          ? coreCandidates
          : boundaryCandidates;
      if (candidates.length === 1) {
        canonicalName = candidates[0]!.name;
      } else {
        if (candidates.length > 1) ambiguous += 1;
        ignored += 1;
        continue;
      }
    }
    const key = hasMasterRoster
      ? rawMemberName(canonicalName)
      : symbolInsensitiveMemberName(canonicalName) || comparableMemberName(canonicalName);
    if (!key) {
      ignored += 1;
      continue;
    }
    const canonicalRow = { ...row, name: canonicalName };
    const existing = updatesByName.get(key);
    if (existing) {
      ignored += 1;
      if (
        Number(row.inactiveDays ?? -1) >
        Number(existing.inactiveDays ?? -1)
      ) {
        updatesByName.set(key, canonicalRow);
      }
      continue;
    }
    updatesByName.set(key, canonicalRow);
  }

  return { updates: [...updatesByName.values()], ignored, ambiguous };
}

function symbolInsensitiveMemberName(value: string): string {
  return comparableMemberName(value).replace(/[^\p{L}\p{N}]/gu, "");
}

function hasMemberCoreBoundaryVariant(
  source: string,
  members: Array<{ name: string }>
): Array<{ name: string }> {
  const sourceCore =
    symbolInsensitiveMemberName(source) || comparableMemberName(source);
  if (!sourceCore) return [];
  return members.filter((member) => {
    const targetCore =
      symbolInsensitiveMemberName(member.name) || comparableMemberName(member.name);
    const difference = Math.abs(sourceCore.length - targetCore.length);
    return (
      difference > 0 &&
      difference <= 2 &&
      (sourceCore.startsWith(targetCore) || targetCore.startsWith(sourceCore))
    );
  });
}

export async function updateActivitySnapshot(
  env: Env,
  input: {
    runId: string;
    capturedAt: string;
    members: ActivityRow[];
  }
): Promise<ActivityReconciliation> {
  const identityNames = await listActiveIdentityPlayerNames(env);
  const calibratedMembers = calibrateMemberNames(input.members, identityNames);
  const master = await env.DB.prepare(
    "SELECT name FROM members ORDER BY name"
  ).all<{ name: string }>();
  const reconciliation = reconcileActivityMembers(
    calibratedMembers,
    calibrateMemberNames(master.results, identityNames)
  );
  // Preserve the last valid warning snapshot when a non-empty OCR payload
  // cannot produce even one self-contained warning row.
  if (input.members.length > 0 && reconciliation.updates.length === 0) {
    return reconciliation;
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM activity_warnings")
  ];
  for (const member of reconciliation.updates) {
    // With the authoritative roster, preserve the complete canonical name
    // (including distinct decorative symbols) so two same-core players do
    // not collide in the activity_warnings primary key.
    const nameKey = rawMemberName(member.name) || comparableMemberName(member.name);
    statements.push(
      env.DB.prepare(
        `INSERT INTO activity_warnings(
           name_key, name, last_active_text, inactive_days, captured_at,
           source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?)`
      ).bind(
        nameKey,
        member.name,
        member.lastActiveText,
        member.inactiveDays,
        input.capturedAt,
        input.runId
      )
    );
  }
  await env.DB.batch(statements);
  return reconciliation;
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
      weeklyContribution: number;
    }>;
  }
): Promise<void> {
  // The Agent has already scanned, reconciled, and de-duplicated the member
  // table. Do not use the display name as the server-side reconciliation key:
  // OCR-safe names can contain symbols and visually similar variants, and a
  // name conflict here would silently reduce the accepted snapshot. The
  // stable ID is derived from the calibrated name submitted by the Agent. If
  // no active identity code is a safe match, calibration returns the original
  // Worker name and the existing roster rules remain authoritative.
  const statements: D1PreparedStatement[] = [];
  const identityNames = await listActiveIdentityPlayerNames(env);
  const calibratedMembers = calibrateMemberNames(input.members, identityNames);
  for (const member of calibratedMembers) {
    const memberId = await stableMemberId(member.name);
    statements.push(
      env.DB.prepare(
        `INSERT INTO members(
           id, name, profession, manor_level, roommate_name, camp_title,
           weekly_contribution, last_seen_at, source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
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
        member.weeklyContribution,
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
): Promise<StaffReconciliation> {
  const reconciliation = reconcileStaffAssignments(input.staff);
  if (input.staff.length > 0 && reconciliation.staff.length === 0) {
    return reconciliation;
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM staff_assignments"),
    ...reconciliation.staff.map((item) =>
      env.DB.prepare(
      `INSERT INTO staff_assignments(
         role_key, role_name, member_id, member_name, updated_at, source_run_id
       ) VALUES(?, ?, NULL, ?, ?, ?)
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
        input.capturedAt,
        input.runId
      )
    )
  ];
  await env.DB.batch(statements);
  return reconciliation;
}

type StaffRow = {
  roleKey: string;
  roleName: string;
  memberName: string | null;
};

export type StaffReconciliation = {
  staff: StaffRow[];
  ignored: number;
  ambiguous: number;
};

export function reconcileStaffAssignments(
  incoming: StaffRow[]
): StaffReconciliation {
  const usedRoleKeys = new Set<string>();
  const usedRoleNames = new Set<string>();
  const usedMemberNames = new Set<string>();
  const staff: StaffRow[] = [];
  let ignored = 0;
  let ambiguous = 0;

  for (const row of incoming) {
    const roleKey = comparableMemberName(row.roleKey);
    const roleName = comparableMemberName(row.roleName);
    if (
      !row.memberName ||
      !roleKey ||
      !roleName ||
      usedRoleKeys.has(roleKey) ||
      usedRoleNames.has(roleName)
    ) {
      ignored += 1;
      continue;
    }
    const memberKey = symbolInsensitiveMemberName(row.memberName);
    if (!memberKey || usedMemberNames.has(memberKey)) {
      ignored += 1;
      continue;
    }
    usedRoleKeys.add(roleKey);
    usedRoleNames.add(roleName);
    usedMemberNames.add(memberKey);
    staff.push({ ...row, memberName: row.memberName.trim() });
  }

  return { staff, ignored, ambiguous };
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

export async function findActiveRunForAgent(
  env: Env,
  agentId: string,
  excludeRunId?: string,
  includeQueued = true
): Promise<TaskRun | null> {
  const stateClause = includeQueued
    ? "task_runs.state IN ('queued', 'claimed', 'running', 'cancelling')"
    : "task_runs.state IN ('claimed', 'running', 'cancelling')";
  const result = await env.DB.prepare(
    `SELECT task_runs.*
     FROM task_runs
     JOIN command_queue ON command_queue.run_id = task_runs.id
     WHERE command_queue.agent_id = ?
       AND command_queue.type = 'run_task'
       AND ${stateClause}
       AND (? IS NULL OR task_runs.id <> ?)
     ORDER BY task_runs.created_at ASC
     LIMIT 1`
  )
    .bind(agentId, excludeRunId ?? null, excludeRunId ?? null)
    .first<TaskRun>();
  return result ?? null;
}

export async function listQueueGuardRuns(
  env: Env,
  agentId: string
): Promise<TaskRun[]> {
  const result = await env.DB.prepare(
    `SELECT task_runs.*
     FROM task_runs
     JOIN command_queue ON command_queue.run_id = task_runs.id
     WHERE command_queue.agent_id = ?
       AND command_queue.type = 'run_task'
       AND command_queue.state = 'queued'
       AND task_runs.trigger_mode = 'scheduled'
       AND task_runs.state = 'queued'
       AND json_extract(task_runs.detail_json, '$.queueGuard.waitUntil') IS NOT NULL
     ORDER BY task_runs.created_at ASC`
  )
    .bind(agentId)
    .all<TaskRun>();
  return result.results;
}

export async function listRecentRuns(env: Env, limit = 50): Promise<TaskRun[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM task_runs ORDER BY created_at DESC LIMIT ?"
  )
    .bind(limit)
    .all<TaskRun>();
  return result.results;
}

export async function clearPublicRateLimits(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM public_rate_limits").run();
  return result.meta.changes;
}

export async function clearFinishedRunHistory(env: Env): Promise<{
  runs: number;
  events: number;
  commands: number;
}> {
  const terminalStates = [
    "interrupted",
    "succeeded",
    "partially_succeeded",
    "failed",
    "timed_out",
    "skipped"
  ];
  const placeholders = terminalStates.map(() => "?").join(", ");
  const [commands, events, runs] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM command_queue
       WHERE run_id IN (
         SELECT id FROM task_runs WHERE state IN (${placeholders})
       )`
    ).bind(...terminalStates),
    env.DB.prepare(
      `DELETE FROM task_events
       WHERE run_id IN (
         SELECT id FROM task_runs WHERE state IN (${placeholders})
       )`
    ).bind(...terminalStates),
    env.DB.prepare(
      `DELETE FROM task_runs WHERE state IN (${placeholders})`
    ).bind(...terminalStates)
  ]);
  return {
    runs: runs?.meta.changes ?? 0,
    events: events?.meta.changes ?? 0,
    commands: commands?.meta.changes ?? 0
  };
}

export async function expireUnclaimedRuns(
  env: Env,
  claimTimeoutMinutes: number,
  now = new Date()
): Promise<string[]> {
  const timeoutMinutes = Math.max(
    1,
    Math.min(10_080, Math.trunc(claimTimeoutMinutes))
  );
  const finishedAt = now.toISOString();
  const cutoff = new Date(
    now.getTime() - timeoutMinutes * 60_000
  ).toISOString();
  const candidates = await env.DB.prepare(
    `SELECT id
     FROM task_runs
     WHERE state = 'queued' AND created_at <= ?
     ORDER BY created_at ASC
     LIMIT 200`
  )
    .bind(cutoff)
    .all<{ id: string }>();
  const ids = candidates.results.map((row) => row.id);
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(",");
  const commandMessage = `等待 Agent 接取超过 ${timeoutMinutes} 分钟，队列命令已取消`;
  await env.DB.prepare(
    `UPDATE command_queue
     SET state = 'cancelled',
         message = ?,
         finished_at = ?,
         lease_expires_at = NULL
     WHERE type = 'run_task'
       AND state = 'queued'
       AND run_id IN (${placeholders})`
  )
    .bind(commandMessage, finishedAt, ...ids)
    .run();

  const runMessage = `等待 Agent 接取超过 ${timeoutMinutes} 分钟，任务已超时取消`;
  const expired = await env.DB.prepare(
    `UPDATE task_runs
     SET state = 'timed_out',
         message = ?,
         current_step = NULL,
         cancel_requested = 1,
         finished_at = ?,
         updated_at = ?
     WHERE state = 'queued'
       AND created_at <= ?
       AND id IN (${placeholders})
       AND (
         EXISTS (
           SELECT 1 FROM command_queue
           WHERE command_queue.run_id = task_runs.id
             AND command_queue.type = 'run_task'
             AND command_queue.state = 'cancelled'
             AND command_queue.message = ?
         )
         OR NOT EXISTS (
           SELECT 1 FROM command_queue
           WHERE command_queue.run_id = task_runs.id
             AND command_queue.type = 'run_task'
         )
       )
     RETURNING id`
  )
    .bind(
      runMessage,
      finishedAt,
      finishedAt,
      cutoff,
      ...ids,
      commandMessage
    )
    .all<{ id: string }>();
  const expiredIds = expired.results.map((row) => row.id);
  if (!expiredIds.length) return [];
  await env.DB.batch(
    expiredIds.map((runId) =>
      env.DB.prepare(
        "INSERT INTO task_events(run_id, level, step, message, detail_json, created_at) VALUES(?, 'warning', NULL, ?, ?, ?)"
      ).bind(
        runId,
        runMessage,
        JSON.stringify({ claimTimeoutMinutes: timeoutMinutes }),
        finishedAt
      )
    )
  );
  return expiredIds;
}

export async function listRunEvents(
  env: Env,
  runId: string,
  options: { afterId?: number; limit?: number } = {}
): Promise<{ events: Record<string, unknown>[]; nextAfterId: number | null }> {
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 1000));
  const afterId = Number.isInteger(options.afterId) && options.afterId! > 0
    ? options.afterId
    : null;
  const result = afterId == null
    ? await env.DB.prepare(
        "SELECT id, level, step, message, detail_json, created_at FROM task_events WHERE run_id = ? ORDER BY id ASC LIMIT ?"
      )
        .bind(runId, limit)
        .all<Record<string, unknown>>()
    : await env.DB.prepare(
        "SELECT id, level, step, message, detail_json, created_at FROM task_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
      )
        .bind(runId, afterId, limit)
        .all<Record<string, unknown>>();
  const events = result.results;
  const lastId = events.length ? Number(events[events.length - 1]?.id) : null;
  return {
    events,
    nextAfterId: events.length >= limit && Number.isFinite(lastId) ? lastId : null
  };
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
  // A terminal state is authoritative. An old Agent can still finish an
  // in-flight request after cancellation, a restart, or a network partition;
  // allowing that request to move the run back to `running`/`succeeded` would
  // recreate the ghost-task race this state machine is meant to prevent.
  if (isTerminalRunState(current.state)) return current;

  const requestedState = input.state ?? current.state;
  const cancellationRequested = current.cancel_requested === 1;
  const forcedInterrupted =
    cancellationRequested &&
    isTerminalRunState(requestedState) &&
    requestedState !== "interrupted";
  const state = forcedInterrupted
    ? "interrupted"
    : cancellationRequested && requestedState !== "interrupted"
      ? current.state
      : requestedState;
  const now = isoNow();
  const startedAt =
    current.started_at ?? (state === "running" || state === "claimed" ? now : null);
  const terminal = isTerminalRunState(state);
  const cancellationMessage = forcedInterrupted
    ? "任务已由管理员中断"
    : current.state === "cancelling" && cancellationRequested && requestedState !== "interrupted"
      ? current.message
      : undefined;
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
      cancellationMessage ?? input.message ?? current.message,
      input.currentStep === undefined ? current.current_step : input.currentStep,
      input.progress === undefined
        ? current.progress
        : Math.min(1, Math.max(0, input.progress)),
      input.detail === undefined
        ? current.detail_json
        : mergeRunDetail(current.detail_json, input.detail),
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

/**
 * A task row can be removed manually from D1 while its command row survives
 * because the legacy foreign key uses ON DELETE SET NULL. Such a command is
 * not executable: its payload is historical data, not a new task lease.
 * Repair it before every Agent claim so old databases cannot run ghost tasks.
 */
export async function reconcileStaleCommands(
  env: Env,
  now = new Date()
): Promise<number> {
  const finishedAt = now.toISOString();
  const result = await env.DB.prepare(
    `UPDATE command_queue SET
       state = 'cancelled',
       message = '关联任务已不存在或已结束，命令已取消',
       finished_at = ?,
       lease_expires_at = NULL
     WHERE state IN ('queued', 'claimed')
       AND (
         run_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM task_runs
           WHERE task_runs.id = command_queue.run_id
         )
         OR EXISTS (
           SELECT 1 FROM task_runs
           WHERE task_runs.id = command_queue.run_id
             AND task_runs.state IN ('interrupted', 'succeeded', 'partially_succeeded', 'failed', 'timed_out', 'skipped')
         )
       )`
  )
    .bind(finishedAt)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * When a restarted Agent reports itself idle, no local workflow can still be
 * executing the cancelled run. Finalize that run and cancel both its old run
 * command and any pending interrupt command. This is deliberately keyed by
 * the reported activeRunId so a healthy in-flight task is never finalized by
 * its own heartbeat.
 */
export async function finalizeAgentCancellations(
  env: Env,
  input: {
    agentId: string;
    activeRunId: string | null;
    now?: Date;
  }
): Promise<string[]> {
  const now = (input.now ?? new Date()).toISOString();
  const candidates = await env.DB.prepare(
    `SELECT task_runs.id
     FROM task_runs
     WHERE task_runs.state = 'cancelling'
       AND task_runs.cancel_requested = 1
       AND (? IS NULL OR task_runs.id <> ?)
       AND EXISTS (
         SELECT 1 FROM command_queue
         WHERE command_queue.run_id = task_runs.id
           AND command_queue.agent_id = ?
           AND command_queue.type = 'run_task'
           AND command_queue.state IN ('queued', 'claimed', 'cancelled')
       )
     ORDER BY task_runs.created_at ASC
     LIMIT 200`
  )
    .bind(input.activeRunId, input.activeRunId, input.agentId)
    .all<{ id: string }>();
  const ids = candidates.results.map((row) => row.id).filter(Boolean);
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const commandMessage = "Agent 已重启或离线，未收到中断确认；任务已由服务端终止";
  const runMessage = "Agent 已重启或离线，任务未收到中断结果；已由服务端终止";
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE command_queue SET
         state = 'cancelled',
         message = ?,
         finished_at = ?,
         lease_expires_at = NULL
       WHERE agent_id = ?
         AND run_id IN (${placeholders})
         AND state IN ('queued', 'claimed')`
    ).bind(commandMessage, now, input.agentId, ...ids),
    env.DB.prepare(
      `UPDATE task_runs SET
         state = 'interrupted',
         message = ?,
         current_step = NULL,
         finished_at = ?,
         updated_at = ?
       WHERE id IN (${placeholders})
         AND state = 'cancelling'
         AND cancel_requested = 1
         AND (? IS NULL OR id <> ?)
       RETURNING id`
    ).bind(runMessage, now, now, ...ids, input.activeRunId, input.activeRunId)
  ]);
  const finalized = results[1]?.results as Array<{ id?: string }> | undefined;
  return (finalized ?? []).map((row) => row.id).filter((id): id is string => Boolean(id));
}

/**
 * Cron-side safety net for a dead Agent that never gets a chance to send its
 * restart heartbeat. An expired run-command lease proves that no current
 * Agent owns the execution anymore.
 */
export async function finalizeExpiredCancellations(
  env: Env,
  now = new Date()
): Promise<string[]> {
  const cutoff = now.toISOString();
  const candidates = await env.DB.prepare(
    `SELECT task_runs.id
     FROM task_runs
     WHERE task_runs.state = 'cancelling'
       AND task_runs.cancel_requested = 1
       AND EXISTS (
         SELECT 1 FROM command_queue
         WHERE command_queue.run_id = task_runs.id
           AND command_queue.type = 'run_task'
           AND (
             command_queue.state = 'cancelled'
             OR (
               command_queue.state = 'claimed'
               AND (
                 command_queue.lease_expires_at IS NULL
                 OR command_queue.lease_expires_at <= ?
               )
             )
           )
       )
     ORDER BY task_runs.created_at ASC
     LIMIT 200`
  )
    .bind(cutoff)
    .all<{ id: string }>();
  const ids = candidates.results.map((row) => row.id).filter(Boolean);
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const finishedAt = now.toISOString();
  const message = "中断命令租约已失效，任务已由服务端终止";
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE command_queue SET
         state = 'cancelled',
         message = ?,
         finished_at = ?,
         lease_expires_at = NULL
       WHERE run_id IN (${placeholders})
         AND state IN ('queued', 'claimed')`
    ).bind(message, finishedAt, ...ids),
    env.DB.prepare(
      `UPDATE task_runs SET
         state = 'interrupted',
         message = ?,
         current_step = NULL,
         finished_at = ?,
         updated_at = ?
         WHERE id IN (${placeholders})
           AND state = 'cancelling'
           AND cancel_requested = 1
         RETURNING id`
    ).bind(message, finishedAt, finishedAt, ...ids)
  ]);
  const finalized = results[1]?.results as Array<{ id?: string }> | undefined;
  return (finalized ?? []).map((row) => row.id).filter((id): id is string => Boolean(id));
}

export async function suppressScheduledRetry(
  env: Env,
  runId: string,
  reason: string
): Promise<TaskRun | null> {
  const current = await getRun(env, runId);
  if (!current) return null;
  const detail = safeJsonObject(current.detail_json);
  return updateRun(env, {
    runId,
    detail: {
      ...detail,
      suppressScheduledRetry: true,
      retrySuppressionReason: reason
    }
  });
}

export async function appendRunEvent(
  env: Env,
  input: {
    runId: string;
    level: "debug" | "info" | "warning" | "error";
    step?: string | null;
    message: string;
    detail?: unknown;
    streamEventId?: string | null;
  }
): Promise<void> {
  const detail = JSON.stringify(input.detail ?? {});
  const createdAt = isoNow();
  if (input.streamEventId) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO task_events(run_id, level, step, message, detail_json, created_at, stream_event_id) VALUES(?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        input.runId,
        input.level,
        input.step ?? null,
        input.message,
        detail,
        createdAt,
        input.streamEventId
      )
      .run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO task_events(run_id, level, step, message, detail_json, created_at) VALUES(?, ?, ?, ?, ?, ?)"
  )
    .bind(
      input.runId,
      input.level,
      input.step ?? null,
      input.message,
      detail,
      createdAt
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
  const command = await env.DB.prepare(
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
    .first<CommandRow>();
  if (!command) throw new Error("Unable to create command");
  await notifyAgentCommandAvailable(env, input.agentId);
  return command;
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
           AND (
             type = 'interrupt_task'
             OR (
               type = 'run_task'
               AND run_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM task_runs AS target_run
                 WHERE target_run.id = command_queue.run_id
                   AND target_run.state IN ('queued', 'claimed')
                   AND target_run.cancel_requested = 0
               )
             )
           )
           AND (
             ? = 1
             OR NOT EXISTS (
               SELECT 1
               FROM command_queue AS active_command
               JOIN task_runs AS active_run
                 ON active_run.id = active_command.run_id
               WHERE active_command.agent_id = ?
                 AND active_command.type = 'run_task'
                 AND active_command.state = 'claimed'
                 AND active_command.id <> command_queue.id
                 AND active_run.state IN ('queued', 'claimed', 'running', 'cancelling')
             )
           )
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
       )
       RETURNING *`
  )
    .bind(
      leaseToken,
      leaseExpiresAt,
      now,
      input.agentId,
      now,
      now,
      input.busy ? 1 : 0,
      input.agentId
    )
    .first<CommandRow>();
}

export async function hasAvailableCommand(
  env: Env,
  input: { agentId: string; busy: boolean }
): Promise<boolean> {
  const now = isoNow();
  const allowedClause = input.busy ? "AND type = 'interrupt_task'" : "";
  const row = await env.DB.prepare(
    `SELECT 1 AS available
     FROM command_queue
     WHERE agent_id = ?
       AND available_at <= ?
       AND (
         state = 'queued'
         OR (state = 'claimed' AND lease_expires_at < ?)
       )
       ${allowedClause}
       AND (
         type = 'interrupt_task'
         OR (
           type = 'run_task'
           AND run_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM task_runs AS target_run
             WHERE target_run.id = command_queue.run_id
               AND target_run.state IN ('queued', 'claimed')
               AND target_run.cancel_requested = 0
           )
         )
       )
       AND (
         ? = 1
         OR NOT EXISTS (
           SELECT 1
           FROM command_queue AS active_command
           JOIN task_runs AS active_run
             ON active_run.id = active_command.run_id
           WHERE active_command.agent_id = ?
             AND active_command.type = 'run_task'
             AND active_command.state = 'claimed'
             AND active_command.id <> command_queue.id
             AND active_run.state IN ('queued', 'claimed', 'running', 'cancelling')
         )
       )
     LIMIT 1`
  )
    .bind(input.agentId, now, now, input.busy ? 1 : 0, input.agentId)
    .first<{ available: number }>();
  return Boolean(row);
}

export async function renewCommandLease(
  env: Env,
  input: { commandId: string; leaseToken: string; leaseMs?: number }
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + Math.max(60_000, input.leaseMs ?? 5 * 60_000))
    .toISOString();
  const row = await env.DB.prepare(
    `UPDATE command_queue
     SET lease_expires_at = ?
     WHERE id = ? AND state = 'claimed' AND lease_token = ?
     RETURNING id`
  )
    .bind(expiresAt, input.commandId, input.leaseToken)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function releaseCommandClaim(
  env: Env,
  input: { commandId: string; leaseToken: string; message?: string }
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE command_queue SET
       state = 'queued',
       lease_token = NULL,
       lease_expires_at = NULL,
       claimed_at = NULL,
       message = ?
     WHERE id = ? AND state = 'claimed' AND lease_token = ?`
  )
    .bind(
      input.message ?? "WebSocket delivery was not acknowledged; returned to queue",
      input.commandId,
      input.leaseToken
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
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
  const commandQuery = env.DB.prepare(
    `SELECT * FROM command_queue
     WHERE id = ? AND state = 'claimed' AND lease_token = ?`
  );
  // Some lightweight test doubles only implement bind/batch. The lookup is
  // optional for terminal cancellation/completion, while production D1 always
  // provides first().
  const command = typeof (commandQuery as D1PreparedStatement).first === "function"
    ? await (commandQuery as D1PreparedStatement)
        .bind(input.commandId, input.leaseToken)
        .first<CommandRow>()
    : null;
  const completedRun = command?.run_id ? await getRun(env, command.run_id) : null;
  const now = isoNow();
  const ownsRunLifecycle = command?.type === "run_task";
  const cancellationRequested = ownsRunLifecycle && completedRun?.cancel_requested === 1;
  const terminalRunState =
    (ownsRunLifecycle && input.state === "cancelled") ||
    cancellationRequested
      ? "interrupted"
      : input.state === "completed"
        ? "succeeded"
        : "failed";
  const terminalRunMessage =
    (ownsRunLifecycle && input.state === "cancelled") ||
    cancellationRequested
      ? command?.type === "run_task" && input.state === "cancelled"
        ? input.message
        : "任务已由管理员中断"
      : input.message;
  const [commandResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE command_queue SET
         state = ?, message = ?, finished_at = ?, lease_expires_at = NULL
       WHERE id = ? AND state = 'claimed' AND lease_token = ?`
    ).bind(input.state, input.message, now, input.commandId, input.leaseToken),
    // An interrupt command only acknowledges delivery. The run_task command
    // owns the final state after Agent cleanup has completed.
    env.DB.prepare(
      `UPDATE task_runs SET
         state = ?,
         message = ?,
         current_step = NULL,
         finished_at = ?,
         updated_at = ?
       WHERE id = (
         SELECT run_id
         FROM command_queue
         WHERE id = ?
           AND lease_token = ?
           AND type = 'run_task'
           AND state = ?
       )
         AND state IN ('queued', 'claimed', 'running', 'cancelling')`
    ).bind(
      terminalRunState,
      terminalRunMessage,
      now,
      now,
      input.commandId,
      input.leaseToken,
      input.state
    )
  ]);
  const completed = (commandResult?.meta.changes ?? 0) > 0;
  if (
    completed &&
    terminalRunState === "failed" &&
    command?.type === "run_task" &&
    completedRun &&
    (completedRun.trigger_mode === "scheduled" ||
      ["manual", "scheduled_window"].includes(
        String(safeJsonObject(completedRun.detail_json).retryPolicy)
      ) ||
      safeJsonObject(completedRun.detail_json).manualRetryEligible === true)
  ) {
    const detail = safeJsonObject(completedRun.detail_json);
    const suppressScheduledRetry = detail.suppressScheduledRetry === true;
    const retryLimit = Math.max(0, Math.min(6, Number(detail.scheduledRetryLimit) || 0));
    const retryAttempt = scheduledRetryAttempt(
      detail,
      completedRun.schedule_key
    );
    let patrolDeadlineAt = Date.parse(String(detail.patrolDeadlineAt || ""));
    // Runs created before the deadline field was persisted still get the same
    // protection. Reconstruct their deadline from the run's local date and
    // the stored patrol payload (falling back to current automation config).
    if (
      !Number.isFinite(patrolDeadlineAt) &&
      (completedRun.task_key === "patrol" || detail.patrol)
    ) {
      try {
        const bundle = await getConfigBundle(env);
        const timezone = bundle.automationConfig.timezone;
        const patrol = detail.patrol && typeof detail.patrol === "object"
          ? detail.patrol
          : bundle.automationConfig.tasks.patrol;
        const localDate =
          completedRun.local_date ||
          zonedDateKey(new Date(completedRun.created_at), timezone);
        patrolDeadlineAt = Date.parse(
          zonedDateTimeToIso(
            localDate,
            String(patrol.deadline),
            timezone
          )
        );
      } catch {
        patrolDeadlineAt = Number.NaN;
      }
    }
    const patrolDeadlineExceeded =
      Number.isFinite(patrolDeadlineAt) && Date.now() >= patrolDeadlineAt;
    if (suppressScheduledRetry || patrolDeadlineExceeded) {
      await appendRunEvent(env, {
        runId: completedRun.id,
        level: "warning",
        step: "scheduled_retry_suppressed",
        message: patrolDeadlineExceeded
          ? "巡逻任务已超过后台设置的截止时间；本次失败不再按定时重试次数重新启动任务"
          : "任务已进入结束收尾阶段；本次收尾错误不再按失败重试次数重新启动任务",
        detail: {
          reason: patrolDeadlineExceeded
            ? "patrol_deadline_exceeded"
            : detail.retrySuppressionReason || "task_cleanup"
        }
      });
    } else if (retryAttempt < retryLimit) {
      const nextAttempt = retryAttempt + 1;
      const retryDetail = {
        ...detail,
        scheduledRetryAttempt: nextAttempt,
        retryOfRunId: completedRun.id,
        retryReason: input.message
      };
      const retryRun = await createRun(env, {
        taskKey: completedRun.task_key,
        scheduleKey: `${completedRun.schedule_key ?? completedRun.id}:retry:${nextAttempt}`,
        triggerMode: "scheduled",
        message: `定时任务失败，已发起第 ${nextAttempt}/${retryLimit} 次重试`,
        detail: retryDetail,
        localDate: completedRun.local_date
      });
      if (retryRun && command) {
        const payload = safeJsonObject(command.payload_json);
        await createCommand(env, {
          runId: retryRun.id,
          agentId: command.agent_id,
          type: "run_task",
          payload: {
            ...payload,
            runId: retryRun.id,
            triggerMode: "scheduled",
            detail: retryDetail
          }
        });
        await appendRunEvent(env, {
          runId: completedRun.id,
          level: "warning",
          step: "scheduled_retry",
          message: `任务失败，已发起第 ${nextAttempt}/${retryLimit} 次定时重试`,
          detail: { retryRunId: retryRun.id, retryAttempt: nextAttempt, retryLimit }
        });
        await appendRunEvent(env, {
          runId: retryRun.id,
          level: "info",
          step: "scheduled_retry",
          message: `这是第 ${nextAttempt}/${retryLimit} 次定时重试`,
          detail: { retryOfRunId: completedRun.id, retryAttempt: nextAttempt, retryLimit }
        });
      }
    }
  }
  return completed;
}

function safeJsonObject(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function mergeRunDetail(currentDetail: string | null, nextDetail: unknown): string {
  return JSON.stringify({
    ...safeJsonObject(currentDetail),
    ...safeJsonObject(nextDetail)
  });
}

export function scheduledRetryAttempt(
  detail: Record<string, any>,
  scheduleKey: string | null
): number {
  const detailAttempt = Math.max(0, Number(detail.scheduledRetryAttempt) || 0);
  const keyAttempts = [...String(scheduleKey || "").matchAll(/(?:^|:)retry:(\d+)(?=:|$)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return Math.max(detailAttempt, ...keyAttempts, 0);
}

export async function reconcileTerminalRunCommands(env: Env): Promise<number> {
  const now = isoNow();
  const result = await env.DB.prepare(
    `UPDATE task_runs SET
       state = CASE (
         SELECT state
         FROM command_queue
         WHERE run_id = task_runs.id AND type = 'run_task'
         ORDER BY created_at DESC
         LIMIT 1
       )
         WHEN 'completed' THEN 'succeeded'
         WHEN 'cancelled' THEN 'interrupted'
         ELSE 'failed'
       END,
       message = COALESCE((
         SELECT message
         FROM command_queue
         WHERE run_id = task_runs.id AND type = 'run_task'
         ORDER BY created_at DESC
         LIMIT 1
       ), message),
       current_step = NULL,
       finished_at = COALESCE(finished_at, (
         SELECT finished_at
         FROM command_queue
         WHERE run_id = task_runs.id AND type = 'run_task'
         ORDER BY created_at DESC
         LIMIT 1
       ), ?),
       updated_at = ?
     WHERE state IN ('queued', 'claimed', 'running', 'cancelling')
       AND EXISTS (
         SELECT 1
         FROM command_queue
         WHERE run_id = task_runs.id
           AND type = 'run_task'
           AND state IN ('completed', 'failed', 'cancelled')
       )`
  )
    .bind(now, now)
    .run();
  return result.meta.changes ?? 0;
}

export async function touchHeartbeat(
  env: Env,
  input: {
    agentId: string;
    displayName: string;
    activeRunId: string | null;
    activeTaskKey: TaskKey | null;
    status: string;
    capabilities: unknown;
    detail: unknown;
  }
): Promise<void> {
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_heartbeats(
         agent_id, display_name, active_run_id, active_task_key, status,
         capabilities_json, detail_json, first_seen_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         display_name = CASE
           WHEN agent_heartbeats.display_name IS NULL
             OR agent_heartbeats.display_name = agent_heartbeats.agent_id
           THEN excluded.display_name
           ELSE agent_heartbeats.display_name
         END,
         active_run_id = excluded.active_run_id,
         active_task_key = excluded.active_task_key,
         status = excluded.status,
         capabilities_json = excluded.capabilities_json,
         detail_json = excluded.detail_json,
         updated_at = excluded.updated_at`
    ).bind(
      input.agentId,
      input.displayName,
      input.activeRunId,
      input.activeTaskKey,
      input.status,
      JSON.stringify(input.capabilities),
      JSON.stringify(input.detail),
      now,
      now
    ),
    env.DB.prepare(
      `UPDATE settings SET
         value = json_set(value, '$.agentId', ?),
         updated_at = ?
       WHERE key = 'camp_config'
         AND COALESCE(json_extract(value, '$.agentId'), '') = ''`
    ).bind(input.agentId, now)
  ]);
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

export async function deleteAgentHeartbeat(
  env: Env,
  agentId: string,
  activeAgentId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM agent_heartbeats WHERE agent_id = ? AND agent_id <> ?"
  )
    .bind(agentId, activeAgentId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
