CREATE TABLE IF NOT EXISTS identity_profile_change_requests (
  id TEXT PRIMARY KEY,
  identity_code_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('player_name', 'email')),
  requested_player_name TEXT,
  requested_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  rejection_reason TEXT,
  FOREIGN KEY(identity_code_id) REFERENCES identity_codes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_identity_profile_change_requests_status
ON identity_profile_change_requests(status, submitted_at);

CREATE INDEX IF NOT EXISTS idx_identity_profile_change_requests_identity
ON identity_profile_change_requests(identity_code_id, status);
