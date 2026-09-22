ALTER TABLE identity_codes
ADD COLUMN vote_permission_disabled INTEGER NOT NULL DEFAULT 0
CHECK(vote_permission_disabled IN (0, 1));
