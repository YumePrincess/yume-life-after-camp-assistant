ALTER TABLE identity_codes ADD COLUMN eligibility_override_votes INTEGER;
ALTER TABLE identity_codes ADD COLUMN eligibility_override_expires_at TEXT;

CREATE TABLE IF NOT EXISTS vote_eligibility_applications (
  id TEXT PRIMARY KEY,
  application_number TEXT NOT NULL UNIQUE,
  identity_code_id TEXT NOT NULL,
  email TEXT NOT NULL,
  player_name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh-cn',
  reason TEXT NOT NULL,
  weekly_contribution INTEGER NOT NULL DEFAULT 0,
  technology_points INTEGER NOT NULL DEFAULT 0,
  material_contribution INTEGER NOT NULL DEFAULT 0,
  weekly_activity_points INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'approved', 'rejected')),
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  rejection_reason TEXT,
  approved_votes INTEGER,
  approved_expires_at TEXT,
  email_sent_at TEXT,
  last_email_error TEXT,
  FOREIGN KEY(identity_code_id) REFERENCES identity_codes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vote_eligibility_applications_review
ON vote_eligibility_applications(status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_vote_eligibility_applications_identity
ON vote_eligibility_applications(identity_code_id, status);
