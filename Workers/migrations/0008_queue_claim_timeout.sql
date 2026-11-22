UPDATE settings
SET
  value = json_set(
    value,
    '$.agentPolling.claimTimeoutMinutes',
    COALESCE(
      json_extract(value, '$.agentPolling.claimTimeoutMinutes'),
      45
    )
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'automation_config';
