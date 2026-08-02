ALTER TABLE agent_heartbeats ADD COLUMN display_name TEXT;
ALTER TABLE agent_heartbeats ADD COLUMN first_seen_at TEXT;

UPDATE agent_heartbeats
SET display_name = agent_id,
    first_seen_at = updated_at
WHERE display_name IS NULL OR first_seen_at IS NULL;

-- A clean deployment has no registered device yet. Keep an existing selected
-- device during upgrades, but let the first future heartbeat become active on
-- a new database instead of routing commands to a placeholder identity.
UPDATE settings
SET value = json_set(value, '$.agentId', ''),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'camp_config'
  AND NOT EXISTS (
    SELECT 1 FROM agent_heartbeats
    WHERE agent_id = json_extract(settings.value, '$.agentId')
  );
