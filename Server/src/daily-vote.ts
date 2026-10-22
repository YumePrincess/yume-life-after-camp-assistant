import { decryptSecret } from "./crypto";
import { normalizeLocale, type SupportedLocale } from "./locale";
import { addDaysToDateKey, zonedDateTimeToIso, zonedParts } from "./time";
import { getConfigBundle } from "./db";
import {
  DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS,
  normalizeVoteEligibilityThresholds,
  type VoteEligibilityThresholds
} from "./vote-eligibility";

export type DailyVoteKind = "poll" | "draw";
export const PUBLIC_VOTE_HISTORY_LIMIT = 10;

export type DailyVoteBlock =
  | { type: "text"; text: string }
  | { type: "image" | "video"; url: string; alt?: string };

export interface DailyVoteOptionContent {
  id: string;
  blocks: DailyVoteBlock[];
}

export interface DailyVoteContent {
  titleBlocks: DailyVoteBlock[];
  descriptionBlocks: DailyVoteBlock[];
  options: DailyVoteOptionContent[];
}

export type DailyVoteLocalizedContent = Partial<
  Record<SupportedLocale, DailyVoteContent>
>;

export interface DailyVoteItem {
  id: string;
  kind: DailyVoteKind;
  localizedContent: DailyVoteLocalizedContent;
  startAt: string;
  endAt: string;
  revealBeforeSeconds: number;
  maxSelections: number | null;
  drawCount: number | null;
  batchNumber: string;
  drawTypeCode: string;
  drawLimitEnabled: boolean;
  eligibilityCheckEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicDailyVoteItem {
  id: string;
  kind: DailyVoteKind;
  titleBlocks: DailyVoteBlock[];
  descriptionBlocks: DailyVoteBlock[];
  options: Array<DailyVoteOptionContent & { votes: number }>;
  startAt: string;
  endAt: string;
  maxSelections: number | null;
  drawCount: number | null;
  participantCount: number;
  isOpen: boolean;
}

export interface PublicDailyVoteHistoryItem extends PublicDailyVoteItem {
  winners: Array<{ playerName: string }>;
  finalized: boolean;
}

export interface DailyVoteResponseDetail {
  id: string;
  identityCode: string;
  playerName: string;
  selections: string[];
  submittedAt: string;
}

export interface AdminDailyVoteItem extends DailyVoteItem {
  responses: DailyVoteResponseDetail[];
  winners: Array<{ playerName: string; identityCode: string; rank: number }>;
}

export interface AdminDailyVotePage {
  page: number;
  total: number;
  config: DailyVoteConfig;
  items: AdminDailyVoteItem[];
}

export interface DailyVoteConfig {
  drawMaxWinsPerMonth: number;
  voteEligibilityEnabled: boolean;
  voteEligibility: VoteEligibilityThresholds;
}

export function localDailyDateRange(date: string, timezone: string): {
  startAt: string;
  endAt: string;
} {
  return {
    startAt: zonedDateTimeToIso(date, "00:00", timezone),
    endAt: zonedDateTimeToIso(addDaysToDateKey(date, 1), "00:00", timezone)
  };
}

export function localCalendarMonthRange(date: Date, timezone: string): {
  key: string;
  startAt: string;
  endAt: string;
} {
  const { year, month } = zonedParts(date, timezone);
  const monthStartDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const nextMonthStartDate = new Date(Date.UTC(year, month, 1, 12))
    .toISOString()
    .slice(0, 10);
  return {
    key: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
    startAt: zonedDateTimeToIso(monthStartDate, "00:00", timezone),
    endAt: zonedDateTimeToIso(nextMonthStartDate, "00:00", timezone)
  };
}

const LOCALES: SupportedLocale[] = ["zh-cn", "zh-tw", "en", "fr", "ja"];
const MAX_CONTENT_BYTES = 240_000;
const DEFAULT_DAILY_VOTE_CONFIG: DailyVoteConfig = {
  drawMaxWinsPerMonth: 4,
  voteEligibilityEnabled: true,
  voteEligibility: DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS
};
const DRAW_FINALIZE_LOCK_MS = 10 * 60 * 1000;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${field} is invalid`);
  return result;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, max);
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function booleanValue(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function batchNumberValue(value: unknown): string {
  const result = typeof value === "string"
    ? value.trim()
    : Number.isInteger(value) && Number(value) >= 0
      ? String(value)
      : "";
  if (!/^\d{1,8}$/.test(result)) {
    throw new Error("batchNumber must contain 1 to 8 digits");
  }
  return result;
}

function drawTypeCodeValue(value: unknown): string {
  const result = typeof value === "string"
    ? value.trim()
    : Number.isInteger(value) && Number(value) >= 0
      ? String(value)
      : "";
  if (!/^\d{1,8}$/.test(result)) {
    throw new Error("drawTypeCode must contain 1 to 8 digits");
  }
  return result;
}

export function normalizeDailyVoteConfig(value: unknown): DailyVoteConfig {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    drawMaxWinsPerMonth: integer(
      source.drawMaxWinsPerMonth ??
        source.drawMaxWins28Days ??
        DEFAULT_DAILY_VOTE_CONFIG.drawMaxWinsPerMonth,
      "drawMaxWinsPerMonth",
      0,
      10_000
    ),
    voteEligibilityEnabled: booleanValue(
      source.voteEligibilityEnabled,
      "voteEligibilityEnabled",
      DEFAULT_DAILY_VOTE_CONFIG.voteEligibilityEnabled
    ),
    voteEligibility: normalizeVoteEligibilityThresholds(
      source.voteEligibility,
      "voteEligibility"
    )
  };
}

function isoDateTime(value: unknown, field: string): string {
  const result = text(value, field, 40);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be an ISO date-time`);
  return parsed.toISOString();
}

function localDateTimeToIso(value: unknown, field: string, timezone?: string): string {
  const result = text(value, field, 40);
  const match = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result);
  if (!match || !timezone) throw new Error(`${field} must use YYYY-MM-DDTHH:mm`);
  return zonedDateTimeToIso(match[1]!, match[2]!, timezone);
}

function blocks(value: unknown, field: string, required: boolean): DailyVoteBlock[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > 48 || (required && value.length < 1)) {
    throw new Error(`${field} must contain between ${required ? 1 : 0} and 48 blocks`);
  }
  return value.map((raw, index) => {
    const source = object(raw, `${field}[${index}]`);
    if (source.type === "text") {
      return { type: "text", text: text(source.text, `${field}[${index}].text`, 2_000) };
    }
    if (source.type === "image" || source.type === "video") {
      const url = text(source.url, `${field}[${index}].url`, 2_000);
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || (source.type === "video" && (parsed.username || parsed.password))) throw new Error();
      } catch {
        throw new Error(`${field}[${index}].url must be an HTTPS URL`);
      }
      const alt = optionalText(source.alt, `${field}[${index}].alt`, 160);
      return { type: source.type, url, ...(alt ? { alt } : {}) };
    }
    throw new Error(`${field}[${index}].type must be text, image or video`);
  });
}

function optionContent(value: unknown, field: string): DailyVoteOptionContent {
  const source = object(value, field);
  const id = text(source.id, `${field}.id`, 80);
  return { id, blocks: blocks(source.blocks, `${field}.blocks`, true) };
}

function content(value: unknown, field: string, kind: DailyVoteKind): DailyVoteContent {
  const source = object(value, field);
  const options = Array.isArray(source.options)
    ? source.options.map((item, index) => optionContent(item, `${field}.options[${index}]`))
    : [];
  if (kind === "poll" && (options.length < 2 || options.length > 50)) {
    throw new Error(`${field}.options must contain between 2 and 50 options`);
  }
  const ids = new Set<string>();
  for (const option of options) {
    if (ids.has(option.id)) throw new Error(`${field}.options contains duplicate ids`);
    ids.add(option.id);
  }
  return {
    titleBlocks: blocks(source.titleBlocks, `${field}.titleBlocks`, true),
    descriptionBlocks: blocks(source.descriptionBlocks, `${field}.descriptionBlocks`, false),
    options
  };
}

function isContent(value: unknown): value is DailyVoteContent {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeLocalizedContent(
  value: unknown,
  kind: DailyVoteKind
): DailyVoteLocalizedContent {
  const source = object(value, "localizedContent");
  const hasDirectContent = "titleBlocks" in source;
  const entries = hasDirectContent
    ? [["zh-cn", source] as const]
    : Object.entries(source);
  const result: DailyVoteLocalizedContent = {};
  for (const [locale, raw] of entries) {
    if (!LOCALES.includes(locale as SupportedLocale)) continue;
    result[locale as SupportedLocale] = content(raw, `localizedContent.${locale}`, kind);
  }
  if (!Object.keys(result).length) throw new Error("localizedContent must contain one supported locale");
  return result;
}

export function normalizeDailyVoteInput(
  value: unknown,
  existing?: DailyVoteItem,
  timezone?: string
): {
  kind: DailyVoteKind;
  localizedContent: DailyVoteLocalizedContent;
  startAt: string;
  endAt: string;
  revealBeforeSeconds: number;
  maxSelections: number | null;
  drawCount: number | null;
  batchNumber: string;
  drawTypeCode: string;
  drawLimitEnabled: boolean;
  eligibilityCheckEnabled: boolean;
} {
  const source = object(value, "dailyVote");
  const kind = source.kind === "draw" ? "draw" : source.kind === "poll" ? "poll" : null;
  if (!kind) throw new Error("kind must be poll or draw");
  const localizedContent = normalizeLocalizedContent(
    source.localizedContent ?? source.content,
    kind
  );
  const startAt = source.startAtLocal !== undefined
    ? localDateTimeToIso(source.startAtLocal, "startAtLocal", timezone)
    : isoDateTime(source.startAt, "startAt");
  const endAt = source.endAtLocal !== undefined
    ? localDateTimeToIso(source.endAtLocal, "endAtLocal", timezone)
    : isoDateTime(source.endAt, "endAt");
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new Error("endAt must be later than startAt");
  }
  const revealBeforeSeconds = integer(
    source.revealBeforeSeconds ?? 0,
    "revealBeforeSeconds",
    0,
    31_536_000
  );
  const firstContent = Object.values(localizedContent)[0];
  if (!firstContent || !isContent(firstContent)) throw new Error("localizedContent is empty");
  const maxSelections = kind === "poll"
    ? integer(source.maxSelections, "maxSelections", 1, firstContent.options.length)
    : null;
  const drawCount = kind === "draw"
    ? integer(source.drawCount, "drawCount", 1, 10_000)
    : null;
  const batchNumber = kind === "draw"
    ? batchNumberValue(source.batchNumber)
    : "0";
  const drawTypeCode = kind === "draw"
    ? drawTypeCodeValue(source.drawTypeCode ?? existing?.drawTypeCode ?? "0")
    : "0";
  const drawLimitEnabled = kind === "draw"
    ? booleanValue(source.drawLimitEnabled, "drawLimitEnabled", existing?.drawLimitEnabled ?? true)
    : false;
  const eligibilityCheckEnabled = booleanValue(
    source.eligibilityCheckEnabled,
    "eligibilityCheckEnabled",
    existing?.eligibilityCheckEnabled ?? true
  );
  if (existing && existing.kind !== kind) throw new Error("已存在的事项不能更改类型");
  const serialized = JSON.stringify(localizedContent);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONTENT_BYTES) {
    throw new Error("localizedContent is too large");
  }
  return {
    kind,
    localizedContent,
    startAt,
    endAt,
    revealBeforeSeconds,
    maxSelections,
    drawCount,
    batchNumber,
    drawTypeCode,
    drawLimitEnabled,
    eligibilityCheckEnabled
  };
}

interface DailyVoteRow {
  id: string;
  kind: DailyVoteKind;
  content_json: string;
  start_at: string;
  end_at: string;
  reveal_before_seconds: number;
  max_selections: number | null;
  draw_count: number | null;
  batch_number: string;
  draw_type_code: string;
  draw_limit_enabled: number;
  eligibility_check_enabled: number;
  created_at: string;
  updated_at: string;
}

interface DailyVoteResponseRow {
  id: string;
  item_id: string;
  identity_code_id: string;
  player_name: string | null;
  selections_json: string;
  created_at: string;
  updated_at: string;
  code_encrypted?: string | null;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function getDailyVoteConfig(env: Env): Promise<DailyVoteConfig> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'daily_vote_config'"
  ).first<{ value: string }>();
  return normalizeDailyVoteConfig(parseJson(row?.value, DEFAULT_DAILY_VOTE_CONFIG));
}

export async function saveDailyVoteConfig(
  env: Env,
  value: unknown
): Promise<DailyVoteConfig> {
  const config = normalizeDailyVoteConfig(value);
  await env.DB.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES('daily_vote_config', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(config), new Date().toISOString()).run();
  return config;
}

function itemFromRow(row: DailyVoteRow): DailyVoteItem {
  return {
    id: row.id,
    kind: row.kind,
    localizedContent: parseJson<DailyVoteLocalizedContent>(row.content_json, {}),
    startAt: row.start_at,
    endAt: row.end_at,
    revealBeforeSeconds: Number(row.reveal_before_seconds) || 0,
    maxSelections: row.max_selections === null ? null : Number(row.max_selections),
    drawCount: row.draw_count === null ? null : Number(row.draw_count),
    batchNumber: row.batch_number || "0",
    drawTypeCode: row.draw_type_code || "0",
    drawLimitEnabled: Number(row.draw_limit_enabled) === 1,
    eligibilityCheckEnabled: Number(row.eligibility_check_enabled) !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function resolvedContent(item: DailyVoteItem, localeValue: unknown): DailyVoteContent {
  const locale = normalizeLocale(localeValue);
  const candidates = [
    item.localizedContent[locale],
    item.localizedContent["zh-cn"],
    ...Object.values(item.localizedContent)
  ];
  const selected = candidates.find((entry): entry is DailyVoteContent => isContent(entry));
  return selected ?? { titleBlocks: [], descriptionBlocks: [], options: [] };
}

async function responseRows(env: Env, itemId: string): Promise<DailyVoteResponseRow[]> {
  const result = await env.DB.prepare(
    `SELECT r.id, r.item_id, r.identity_code_id,
            COALESCE(NULLIF(TRIM(c.player_name), ''), r.player_name) AS player_name,
            r.selections_json, r.created_at, r.updated_at
     FROM daily_vote_responses r
     LEFT JOIN identity_codes c ON c.id = r.identity_code_id
     WHERE r.item_id = ?
     ORDER BY r.updated_at DESC`
  ).bind(itemId).all<DailyVoteResponseRow>();
  return result.results;
}

function countsFor(item: DailyVoteItem, rows: DailyVoteResponseRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  const ids = new Set(resolvedContent(item, "zh-cn").options.map((option) => option.id));
  for (const row of rows) {
    for (const id of new Set(parseJson<unknown[]>(row.selections_json, []))) {
      if (typeof id === "string" && ids.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

async function winnerRows(env: Env, itemId: string): Promise<Array<{ playerName: string; identityCode: string; rank: number }>> {
  const rows = await env.DB.prepare(
    `SELECT w.rank,
            COALESCE(NULLIF(TRIM(c.player_name), ''), r.player_name) AS player_name,
            c.code_encrypted
     FROM daily_draw_winners w
     JOIN daily_vote_responses r ON r.id = w.response_id
     LEFT JOIN identity_codes c ON c.id = r.identity_code_id
     WHERE w.item_id = ? ORDER BY w.rank ASC`
  ).bind(itemId).all<{ rank: number; player_name: string | null; code_encrypted: string | null }>();
  return Promise.all(rows.results.map(async (row) => ({
    rank: Number(row.rank),
    playerName: row.player_name?.trim() || "—",
    identityCode: row.code_encrypted
      ? await decryptSecret(env, "identity-code-value", row.code_encrypted).catch(() => "—")
      : "—"
  })));
}

async function winnerIdentityRows(
  env: Env,
  itemId: string
): Promise<Array<{ responseId: string; identityCodeId: string }>> {
  const result = await env.DB.prepare(
    `SELECT response_id, identity_code_id
     FROM daily_draw_winners
     WHERE item_id = ?
     ORDER BY rank ASC`
  ).bind(itemId).all<{ response_id: string; identity_code_id: string }>();
  return result.results.map((row) => ({
    responseId: row.response_id,
    identityCodeId: row.identity_code_id
  }));
}

export async function saveDailyVoteItem(
  env: Env,
  input: ReturnType<typeof normalizeDailyVoteInput>,
  id = crypto.randomUUID()
): Promise<DailyVoteItem> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO daily_vote_items(
       id, kind, content_json, start_at, end_at, reveal_before_seconds,
       max_selections, draw_count, batch_number, draw_type_code, draw_limit_enabled,
       eligibility_check_enabled, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, input.kind, JSON.stringify(input.localizedContent), input.startAt, input.endAt,
    input.revealBeforeSeconds, input.maxSelections, input.drawCount, input.batchNumber,
    input.drawTypeCode,
    input.drawLimitEnabled ? 1 : 0, input.eligibilityCheckEnabled ? 1 : 0, now, now
  ).run();
  return {
    id,
    kind: input.kind,
    localizedContent: input.localizedContent,
    startAt: input.startAt,
    endAt: input.endAt,
    revealBeforeSeconds: input.revealBeforeSeconds,
    maxSelections: input.maxSelections,
    drawCount: input.drawCount,
    batchNumber: input.batchNumber,
    drawTypeCode: input.drawTypeCode,
    drawLimitEnabled: input.drawLimitEnabled,
    eligibilityCheckEnabled: input.eligibilityCheckEnabled,
    createdAt: now,
    updatedAt: now
  };
}

export async function updateDailyVoteItem(
  env: Env,
  id: string,
  input: ReturnType<typeof normalizeDailyVoteInput>
): Promise<DailyVoteItem | null> {
  const existing = await getDailyVoteItem(env, id);
  if (!existing) return null;
  if (existing.kind === "draw" && existing.batchNumber !== input.batchNumber) {
    const winnerCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM daily_draw_winners WHERE item_id = ?"
    ).bind(id).first<{ count: number }>();
    if (Number(winnerCount?.count ?? 0) > 0) {
      throw new Error("已产生中签结果的抽签事项不能修改批次号");
    }
  }
  if (existing.kind === "draw" && existing.drawTypeCode !== input.drawTypeCode) {
    const winnerCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM daily_draw_winners WHERE item_id = ?"
    ).bind(id).first<{ count: number }>();
    if (Number(winnerCount?.count ?? 0) > 0) {
      throw new Error("已产生中签结果的抽签事项不能修改事项类型编码");
    }
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE daily_vote_items SET kind = ?, content_json = ?, start_at = ?, end_at = ?,
       reveal_before_seconds = ?, max_selections = ?, draw_count = ?, batch_number = ?,
       draw_type_code = ?,
       draw_limit_enabled = ?, eligibility_check_enabled = ?, updated_at = ?
     WHERE id = ?`
  ).bind(
    input.kind, JSON.stringify(input.localizedContent), input.startAt, input.endAt,
    input.revealBeforeSeconds, input.maxSelections, input.drawCount, input.batchNumber,
    input.drawTypeCode,
    input.drawLimitEnabled ? 1 : 0, input.eligibilityCheckEnabled ? 1 : 0, now, id
  ).run();
  return { ...existing, ...input, updatedAt: now };
}

export async function getDailyVoteItem(env: Env, id: string): Promise<DailyVoteItem | null> {
  const row = await env.DB.prepare("SELECT * FROM daily_vote_items WHERE id = ?").bind(id).first<DailyVoteRow>();
  return row ? itemFromRow(row) : null;
}

export async function deleteDailyVoteItem(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM daily_vote_items WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteDailyVoteHistory(
  env: Env,
  date: string | undefined,
  timezone: string
): Promise<number> {
  const now = new Date().toISOString();
  let statement: D1PreparedStatement;
  if (date) {
    const range = localDailyDateRange(date, timezone);
    statement = env.DB.prepare(
        `DELETE FROM daily_vote_items
         WHERE end_at <= ?
           AND start_at < ?
           AND end_at > ?`
      ).bind(now, range.endAt, range.startAt);
  } else {
    statement = env.DB.prepare("DELETE FROM daily_vote_items WHERE end_at <= ?").bind(now);
  }
  const result = await statement.run();
  return result.meta.changes ?? 0;
}

async function listItems(
  env: Env,
  where = "",
  binds: unknown[] = [],
  limit?: number
): Promise<DailyVoteItem[]> {
  const sql = `SELECT * FROM daily_vote_items ${where} ORDER BY start_at DESC, created_at DESC${
    limit === undefined ? "" : " LIMIT ?"
  }`;
  const result = await env.DB.prepare(
    sql
  ).bind(...binds, ...(limit === undefined ? [] : [limit])).all<DailyVoteRow>();
  return result.results.map(itemFromRow);
}

const UINT32_RANGE = 0x1_0000_0000;

function secureRandomUint32(): number {
  const sample = new Uint32Array(1);
  crypto.getRandomValues(sample);
  return sample[0]!;
}

function randomIndex(maxExclusive: number, randomUint32 = secureRandomUint32): number {
  if (maxExclusive <= 1) return 0;
  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  let sample = randomUint32();
  while (sample >= limit) sample = randomUint32();
  return sample % maxExclusive;
}

export function selectRandomDrawWinners<T>(
  rows: readonly T[],
  count: number,
  randomUint32 = secureRandomUint32
): T[] {
  const pool = [...rows];
  const winnerCount = Math.min(Math.max(Math.trunc(count), 0), pool.length);
  for (let index = 0; index < winnerCount; index += 1) {
    const target = index + randomIndex(pool.length - index, randomUint32);
    [pool[index], pool[target]] = [pool[target]!, pool[index]!];
  }
  return pool.slice(0, winnerCount);
}

async function finalizeDrawItem(
  env: Env,
  item: DailyVoteItem,
  now: Date,
  maxWinsPerMonth: number,
  monthRange: ReturnType<typeof localCalendarMonthRange>,
  winnerCounts: Map<string, number>
): Promise<number> {
  const responses = await responseRows(env, item.id);
  const target = Math.min(Math.max(Math.trunc(item.drawCount ?? 0), 0), responses.length);
  if (!target) return 0;
  let insertedTotal = 0;

  while (true) {
    const current = await winnerIdentityRows(env, item.id);
    if (current.length >= target) return insertedTotal;
    const usedIdentityIds = new Set(current.map((winner) => winner.identityCodeId));
    if (item.drawTypeCode !== "0") {
      const previousTypeWinners = await env.DB.prepare(
        `SELECT identity_code_id
         FROM daily_draw_winners
         WHERE item_id = (
           SELECT previous.id
           FROM daily_vote_items previous
           WHERE previous.kind = 'draw'
             AND previous.draw_type_code = ?
             AND (previous.end_at, previous.start_at, previous.created_at, previous.id)
               < (?, ?, ?, ?)
             AND EXISTS (
               SELECT 1
               FROM daily_draw_winners prior_winner
               WHERE prior_winner.item_id = previous.id
             )
           ORDER BY previous.end_at DESC, previous.start_at DESC,
                    previous.created_at DESC, previous.id DESC
           LIMIT 1
         )`
      ).bind(
        item.drawTypeCode, item.endAt, item.startAt, item.createdAt, item.id
      ).all<{ identity_code_id: string }>();
      for (const winner of previousTypeWinners.results) {
        usedIdentityIds.add(winner.identity_code_id);
      }
    }
    if (item.batchNumber !== "0") {
      const batchWinners = await env.DB.prepare(
        `SELECT identity_code_id
         FROM daily_draw_winners
         WHERE batch_number = ?`
      ).bind(item.batchNumber).all<{ identity_code_id: string }>();
      for (const winner of batchWinners.results) {
        usedIdentityIds.add(winner.identity_code_id);
      }
    }
    const available = responses.filter((row) =>
      !usedIdentityIds.has(row.identity_code_id) &&
      (!item.drawLimitEnabled ||
        (winnerCounts.get(row.identity_code_id) ?? 0) < maxWinsPerMonth)
    );
    const selected = selectRandomDrawWinners(
      available,
      target - current.length
    );
    if (!selected.length) return insertedTotal;
    const selectedAt = now.toISOString();
    const inserted = await env.DB.batch(selected.map((row, index) => env.DB.prepare(
      `INSERT OR IGNORE INTO daily_draw_winners(
         id, item_id, response_id, identity_code_id, batch_number, rank, selected_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), item.id, row.id, row.identity_code_id,
      item.batchNumber, current.length + index + 1, selectedAt
    )));
    const insertedThisPass = inserted.reduce(
      (count, result) => count + (result.meta.changes ?? 0),
      0
    );
    insertedTotal += insertedThisPass;
    if (!insertedThisPass) return insertedTotal;
    const refreshedCounts = await drawWinnerCountsWithinMonth(env, monthRange);
    winnerCounts.clear();
    for (const [identityCodeId, count] of refreshedCounts) {
      winnerCounts.set(identityCodeId, count);
    }
  }
}

async function drawWinnerCountsWithinMonth(
  env: Env,
  monthRange: ReturnType<typeof localCalendarMonthRange>
): Promise<Map<string, number>> {
  const result = await env.DB.prepare(
    `SELECT identity_code_id, COUNT(*) AS count
     FROM daily_draw_winners
     JOIN daily_vote_items item ON item.id = daily_draw_winners.item_id
     WHERE item.draw_limit_enabled = 1
       AND item.end_at >= ? AND item.end_at < ?
     GROUP BY identity_code_id`
  ).bind(monthRange.startAt, monthRange.endAt).all<{
    identity_code_id: string;
    count: number;
  }>();
  return new Map(
    result.results.map((row) => [row.identity_code_id, Number(row.count) || 0])
  );
}

async function acquireDrawFinalizeLock(
  env: Env,
  token: string,
  now: Date
): Promise<boolean> {
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + DRAW_FINALIZE_LOCK_MS).toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO daily_draw_finalize_lock(id, token, locked_until)
     VALUES(1, '', '1970-01-01T00:00:00.000Z')`
  ).run();
  const result = await env.DB.prepare(
    `UPDATE daily_draw_finalize_lock
     SET token = ?, locked_until = ?
     WHERE id = 1 AND locked_until <= ?`
  ).bind(token, lockedUntil, nowIso).run();
  return (result.meta.changes ?? 0) > 0;
}

async function releaseDrawFinalizeLock(env: Env, token: string, now: Date): Promise<void> {
  await env.DB.prepare(
    `UPDATE daily_draw_finalize_lock
     SET token = '', locked_until = ?
     WHERE id = 1 AND token = ?`
  ).bind(now.toISOString(), token).run();
}

export async function finalizeEndedDraws(
  env: Env,
  now = new Date(),
  config?: DailyVoteConfig,
  timezone?: string
): Promise<number> {
  const token = crypto.randomUUID();
  if (!(await acquireDrawFinalizeLock(env, token, now))) return 0;
  try {
    const [dailyVoteConfig, adminTimezone] = await Promise.all([
      config ? Promise.resolve(config) : getDailyVoteConfig(env),
      timezone
        ? Promise.resolve(timezone)
        : getConfigBundle(env).then((bundle) => bundle.campConfig.timezone)
    ]);
    const winnerCountsByMonth = new Map<string, Map<string, number>>();
    let insertedWinnerCount = 0;
    const ended = await listItems(env, "WHERE kind = 'draw' AND end_at <= ?", [now.toISOString()]);
    ended.sort((left, right) =>
      left.endAt.localeCompare(right.endAt) ||
      left.startAt.localeCompare(right.startAt) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
    for (const item of ended) {
      const monthRange = localCalendarMonthRange(new Date(item.endAt), adminTimezone);
      let winnerCounts = winnerCountsByMonth.get(monthRange.key);
      if (!winnerCounts) {
        winnerCounts = await drawWinnerCountsWithinMonth(env, monthRange);
        winnerCountsByMonth.set(monthRange.key, winnerCounts);
      }
      insertedWinnerCount += await finalizeDrawItem(
        env,
        item,
        now,
        dailyVoteConfig.drawMaxWinsPerMonth,
        monthRange,
        winnerCounts
      );
    }
    return insertedWinnerCount;
  } finally {
    await releaseDrawFinalizeLock(env, token, now);
  }
}

async function publicItem(
  env: Env,
  item: DailyVoteItem,
  locale: unknown,
  now: Date,
  history: boolean
): Promise<PublicDailyVoteItem & Partial<Pick<PublicDailyVoteHistoryItem, "winners" | "finalized">>> {
  const content = resolvedContent(item, locale);
  const rows = await responseRows(env, item.id);
  const counts = countsFor(item, rows);
  const options = content.options.map((option) => ({ ...option, votes: counts.get(option.id) ?? 0 }));
  const result: PublicDailyVoteItem & {
    winners?: Array<{ playerName: string }>;
    finalized?: boolean;
  } = {
    id: item.id,
    kind: item.kind,
    titleBlocks: content.titleBlocks,
    descriptionBlocks: content.descriptionBlocks,
    options,
    startAt: item.startAt,
    endAt: item.endAt,
    maxSelections: item.maxSelections,
    drawCount: item.drawCount,
    participantCount: rows.length,
    isOpen: !history && now >= new Date(item.startAt) && now < new Date(item.endAt)
  };
  if (history && item.kind === "draw") {
    result.winners = (await winnerRows(env, item.id)).map((winner) => ({ playerName: winner.playerName }));
    result.finalized = true;
  }
  return result;
}

export async function buildPublicDailyVote(
  env: Env,
  locale: unknown,
  now = new Date()
): Promise<{ items: PublicDailyVoteItem[]; history: { polls: PublicDailyVoteHistoryItem[]; draws: PublicDailyVoteHistoryItem[] } }> {
  const historyItemsFor = async (kind: DailyVoteKind) => {
    const rows = await env.DB.prepare(
      `SELECT * FROM daily_vote_items
       WHERE kind = ? AND end_at <= ?
       ORDER BY end_at DESC, created_at DESC, id DESC LIMIT ?`
    ).bind(kind, now.toISOString(), PUBLIC_VOTE_HISTORY_LIMIT).all<DailyVoteRow>();
    return rows.results.map(itemFromRow);
  };
  const [all, polls, draws] = await Promise.all([
    listItems(env, "WHERE end_at > ?", [now.toISOString()]),
    historyItemsFor("poll"),
    historyItemsFor("draw")
  ]);
  const active = all.filter((item) => {
    const end = new Date(item.endAt).getTime();
    const reveal = new Date(item.startAt).getTime() - item.revealBeforeSeconds * 1000;
    return end > now.getTime() && reveal <= now.getTime();
  });
  const historyItems = [...polls, ...draws];
  const history = await Promise.all(historyItems.map((item) => publicItem(env, item, locale, now, true)));
  return {
    items: await Promise.all(active.map((item) => publicItem(env, item, locale, now, false))),
    history: {
      polls: history.filter((item): item is PublicDailyVoteHistoryItem => item.kind === "poll"),
      draws: history.filter((item): item is PublicDailyVoteHistoryItem => item.kind === "draw")
    }
  };
}

export async function saveDailyVoteResponse(
  env: Env,
  input: { itemId: string; identityCodeId: string; playerName: string; selections: string[] }
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO daily_vote_responses(
       id, item_id, identity_code_id, player_name, selections_json, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, identity_code_id) DO NOTHING`
  ).bind(
    crypto.randomUUID(), input.itemId, input.identityCodeId, input.playerName || null,
    JSON.stringify(input.selections), now, now
  ).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listAdminDailyVoteItems(
  env: Env,
  options: {
    date?: string;
    kind?: DailyVoteKind;
    status?: "active" | "history";
    page?: number;
    timezone?: string;
  } = {}
): Promise<AdminDailyVotePage> {
  const now = new Date();
  const config = await getDailyVoteConfig(env);
  const nowIso = now.toISOString();
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (options.kind) { clauses.push("kind = ?"); binds.push(options.kind); }
  if (options.date) {
    if (!options.timezone) throw new Error("timezone is required for a date filter");
    const range = localDailyDateRange(options.date, options.timezone);
    clauses.push("start_at < ? AND end_at > ?");
    binds.push(range.endAt, range.startAt);
  }
  if (options.status === "active") clauses.push("end_at > ?");
  if (options.status === "history") clauses.push("end_at <= ?");
  const where = (extra: string[] = []) => {
    const all = [...clauses, ...extra];
    return all.length ? `WHERE ${all.join(" AND ")}` : "";
  };
  const requestedPage = Number.isFinite(options.page)
    ? Math.trunc(options.page ?? 1)
    : 1;
  const pageSize = 10;
  let page: number;
  let total: number;
  let items: DailyVoteItem[];
  if (options.date || options.status) {
    const dateWhere = where();
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM daily_vote_items ${dateWhere}`
    ).bind(
      ...binds,
      ...(options.status ? [nowIso] : [])
    ).first<{ total: number }>();
    total = Number(count?.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(pages, Math.max(1, requestedPage));
    const result = await env.DB.prepare(
      `SELECT * FROM daily_vote_items ${dateWhere}
       ORDER BY start_at DESC, created_at DESC LIMIT ? OFFSET ?`
    ).bind(
      ...binds,
      ...(options.status ? [nowIso] : []),
      pageSize,
      (page - 1) * pageSize
    ).all<DailyVoteRow>();
    items = result.results.map(itemFromRow);
  } else {
    const unfinishedWhere = where(["end_at > ?"]);
    const finishedWhere = where(["end_at <= ?"]);
    const count = await env.DB.prepare(
      `WITH recent_finished AS (
         SELECT id FROM daily_vote_items ${finishedWhere}
         ORDER BY start_at DESC, created_at DESC LIMIT 10
       )
       SELECT COUNT(*) AS total FROM (
         SELECT id FROM daily_vote_items ${unfinishedWhere}
         UNION ALL
         SELECT id FROM recent_finished
       ) selected`
    ).bind(...binds, nowIso, ...binds, nowIso).first<{ total: number }>();
    total = Number(count?.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(pages, Math.max(1, requestedPage));
    const result = await env.DB.prepare(
      `WITH recent_finished AS (
         SELECT * FROM daily_vote_items ${finishedWhere}
         ORDER BY start_at DESC, created_at DESC LIMIT 10
       ), selected AS (
         SELECT * FROM daily_vote_items ${unfinishedWhere}
         UNION ALL
         SELECT * FROM recent_finished
       )
       SELECT * FROM selected
       ORDER BY start_at DESC, created_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, nowIso, ...binds, nowIso, pageSize, (page - 1) * pageSize)
      .all<DailyVoteRow>();
    items = result.results.map(itemFromRow);
  }
  const enriched = await Promise.all(items.map(async (item) => {
    const rows = await env.DB.prepare(
      `SELECT r.*, c.code_encrypted FROM daily_vote_responses r
       LEFT JOIN identity_codes c ON c.id = r.identity_code_id
       WHERE r.item_id = ? ORDER BY r.updated_at DESC`
    ).bind(item.id).all<DailyVoteResponseRow>();
    const responses = await Promise.all(rows.results.map(async (row) => ({
      id: row.id,
      identityCode: row.code_encrypted
        ? await decryptSecret(env, "identity-code-value", row.code_encrypted).catch(() => "—")
        : "—",
      playerName: row.player_name?.trim() || "—",
      selections: parseJson<unknown[]>(row.selections_json, []).filter((value): value is string => typeof value === "string"),
      submittedAt: row.updated_at
    })));
    return {
      ...item,
      responses,
      winners: await winnerRows(env, item.id)
    };
  }));
  return { page, total, config, items: enriched };
}
