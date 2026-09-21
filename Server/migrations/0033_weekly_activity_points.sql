ALTER TABLE members ADD COLUMN weekly_activity_points INTEGER NOT NULL DEFAULT 0;

-- The new task has its own weekly default: Sunday at 22:00. Existing tasks
-- were normalized to Monday-Sunday by migration 0032 and remain unchanged.
UPDATE settings
SET value = json_set(
  value,
  '$.tasks.weekly_activity_sync',
  json('{"enabled":true,"time":"22:00","times":["22:00"],"weekdays":[7]}')
),
updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config'
  AND json_extract(value, '$.tasks.weekly_activity_sync') IS NULL;
