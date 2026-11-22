CREATE TABLE IF NOT EXISTS identity_application_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('new', 'reissue')),
  email TEXT NOT NULL,
  player_name TEXT NOT NULL,
  locale TEXT NOT NULL,
  identity_code_id TEXT,
  application_id TEXT,
  code_hash TEXT NOT NULL,
  verification_token_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(identity_code_id) REFERENCES identity_codes(id) ON DELETE CASCADE,
  FOREIGN KEY(application_id) REFERENCES identity_code_applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_identity_application_challenges_lookup
ON identity_application_challenges(email, purpose, expires_at);
