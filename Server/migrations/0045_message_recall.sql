-- Recall keeps the original body and attachment for administrator records.
ALTER TABLE messages ADD COLUMN recalled_at TEXT;
CREATE TRIGGER record_message_recalled_event
AFTER UPDATE OF recalled_at ON messages
WHEN OLD.recalled_at IS NULL AND NEW.recalled_at IS NOT NULL
BEGIN
  INSERT INTO message_events(channel_id,message_id,event_type) VALUES(NEW.channel_id,NEW.id,'created');
  DELETE FROM channel_pins WHERE message_id=NEW.id;
END;
