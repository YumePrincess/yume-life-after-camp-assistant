ALTER TABLE identity_codes
ADD COLUMN vote_eligibility_bypass INTEGER NOT NULL DEFAULT 0
CHECK(vote_eligibility_bypass IN (0, 1));
