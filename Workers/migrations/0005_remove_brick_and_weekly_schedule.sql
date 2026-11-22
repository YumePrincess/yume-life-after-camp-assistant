UPDATE settings
SET
  value = json_remove(
    value,
    '$.tasks.brick_transport',
    '$.tasks.weekly_schedule_update'
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config';

DELETE FROM settings
WHERE key = 'weekly_schedule';
