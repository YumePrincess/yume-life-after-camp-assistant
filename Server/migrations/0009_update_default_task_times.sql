UPDATE settings
SET
  value = json_set(
    value,
    '$.tasks.tech_switch.time',
      COALESCE(json_extract(value, '$.tasks.tech_switch.time'), '02:00'),
    '$.tasks.member_profile_sync.time',
      CASE
        WHEN json_extract(value, '$.tasks.member_profile_sync.time') IS NULL
          OR json_extract(value, '$.tasks.member_profile_sync.time') = '03:10'
        THEN '02:15'
        ELSE json_extract(value, '$.tasks.member_profile_sync.time')
      END,
    '$.tasks.contribution_sync.time',
      COALESCE(json_extract(value, '$.tasks.contribution_sync.time'), '02:30'),
    '$.tasks.inactivity_sync.time',
      CASE
        WHEN json_extract(value, '$.tasks.inactivity_sync.time') IS NULL
          OR json_extract(value, '$.tasks.inactivity_sync.time') = '02:50'
        THEN '02:45'
        ELSE json_extract(value, '$.tasks.inactivity_sync.time')
      END
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config';
