-- Store the reserved special daily refresh hook in the existing camp_config
-- JSON setting. No new table is needed, and existing custom settings survive.
UPDATE settings
SET
  value = json_set(
    value,
    '$.specialDailyRefreshTime',
    COALESCE(json_extract(value, '$.specialDailyRefreshTime'), '00:00')
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'camp_config';
