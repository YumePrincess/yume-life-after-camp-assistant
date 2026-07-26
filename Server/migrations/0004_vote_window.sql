UPDATE settings
SET
  value = json_set(
    value,
    '$.voteWindowStart',
    COALESCE(json_extract(value, '$.voteWindowStart'), '06:30'),
    '$.voteWindowEnd',
    COALESCE(json_extract(value, '$.voteWindowEnd'), '24:00')
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'camp_config';
