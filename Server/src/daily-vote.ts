import { decryptSecret } from "./crypto";
import { normalizeLocale, type SupportedLocale } from "./locale";

export type DailyVoteKind = "poll" | "draw";

export type DailyVoteBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string };

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

const LOCALES: SupportedLocale[] = ["zh-cn", "zh-tw", "en", "fr", "ja"];
const MAX_CONTENT_BYTES = 240_000;

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

function isoDateTime(value: unknown, field: string): string {
  const result = text(value, field, 40);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be an ISO date-time`);
  return parsed.toISOString();
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
    if (source.type === "image") {
      const url = text(source.url, `${field}[${index}].url`, 2_000);
      try {
        if (new URL(url).protocol !== "https:") throw new Error();
      } catch {
        throw new Error(`${field}[${index}].url must be an HTTPS URL`);
      }
      const alt = optionalText(source.alt, `${field}[${index}].alt`, 160);
      return { type: "image", url, ...(alt ? { alt } : {}) };
    }
    throw new Error(`${field}[${index}].type must be text or image`);
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
  existing?: DailyVoteItem
): {
  kind: DailyVoteKind;
  localizedContent: DailyVoteLocalizedContent;
  startAt: string;
  endAt: string;
  revealBeforeSeconds: number;
  maxSelections: number | null;
  drawCount: number | null;
} {
  const source = object(value, "dailyVote");
  const kind = source.kind === "draw" ? "draw" : source.kind === "poll" ? "poll" : null;
  if (!kind) throw new Error("kind must be poll or draw");
  const localizedContent = normalizeLocalizedContent(
    source.localizedContent ?? source.content,
    kind
  );
  const startAt = isoDateTime(source.startAt, "startAt");
  const endAt = isoDateTime(source.endAt, "endAt");
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
    drawCount
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
    `SELECT r.id, r.item_id, r.identity_code_id, r.player_name,
            r.selections_json, r.created_at, r.updated_at
     FROM daily_vote_responses r
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
    `SELECT w.rank, r.player_name, c.code_encrypted
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

export async function saveDailyVoteItem(
  env: Env,
  input: ReturnType<typeof normalizeDailyVoteInput>,
  id = crypto.randomUUID()
): Promise<DailyVoteItem> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO daily_vote_items(
       id, kind, content_json, start_at, end_at, reveal_before_seconds,
       max_selections, draw_count, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, input.kind, JSON.stringify(input.localizedContent), input.startAt, input.endAt,
    input.revealBeforeSeconds, input.maxSelections, input.drawCount, now, now
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
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE daily_vote_items SET kind = ?, content_json = ?, start_at = ?, end_at = ?,
       reveal_before_seconds = ?, max_selections = ?, draw_count = ?, updated_at = ?
     WHERE id = ?`
  ).bind(
    input.kind, JSON.stringify(input.localizedContent), input.startAt, input.endAt,
    input.revealBeforeSeconds, input.maxSelections, input.drawCount, now, id
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
  date?: string
): Promise<number> {
  const now = new Date().toISOString();
  const statement = date
    ? env.DB.prepare(
        `DELETE FROM daily_vote_items
         WHERE end_at <= ?
           AND (substr(start_at, 1, 10) = ? OR substr(end_at, 1, 10) = ?)`
      ).bind(now, date, date)
    : env.DB.prepare("DELETE FROM daily_vote_items WHERE end_at <= ?").bind(now);
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

export async function finalizeEndedDraws(env: Env, now = new Date()): Promise<void> {
  const ended = await listItems(env, "WHERE kind = 'draw' AND end_at <= ?", [now.toISOString()]);
  for (const item of ended) {
    const existing = await env.DB.prepare("SELECT 1 AS found FROM daily_draw_winners WHERE item_id = ? LIMIT 1")
      .bind(item.id).first<{ found: number }>();
    if (existing) continue;
    const responses = await responseRows(env, item.id);
    const shuffled = responses.slice();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      const target = random[0]! % (index + 1);
      [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
    }
    const selected = shuffled.slice(0, Math.min(item.drawCount ?? 0, shuffled.length));
    if (!selected.length) continue;
    const selectedAt = now.toISOString();
    await env.DB.batch(selected.map((row, index) => env.DB.prepare(
      `INSERT OR IGNORE INTO daily_draw_winners(id, item_id, response_id, rank, selected_at)
       VALUES(?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), item.id, row.id, index + 1, selectedAt)));
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
  await finalizeEndedDraws(env, now);
  const all = await listItems(env);
  const active = all.filter((item) => {
    const end = new Date(item.endAt).getTime();
    const reveal = new Date(item.startAt).getTime() - item.revealBeforeSeconds * 1000;
    return end > now.getTime() && reveal <= now.getTime();
  });
  const historyStart = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  const historyItems = all.filter((item) => {
    const end = new Date(item.endAt).getTime();
    return end <= now.getTime() && end >= historyStart;
  });
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
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO daily_vote_responses(
       id, item_id, identity_code_id, player_name, selections_json, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, identity_code_id) DO UPDATE SET
       player_name = excluded.player_name, selections_json = excluded.selections_json,
       updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(), input.itemId, input.identityCodeId, input.playerName || null,
    JSON.stringify(input.selections), now, now
  ).run();
}

export async function listAdminDailyVoteItems(
  env: Env,
  options: { date?: string; kind?: DailyVoteKind; limit?: number } = {}
): Promise<AdminDailyVoteItem[]> {
  await finalizeEndedDraws(env);
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (options.kind) { clauses.push("kind = ?"); binds.push(options.kind); }
  if (options.date) {
    clauses.push("(substr(start_at, 1, 10) = ? OR substr(end_at, 1, 10) = ?)");
    binds.push(options.date, options.date);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(100, options.limit ?? (options.date ? 100 : 5)));
  const items = await listItems(env, where, binds, limit);
  return Promise.all(items.map(async (item) => {
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
}
