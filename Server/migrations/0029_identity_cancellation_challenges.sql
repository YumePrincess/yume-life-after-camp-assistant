CREATE TABLE IF NOT EXISTS identity_cancellation_challenges (
  id TEXT PRIMARY KEY,
  identity_code_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(identity_code_id) REFERENCES identity_codes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_identity_cancellation_challenges_expiry
ON identity_cancellation_challenges(expires_at, consumed_at);
