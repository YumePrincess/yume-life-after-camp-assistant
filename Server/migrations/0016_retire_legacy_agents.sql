UPDATE settings
SET value = json_set(value, '$.agentId', 'mac-life-after-agent'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'camp_config'
  AND json_extract(value, '$.agentId') IN ('mumu-main', 'main-mumu');

UPDATE command_queue
SET agent_id = 'mac-life-after-agent'
WHERE agent_id IN ('mumu-main', 'main-mumu')
  AND state = 'queued';

DELETE FROM agent_heartbeats
WHERE agent_id IN ('mumu-main', 'main-mumu');
