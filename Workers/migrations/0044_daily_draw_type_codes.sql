ALTER TABLE daily_vote_items
ADD COLUMN draw_type_code TEXT NOT NULL DEFAULT '0'
CHECK(length(draw_type_code) BETWEEN 1 AND 8 AND draw_type_code NOT GLOB '*[^0-9]*');

CREATE INDEX IF NOT EXISTS idx_daily_vote_items_draw_type_previous
ON daily_vote_items(draw_type_code, end_at DESC, start_at DESC, created_at DESC, id DESC)
WHERE kind = 'draw' AND draw_type_code <> '0';
