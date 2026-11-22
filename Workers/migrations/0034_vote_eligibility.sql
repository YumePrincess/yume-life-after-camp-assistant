PRAGMA foreign_keys = ON;

ALTER TABLE daily_vote_items
ADD COLUMN eligibility_check_enabled INTEGER NOT NULL DEFAULT 1 CHECK(eligibility_check_enabled IN (0, 1));

INSERT OR IGNORE INTO settings(key, value, updated_at)
VALUES(
  'daily_vote_config',
  '{"drawMaxWins28Days":4,"voteEligibilityEnabled":true,"voteEligibility":{"weeklyContribution":1500,"technologyPoints":0,"materialContribution":50000,"weeklyActivityPoints":25}}',
  '1970-01-01T00:00:00.000Z'
);
