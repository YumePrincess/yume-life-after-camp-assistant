ALTER TABLE task_events ADD COLUMN stream_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_stream_event
ON task_events(run_id, stream_event_id)
WHERE stream_event_id IS NOT NULL;
