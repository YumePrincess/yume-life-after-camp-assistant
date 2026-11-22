PRAGMA foreign_keys = ON;

ALTER TABLE daily_vote_items
ADD COLUMN batch_number TEXT NOT NULL DEFAULT '0'
CHECK(length(batch_number) BETWEEN 1 AND 8 AND batch_number NOT GLOB '*[^0-9]*');

ALTER TABLE daily_draw_winners
ADD COLUMN identity_code_id TEXT NOT NULL DEFAULT '';

ALTER TABLE daily_draw_winners
ADD COLUMN batch_number TEXT NOT NULL DEFAULT '0'
CHECK(length(batch_number) BETWEEN 1 AND 8 AND batch_number NOT GLOB '*[^0-9]*');

UPDATE daily_draw_winners
SET identity_code_id = (
  SELECT response.identity_code_id
  FROM daily_vote_responses response
  WHERE response.id = daily_draw_winners.response_id
);

UPDATE daily_draw_winners
SET batch_number = (
  SELECT item.batch_number
  FROM daily_vote_items item
  WHERE item.id = daily_draw_winners.item_id
);

CREATE INDEX IF NOT EXISTS idx_daily_vote_items_batch_window
ON daily_vote_items(batch_number, end_at DESC, start_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_draw_winners_batch_identity
ON daily_draw_winners(batch_number, identity_code_id)
WHERE batch_number <> '0';
