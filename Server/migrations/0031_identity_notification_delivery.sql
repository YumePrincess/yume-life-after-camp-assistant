ALTER TABLE identity_profile_change_requests ADD COLUMN email_sent_at TEXT;
ALTER TABLE identity_profile_change_requests ADD COLUMN last_email_error TEXT;

ALTER TABLE identity_cancellation_challenges ADD COLUMN email_sent_at TEXT;
ALTER TABLE identity_cancellation_challenges ADD COLUMN last_email_error TEXT;
