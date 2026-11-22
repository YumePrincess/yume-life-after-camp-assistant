-- Migrate the original Asia/Shanghai setting to its equivalent fixed offset.
-- This intentionally preserves any administrator-selected timezone that has
-- already been changed from the original default.
UPDATE settings
SET value = json_set(value, '$.timezone', 'UTC+08:00'),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'camp_config'
  AND json_extract(value, '$.timezone') = 'Asia/Shanghai';

UPDATE settings
SET value = json_set(value, '$.timezone', 'UTC+08:00'),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config'
  AND json_extract(value, '$.timezone') = 'Asia/Shanghai';
