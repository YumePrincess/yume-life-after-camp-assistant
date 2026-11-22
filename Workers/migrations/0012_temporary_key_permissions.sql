ALTER TABLE temporary_keys
ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_temporary_keys_status
ON temporary_keys(revoked_at, permanent, expires_at, created_at);
