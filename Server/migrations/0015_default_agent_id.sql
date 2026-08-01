-- Migrate only the historical built-in Agent ID. Administrator-defined IDs
-- are deliberately left untouched.
UPDATE settings
SET value = json_set(value, '$.agentId', 'mac-life-after-agent'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'camp_config'
  AND json_extract(value, '$.agentId') = 'mumu-main';
