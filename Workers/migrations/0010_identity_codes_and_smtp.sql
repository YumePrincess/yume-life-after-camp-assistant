PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (
  'smtp_config',
  '{"enabled":false,"host":"","port":587,"secure":false,"startTls":true,"authType":"login","username":"","passwordEncrypted":"","fromEmail":"","fromName":"明日之后“雨梦庭”营地助手","replyTo":""}',
  CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS identity_code_applications (
  id TEXT PRIMARY KEY,
  application_number TEXT NOT NULL UNIQUE,
  request_type TEXT NOT NULL DEFAULT 'new'
    CHECK(request_type IN ('new', 'renewal')),
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

CREATE INDEX IF NOT EXISTS idx_identity_applications_review
ON identity_code_applications(status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS identity_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_encrypted TEXT NOT NULL,
  player_name TEXT,
  email TEXT,
  locale TEXT NOT NULL DEFAULT 'zh-cn',
  application_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'disabled')),
  expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  renewal_grace_vote_used_at TEXT,
  last_emailed_at TEXT,
  last_email_error TEXT,
  FOREIGN KEY(application_id) REFERENCES identity_code_applications(id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_codes_status_expiry
ON identity_codes(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_identity_codes_player
ON identity_codes(player_name, email);

CREATE TABLE IF NOT EXISTS public_rate_limits (
  identifier_hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_rate_limits_cleanup
ON public_rate_limits(updated_at);
