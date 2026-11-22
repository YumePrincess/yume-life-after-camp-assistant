UPDATE settings
SET
  value = json_set(
    json_remove(value, '$.tasks.member_sync'),
    '$.tasks.tech_switch.enabled', json('false'),
    '$.tasks.tech_switch.time', '02:00',
    '$.tasks.contribution_sync.enabled', json('false'),
    '$.tasks.contribution_sync.time', '02:30',
    '$.tasks.inactivity_sync.enabled', json('false'),
    '$.tasks.inactivity_sync.time', '02:50',
    '$.tasks.member_profile_sync.enabled', json('false'),
    '$.tasks.member_profile_sync.time', '03:10',
    '$.routines', json('[]')
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config';
