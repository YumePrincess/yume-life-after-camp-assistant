ALTER TABLE members ADD COLUMN weekly_activity_points INTEGER NOT NULL DEFAULT 0;

-- This new automatic schedule starts disabled; admins can enable it after setup.
UPDATE settings
SET value = json_set(
  value,
  '$.tasks.weekly_activity_sync',
  json('{"enabled":false,"time":"22:00","times":["22:00"],"weekdays":[7]}')
),
updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config'
  AND json_extract(value, '$.tasks.weekly_activity_sync') IS NULL;
