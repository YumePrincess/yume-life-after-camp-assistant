UPDATE settings
SET
  value = json_set(value, '$.publicSiteName', '明日之后“愿”营地助手'),
  updated_at = CURRENT_TIMESTAMP
WHERE
  key = 'camp_config'
  AND json_extract(value, '$.publicSiteName') IN (
    '明日之后营地助手',
    'Yume Life After'
  );
