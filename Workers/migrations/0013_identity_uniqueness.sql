CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_pending_email
ON identity_code_applications(lower(email))
WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_pending_player
ON identity_code_applications(player_name)
WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_active_email
ON identity_codes(lower(email))
WHERE status = 'active' AND email IS NOT NULL AND trim(email) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_active_player
ON identity_codes(player_name)
WHERE status = 'active' AND player_name IS NOT NULL AND trim(player_name) <> '';
