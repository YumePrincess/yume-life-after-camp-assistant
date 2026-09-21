-- Normalize legacy automatic-task schedules to an explicit every-day policy.
-- Technology switching and patrol are intentionally daily-only tasks.
UPDATE settings
SET value = json_set(
  value,
  '$.tasks.tech_switch.weekdays', json('[1,2,3,4,5,6,7]'),
  '$.tasks.contribution_sync.weekdays', json('[1,2,3,4,5,6,7]'),
  '$.tasks.inactivity_sync.weekdays', json('[1,2,3,4,5,6,7]'),
  '$.tasks.member_profile_sync.weekdays', json('[1,2,3,4,5,6,7]'),
  '$.tasks.patrol.weekdays', json('[1,2,3,4,5,6,7]')
),
updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config';
