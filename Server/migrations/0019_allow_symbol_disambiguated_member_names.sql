PRAGMA foreign_keys = OFF;

CREATE TABLE members_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profession TEXT,
  manor_level INTEGER,
  roommate_name TEXT,
  camp_title TEXT,
  weekly_contribution INTEGER NOT NULL DEFAULT 0,
  technology_points_used INTEGER NOT NULL DEFAULT 0,
  material_contribution INTEGER NOT NULL DEFAULT 0,
  last_active_text TEXT,
  inactive_days INTEGER,
  activity_captured_at TEXT,
  last_seen_at TEXT NOT NULL,
  source_run_id TEXT
);

INSERT INTO members_new(
  id, name, profession, manor_level, roommate_name, camp_title,
  weekly_contribution, technology_points_used, material_contribution,
  last_active_text, inactive_days, activity_captured_at,
  last_seen_at, source_run_id
)
SELECT
  id, name, profession, manor_level, roommate_name, camp_title,
  weekly_contribution, technology_points_used, material_contribution,
  last_active_text, inactive_days, activity_captured_at,
  last_seen_at, source_run_id
FROM members;

DROP TABLE members;
ALTER TABLE members_new RENAME TO members;

CREATE INDEX IF NOT EXISTS idx_members_weekly_contribution
ON members(weekly_contribution DESC, name ASC);

CREATE INDEX IF NOT EXISTS idx_members_inactive_days
ON members(inactive_days DESC, name ASC);

PRAGMA foreign_keys = ON;
