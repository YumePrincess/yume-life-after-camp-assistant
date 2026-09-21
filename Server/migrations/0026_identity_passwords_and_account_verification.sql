PRAGMA foreign_keys = ON;

ALTER TABLE identity_codes ADD COLUMN password_hash TEXT;
ALTER TABLE identity_codes ADD COLUMN password_set_at TEXT;
ALTER TABLE identity_codes ADD COLUMN password_updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_identity_codes_password_state
ON identity_codes(password_hash, status);

CREATE TABLE IF NOT EXISTS identity_verification_challenges (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  identity_code_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('password_reset', 'email_change')),
  channel TEXT NOT NULL CHECK(channel IN ('primary', 'old_email', 'new_email')),
  code_hash TEXT NOT NULL,
  reset_token_hash TEXT,
  new_email TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(identity_code_id) REFERENCES identity_codes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_identity_verification_group
ON identity_verification_challenges(group_id, purpose, channel);

CREATE INDEX IF NOT EXISTS idx_identity_verification_expiry
ON identity_verification_challenges(expires_at, consumed_at);

-- The old public test code was never a real account. Remove rows created by
-- the test/demo path while preserving every player-created identity code.
DELETE FROM daily_draw_winners
WHERE identity_code_id IN (
  SELECT id FROM identity_codes
  WHERE created_by = 'test' OR lower(COALESCE(email, '')) = 'test@demo.com'
);
DELETE FROM daily_vote_responses
WHERE identity_code_id IN (
  SELECT id FROM identity_codes
  WHERE created_by = 'test' OR lower(COALESCE(email, '')) = 'test@demo.com'
);
DELETE FROM tech_ballots
WHERE voter_id IN (
  SELECT id FROM identity_codes
  WHERE created_by = 'test' OR lower(COALESCE(email, '')) = 'test@demo.com'
);
DELETE FROM identity_code_applications
WHERE id IN (
  SELECT application_id FROM identity_codes
  WHERE created_by = 'test' OR lower(COALESCE(email, '')) = 'test@demo.com'
);
DELETE FROM identity_codes
WHERE created_by = 'test' OR lower(COALESCE(email, '')) = 'test@demo.com';
