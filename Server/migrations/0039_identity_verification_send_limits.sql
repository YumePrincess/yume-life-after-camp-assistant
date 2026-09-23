CREATE TABLE IF NOT EXISTS identity_verification_send_events (
  id TEXT PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_verification_send_events_subject_time
ON identity_verification_send_events(subject_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_identity_verification_send_events_cleanup
ON identity_verification_send_events(created_at);
