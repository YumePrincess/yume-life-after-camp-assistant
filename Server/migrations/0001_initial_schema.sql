PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  auth_method TEXT NOT NULL DEFAULT 'oidc',
  permissions_json TEXT NOT NULL DEFAULT '["*"]',
  oidc_id_token TEXT,
  oidc_last_checked_at TEXT,
  temp_key_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS temporary_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_temporary_keys_expires
ON temporary_keys(expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  profession TEXT,
  manor_level INTEGER,
  roommate_name TEXT,
  camp_title TEXT,
  weekly_contribution INTEGER NOT NULL DEFAULT 0,
  technology_points_used INTEGER NOT NULL DEFAULT 0,
  material_contribution INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  source_run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_members_weekly_contribution
ON members(weekly_contribution DESC, name ASC);

CREATE TABLE IF NOT EXISTS member_snapshots (
  id TEXT PRIMARY KEY,
  member_id TEXT,
  member_name TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  profession TEXT,
  manor_level INTEGER,
  roommate_name TEXT,
  camp_title TEXT,
  weekly_contribution INTEGER NOT NULL DEFAULT 0,
  technology_points_used INTEGER NOT NULL DEFAULT 0,
  material_contribution INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL,
  source_run_id TEXT,
  FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_member_snapshots_date
ON member_snapshots(snapshot_date, member_name);

CREATE TABLE IF NOT EXISTS staff_assignments (
  role_key TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  member_id TEXT,
  member_name TEXT,
  updated_at TEXT NOT NULL,
  source_run_id TEXT,
  FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tech_ballots (
  id TEXT PRIMARY KEY,
  poll_date TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  voter_name TEXT,
  selections_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(poll_date, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_tech_ballots_poll_date
ON tech_ballots(poll_date);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  schedule_key TEXT,
  trigger_mode TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT,
  current_step TEXT,
  progress REAL NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  local_date TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_schedule_key
ON task_runs(schedule_key)
WHERE schedule_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_runs_recent
ON task_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  level TEXT NOT NULL,
  step TEXT,
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES task_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_events_run
ON task_events(run_id, id DESC);

CREATE TABLE IF NOT EXISTS command_queue (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  message TEXT,
  FOREIGN KEY(run_id) REFERENCES task_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_command_queue_claim
ON command_queue(agent_id, state, priority DESC, available_at, created_at);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  agent_id TEXT PRIMARY KEY,
  active_run_id TEXT,
  active_task_key TEXT,
  status TEXT NOT NULL,
  capabilities_json TEXT,
  detail_json TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
(
  'camp_config',
  '{"timezone":"Asia/Shanghai","gameResetTime":"03:00","voteWindowStart":"06:30","voteWindowEnd":"24:00","currentCampType":"military","agentId":"mumu-main","publicSiteName":"明日之后“愿”营地助手","campName":"愿","serverName":"中国大陆服务器","publicMembersEnabled":true,"inactivityWarningDays":1,"automaticKickEnabled":false,"automaticKickGraceDays":0}',
  CURRENT_TIMESTAMP
),
(
  'auth_config',
  '{"temporaryKeyLoginEnabled":false}',
  CURRENT_TIMESTAMP
),
(
  'public_overview',
  '{"announcement":"欢迎来到营地助手。","highlights":["科技投票会在下一次科技切换任务执行前锁定。","成员贡献、职业、庄园等级与公职信息由每日同步任务更新。"]}',
  CURRENT_TIMESTAMP
),
(
  'technology_config',
  '{"catalog":[],"fixedByWeekday":{"1":[],"2":[],"3":[],"4":[],"5":[],"6":[],"7":[]},"limits":{"core":6,"general":6}}',
  CURRENT_TIMESTAMP
),
(
  'automation_config',
  '{"timezone":"Asia/Shanghai","schedulerGraceMinutes":5,"agentPolling":{"activeSeconds":2,"idleSeconds":300,"windows":[{"id":"early","name":"凌晨任务窗口","start":"01:45","end":"03:10","seconds":5,"weekdays":[1,2,3,4,5,6,7]},{"id":"evening","name":"晚间任务窗口","start":"19:00","end":"21:35","seconds":5,"weekdays":[1,2,3,4,5,6,7]}]},"gameWatchdog":{"enabled":true,"healthCheckSeconds":10,"actionTimeoutSeconds":45,"frozenScreenSeconds":90,"maxRestarts":2,"restartCooldownSeconds":8},"tasks":{"tech_switch":{"enabled":true,"time":"02:00"},"member_sync":{"enabled":true,"time":"02:30"},"contribution_sync":{"enabled":false,"time":"02:30"},"inactivity_sync":{"enabled":false,"time":"02:30"},"member_profile_sync":{"enabled":false,"time":"02:30"},"patrol":{"enabled":true,"time":"19:20","teamReadyTime":"19:30","shareIntervalMinutes":10,"chatPollSeconds":5,"deadline":"21:25"}},"routines":[]}',
  CURRENT_TIMESTAMP
);
