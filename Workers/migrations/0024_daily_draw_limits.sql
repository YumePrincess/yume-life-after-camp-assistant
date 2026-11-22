PRAGMA foreign_keys = ON;

ALTER TABLE daily_vote_items
ADD COLUMN draw_limit_enabled INTEGER NOT NULL DEFAULT 0 CHECK(draw_limit_enabled IN (0, 1));

INSERT OR IGNORE INTO settings(key, value, updated_at)
VALUES('daily_vote_config', '{"drawMaxWins28Days":4}', '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS daily_draw_finalize_lock (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  token TEXT NOT NULL DEFAULT '',
  locked_until TEXT NOT NULL
);

INSERT OR IGNORE INTO daily_draw_finalize_lock(id, token, locked_until)
VALUES(1, '', '1970-01-01T00:00:00.000Z');
