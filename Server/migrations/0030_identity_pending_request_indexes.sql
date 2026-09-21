CREATE INDEX IF NOT EXISTS idx_identity_applications_identity_status
ON identity_code_applications(identity_code_id, status);

CREATE INDEX IF NOT EXISTS idx_identity_verification_identity_state
ON identity_verification_challenges(identity_code_id, purpose, expires_at, consumed_at);
