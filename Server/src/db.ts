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

export async function listVotePollDates(env: Env): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT DISTINCT poll_date FROM tech_ballots ORDER BY poll_date DESC"
  ).all<{ poll_date: string }>();
  return result.results.map((row) => row.poll_date);
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

export async function listMembers(env: Env, limit = 200): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT id, name, profession, manor_level, roommate_name, camp_title,
            weekly_contribution, technology_points_used, material_contribution,
            last_seen_at
     FROM members
     ORDER BY weekly_contribution DESC, name ASC
     LIMIT ?`
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  return result.results;
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
): Promise<ContributionReconciliation> {
  const current = await env.DB.prepare(
    "SELECT name, weekly_contribution FROM members ORDER BY name"
  ).all<{ name: string; weekly_contribution: number }>();
  const reconciliation = reconcileContributionMembers(
    input.members,
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
  const exactByName = new Map<string, ContributionMaster[]>();
  for (const member of masterMembers) {
    const key = comparableMemberName(member.name);
    exactByName.set(key, [...(exactByName.get(key) ?? []), member]);
  }

  const updates: ContributionRow[] = [];
  let ignored = 0;
  let ambiguous = 0;
  for (const row of incoming) {
    const exactCandidates = (exactByName.get(comparableMemberName(row.name)) ?? [])
      .filter((member) => available.has(member.name));
    let candidate: ContributionMaster | null = null;
    if (exactCandidates.length === 1) {
      candidate = exactCandidates[0]!;
    } else if (exactCandidates.length > 1) {
      ambiguous += 1;
      ignored += 1;
      continue;
    } else {
      const sourceName = comparableMemberName(row.name);
      const fuzzyCandidates = masterMembers.flatMap((member) => {
        if (!available.has(member.name)) return [];
        const targetName = comparableMemberName(member.name);
        const minimumLength = Math.min(sourceName.length, targetName.length);
        const distance = levenshteinDistance(sourceName, targetName);
        const maximumDistance =
          minimumLength >= 10 ? 3 : minimumLength >= 5 ? 2 : 1;
        return sourceName.length >= 3 &&
          targetName.length >= 3 &&
          distance <= maximumDistance &&
          contributionsCorroborate(
            row.weeklyContribution,
            member.weeklyContribution
          )
          ? [{ member, distance }]
          : [];
      });
      fuzzyCandidates.sort((left, right) => left.distance - right.distance);
      const best = fuzzyCandidates[0];
      const second = fuzzyCandidates[1];
      if (best && (!second || best.distance < second.distance)) {
        candidate = best.member;
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
  incoming: ActivityRow[]
): ActivityReconciliation {
  const updatesByName = new Map<string, ActivityRow>();
  let ignored = 0;

  for (const row of incoming) {
    const key =
      symbolInsensitiveMemberName(row.name) || comparableMemberName(row.name);
    if (!key) {
      ignored += 1;
      continue;
    }
    const existing = updatesByName.get(key);
    if (existing) {
      ignored += 1;
      if (
        Number(row.inactiveDays ?? -1) >
        Number(existing.inactiveDays ?? -1)
      ) {
        updatesByName.set(key, row);
      }
      continue;
    }
    updatesByName.set(key, { ...row, name: row.name.trim() });
  }

  return { updates: [...updatesByName.values()], ignored, ambiguous: 0 };
}

function symbolInsensitiveMemberName(value: string): string {
  return comparableMemberName(value).replace(/[^\p{L}\p{N}]/gu, "");
}

export async function updateActivitySnapshot(
  env: Env,
  input: {
    runId: string;
    capturedAt: string;
    members: ActivityRow[];
  }
): Promise<ActivityReconciliation> {
  const reconciliation = reconcileActivityMembers(input.members);
  // Preserve the last valid warning snapshot when a non-empty OCR payload
  // cannot produce even one self-contained warning row.
  if (input.members.length > 0 && reconciliation.updates.length === 0) {
    return reconciliation;
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM activity_warnings")
  ];
  for (const member of reconciliation.updates) {
    const nameKey =
      symbolInsensitiveMemberName(member.name) ||
      comparableMemberName(member.name);
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
  const statements: D1PreparedStatement[] = [];
  for (const member of input.members) {
    const memberId = await stableMemberId(member.name);
    statements.push(
      env.DB.prepare(
        `INSERT INTO members(
           id, name, profession, manor_level, roommate_name, camp_title,
           weekly_contribution, last_seen_at, source_run_id
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           profession = excluded.profession,
           manor_level = excluded.manor_level,
           roommate_name = excluded.roommate_name,
           camp_title = excluded.camp_title,
           weekly_contribution = excluded.weekly_contribution,
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
  const terminal = [
    "interrupted",
    "succeeded",
    "partially_succeeded",
    "failed",
    "timed_out",
    "skipped"
  ].includes(state);
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
