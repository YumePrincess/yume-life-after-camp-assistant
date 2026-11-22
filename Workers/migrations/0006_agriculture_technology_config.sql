UPDATE settings
SET
  value = json_set(value, '$.fixedByDate', json('{}')),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'technology_config'
  AND json_type(value, '$.fixedByDate') IS NULL;

UPDATE settings
SET
  value = json_set(value, '$.currentCampType', 'agriculture'),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'camp_config';

UPDATE settings
SET
  value = json_remove(value, '$.tasks.tech_catalog_sync'),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config'
  AND json_type(value, '$.tasks.tech_catalog_sync') IS NOT NULL;

UPDATE settings
SET
  value = json_set(
    value,
    '$.agentPolling.windows',
    COALESCE(
      (
        SELECT json_group_array(json(window.value))
        FROM json_each(settings.value, '$.agentPolling.windows') AS window
        WHERE json_extract(window.value, '$.id') <> 'catalog'
      ),
      json('[]')
    )
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config'
  AND EXISTS (
    SELECT 1
    FROM json_each(settings.value, '$.agentPolling.windows') AS window
    WHERE json_extract(window.value, '$.id') = 'catalog'
  );
