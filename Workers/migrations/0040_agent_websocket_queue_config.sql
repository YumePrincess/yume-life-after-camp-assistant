-- Command delivery no longer uses the configurable polling intervals/windows.
-- Keep only the queue claim timeout in the normalized Agent settings object.
UPDATE settings
SET value = json_remove(
  json_set(
    value,
    '$.agent',
    json_object(
      'claimTimeoutMinutes',
      COALESCE(
        json_extract(value, '$.agent.claimTimeoutMinutes'),
        json_extract(value, '$.agentPolling.claimTimeoutMinutes'),
        45
      )
    )
  ),
  '$.agentPolling'
),
updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config';
