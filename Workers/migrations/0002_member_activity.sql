ALTER TABLE members ADD COLUMN last_active_text TEXT;
ALTER TABLE members ADD COLUMN inactive_days INTEGER;
ALTER TABLE members ADD COLUMN activity_captured_at TEXT;

ALTER TABLE member_snapshots ADD COLUMN last_active_text TEXT;
ALTER TABLE member_snapshots ADD COLUMN inactive_days INTEGER;

CREATE INDEX IF NOT EXISTS idx_members_inactive_days
ON members(inactive_days DESC, name ASC);
