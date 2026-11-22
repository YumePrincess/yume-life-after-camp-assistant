-- Multi-time schedules live in the existing automation_config JSON setting;
-- this migration materializes the array for settings created before that
-- field was introduced. Existing arrays are preserved verbatim.
UPDATE settings
SET
  value = json_set(
    json_set(
      json_set(
        json_set(
          json_set(
            value,
            '$.tasks.tech_switch.times',
            CASE
              WHEN json_type(value, '$.tasks.tech_switch.times') = 'array'
              THEN json_extract(value, '$.tasks.tech_switch.times')
              ELSE json_array(COALESCE(json_extract(value, '$.tasks.tech_switch.time'), '02:00'))
            END
          ),
          '$.tasks.contribution_sync.times',
          CASE
            WHEN json_type(value, '$.tasks.contribution_sync.times') = 'array'
            THEN json_extract(value, '$.tasks.contribution_sync.times')
            ELSE json_array(COALESCE(json_extract(value, '$.tasks.contribution_sync.time'), '02:30'))
          END
        ),
        '$.tasks.inactivity_sync.times',
        CASE
          WHEN json_type(value, '$.tasks.inactivity_sync.times') = 'array'
          THEN json_extract(value, '$.tasks.inactivity_sync.times')
          ELSE json_array(COALESCE(json_extract(value, '$.tasks.inactivity_sync.time'), '02:45'))
        END
      ),
      '$.tasks.member_profile_sync.times',
      CASE
        WHEN json_type(value, '$.tasks.member_profile_sync.times') = 'array'
        THEN json_extract(value, '$.tasks.member_profile_sync.times')
        ELSE json_array(COALESCE(json_extract(value, '$.tasks.member_profile_sync.time'), '02:15'))
      END
    ),
    '$.tasks.patrol.times',
    CASE
      WHEN json_type(value, '$.tasks.patrol.times') = 'array'
      THEN json_extract(value, '$.tasks.patrol.times')
      ELSE json_array(COALESCE(json_extract(value, '$.tasks.patrol.time'), '19:20'))
    END
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config';
