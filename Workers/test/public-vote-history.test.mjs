import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPublicDailyVote, PUBLIC_VOTE_HISTORY_LIMIT } from "../src/daily-vote";
import { listTechnologyVoteHistory } from "../src/db";

let db, env;
const now = new Date("2026-10-18T12:00:00.000Z");
const iso = (days) => new Date(now.getTime() + days * 86400000).toISOString();
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  const root = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(root).filter(name => name.endsWith(".sql")).sort())
    db.exec(readFileSync(new URL(name, root), "utf8"));
  env = { DB: { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async all() { return { results: db.prepare(sql).all(...args) }; } };
  } } };
});
afterEach(() => db.close());

function item(id, kind, end, { start = iso(-100), created = iso(-100), reveal = 0 } = {}) {
  const content = { "zh-cn": { titleBlocks: [{ type: "text", text: id }], descriptionBlocks: [],
    options: kind === "poll" ? [{ id: "a", blocks: [{ type: "text", text: "A" }] }] : [] } };
  db.prepare(`INSERT INTO daily_vote_items(id,kind,content_json,start_at,end_at,reveal_before_seconds,max_selections,draw_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, kind, JSON.stringify(content), start, end, reveal, kind === "poll" ? 1 : null, kind === "draw" ? 1 : null, created, created);
}

describe("public voting history record limits", () => {
  it("returns ten polls and ten draws independently, including records older than fourteen days", async () => {
    for (const kind of ["poll", "draw"])
      for (let index = 0; index < 15; index++)
        item(`${kind}-${index}`, kind, iso(-30 - index));
    const result = await buildPublicDailyVote(env, "zh-cn", now);
    expect(result.history.polls.map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => `poll-${i}`));
    expect(result.history.draws.map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => `draw-${i}`));
    expect(result.items).toEqual([]);
  });

  it("orders ended records by closing time and deterministically orders equal closing times", async () => {
    item("long-poll", "poll", iso(-1));
    item("short-poll", "poll", iso(-2), { start: iso(-3) });
    item("tie-old", "draw", iso(-1), { created: iso(-10) });
    item("tie-new", "draw", iso(-1), { created: iso(-9) });
    const result = await buildPublicDailyVote(env, "zh-cn", now);
    expect(result.history.polls.map(row => row.id)).toEqual(["long-poll", "short-poll"]);
    expect(result.history.draws.map(row => row.id)).toEqual(["tie-new", "tie-old"]);
  });

  it("does not cap current items or include hidden future items in either history", async () => {
    for (let i = 0; i < 12; i++) item(`active-${i}`, "poll", iso(1));
    item("not-revealed", "draw", iso(3), { start: iso(2) });
    item("just-ended", "poll", now.toISOString());
    const result = await buildPublicDailyVote(env, "zh-cn", now);
    expect(result.items).toHaveLength(12);
    expect(result.items.every(row => row.isOpen)).toBe(true);
    expect(result.history.polls.map(row => row.id)).toEqual(["just-ended"]);
    expect(result.history.draws).toEqual([]);
  });

  it("limits public technology history to ten while retaining the full administrator list", async () => {
    const insert = db.prepare(`INSERT INTO technology_vote_history(poll_date,finalized_at,ballot_count,options_json,projected_plan_json,fixed_technologies_json,deleted_at)
      VALUES(?,?,0,'[]','{}','[]',?)`);
    for (let i = 0; i < 15; i++) insert.run(iso(-30 - i).slice(0, 10), iso(-30 - i), null);
    insert.run(iso(-1).slice(0, 10), iso(-1), now.toISOString());
    const limited = await listTechnologyVoteHistory(env, PUBLIC_VOTE_HISTORY_LIMIT);
    expect(limited.map(row => row.pollDate)).toEqual(Array.from({ length: 10 }, (_, i) => iso(-30 - i).slice(0, 10)));
    expect(await listTechnologyVoteHistory(env)).toHaveLength(15);
  });
});
