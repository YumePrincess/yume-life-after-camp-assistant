-- Move the technology fixed-preset shape out of the initial seed migration.
-- Existing legacy date and weekday rules are converted so no configured rule
-- is lost when the new preset-based scheduler starts reading the setting.
-- The missing-field guard makes this migration safe to re-run in local copies.
UPDATE settings
SET
  value = json_set(
    value,
    '$.fixedPresets',
    json(
      '[' ||
      COALESCE(
        (
          SELECT group_concat(
            json_object(
              'id', 'legacy-date-' || fixed_date.key,
              'mode', 'date',
              'date', fixed_date.key,
              'technologyKeys', json(fixed_date.value)
            )
          )
          FROM json_each(settings.value, '$.fixedByDate') AS fixed_date
          WHERE json_type(fixed_date.value) = 'array'
            AND json_array_length(fixed_date.value) > 0
        ),
        ''
      ) ||
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM json_each(settings.value, '$.fixedByDate') AS fixed_date
          WHERE json_type(fixed_date.value) = 'array'
            AND json_array_length(fixed_date.value) > 0
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(settings.value, '$.fixedByWeekday') AS fixed_weekday
          WHERE json_type(fixed_weekday.value) = 'array'
            AND json_array_length(fixed_weekday.value) > 0
        )
        THEN ','
        ELSE ''
      END ||
      COALESCE(
        (
          SELECT group_concat(
            json_object(
              'id', 'legacy-weekday-' || fixed_weekday.key,
              'mode', 'weekday',
              'startDate', '1970-01-01',
              'endDate', NULL,
              'weekdays', json('[' || fixed_weekday.key || ']'),
              'technologyKeys', json(fixed_weekday.value)
            )
          )
          FROM json_each(settings.value, '$.fixedByWeekday') AS fixed_weekday
          WHERE json_type(fixed_weekday.value) = 'array'
            AND json_array_length(fixed_weekday.value) > 0
        ),
        ''
      ) || ']'
    )
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'technology_config'
  AND json_type(value, '$.fixedPresets') IS NULL;
