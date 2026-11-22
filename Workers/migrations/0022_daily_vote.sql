PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS daily_vote_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('poll', 'draw')),
  content_json TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reveal_before_seconds INTEGER NOT NULL DEFAULT 0,
  max_selections INTEGER,
  draw_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(end_at > start_at),
  CHECK((kind = 'poll' AND max_selections IS NOT NULL AND draw_count IS NULL)
     OR (kind = 'draw' AND max_selections IS NULL AND draw_count IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_daily_vote_items_window
ON daily_vote_items(end_at DESC, start_at DESC);

CREATE TABLE IF NOT EXISTS daily_vote_responses (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  identity_code_id TEXT NOT NULL,
  player_name TEXT,
  selections_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id, identity_code_id),
  FOREIGN KEY(item_id) REFERENCES daily_vote_items(id) ON DELETE CASCADE,
  FOREIGN KEY(identity_code_id) REFERENCES identity_codes(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_daily_vote_responses_item
ON daily_vote_responses(item_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS daily_draw_winners (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  selected_at TEXT NOT NULL,
  UNIQUE(item_id, response_id),
  UNIQUE(item_id, rank),
  FOREIGN KEY(item_id) REFERENCES daily_vote_items(id) ON DELETE CASCADE,
  FOREIGN KEY(response_id) REFERENCES daily_vote_responses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_draw_winners_item
ON daily_draw_winners(item_id, rank);
