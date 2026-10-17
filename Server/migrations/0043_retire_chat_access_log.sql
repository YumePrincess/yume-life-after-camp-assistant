-- Keep 0042 immutable for installations that already applied it.
-- Access logging has been removed from the UI and API. Retire only that table;
-- identity codes, sessions, conversations, messages, files, and settings are retained.
-- IF EXISTS also supports databases installed from the short-lived 0042 revision
-- that omitted this table. Do not replay 0042 or edit d1_migrations.
DROP TABLE IF EXISTS chat_admin_audit;
