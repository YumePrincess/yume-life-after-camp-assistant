PRAGMA foreign_keys = ON;

ALTER TABLE members
ADD COLUMN identity_code_id TEXT REFERENCES identity_codes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_members_identity_code
ON members(identity_code_id);
