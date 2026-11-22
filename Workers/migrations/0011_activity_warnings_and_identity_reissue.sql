PRAGMA foreign_keys = OFF;

CREATE TABLE identity_code_applications_v2 (
  id TEXT PRIMARY KEY,
  application_number TEXT NOT NULL UNIQUE,
  request_type TEXT NOT NULL DEFAULT 'new'
    CHECK(request_type IN ('new', 'renewal', 'reissue')),
  email TEXT NOT NULL,
  player_name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh-cn',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'approved', 'rejected')),
  identity_code_id TEXT,
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  rejection_reason TEXT,
  email_sent_at TEXT,
  last_email_error TEXT
);

INSERT INTO identity_code_applications_v2
SELECT
  id, application_number, request_type, email, player_name, locale, status,
  identity_code_id, submitted_at, reviewed_at, reviewed_by, rejection_reason,
  email_sent_at, last_email_error
FROM identity_code_applications;

DROP TABLE identity_code_applications;
ALTER TABLE identity_code_applications_v2 RENAME TO identity_code_applications;

CREATE INDEX idx_identity_applications_review
ON identity_code_applications(status, submitted_at DESC);

CREATE TABLE activity_warnings (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_active_text TEXT,
  inactive_days INTEGER,
  captured_at TEXT NOT NULL,
  source_run_id TEXT NOT NULL
);

CREATE INDEX idx_activity_warnings_days
ON activity_warnings(inactive_days DESC, name);

INSERT OR IGNORE INTO activity_warnings(
  name_key, name, last_active_text, inactive_days, captured_at, source_run_id
)
SELECT
  lower(replace(name, ' ', '')),
  name,
  last_active_text,
  inactive_days,
  COALESCE(activity_captured_at, last_seen_at),
  COALESCE(source_run_id, 'migration')
FROM members
WHERE last_active_text IS NOT NULL OR inactive_days IS NOT NULL;

PRAGMA foreign_keys = ON;
