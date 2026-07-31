CREATE TABLE IF NOT EXISTS technology_vote_history (
  poll_date TEXT PRIMARY KEY,
  finalized_at TEXT NOT NULL,
  ballot_count INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL,
  projected_plan_json TEXT NOT NULL,
  fixed_technologies_json TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_technology_vote_history_visible
ON technology_vote_history(deleted_at, poll_date DESC);
