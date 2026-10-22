-- Multipart ciphertext is never published until all parts and metadata are committed.
CREATE TABLE chat_upload_sessions (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completing','completed')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_upload_sessions_expiry ON chat_upload_sessions(expires_at);
CREATE INDEX idx_chat_upload_sessions_owner ON chat_upload_sessions(owner_user_id, status);
CREATE TABLE chat_upload_parts (
  upload_id TEXT NOT NULL REFERENCES chat_upload_sessions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY(upload_id, part_number)
);
CREATE TABLE chat_file_chunks (
  object_key TEXT PRIMARY KEY REFERENCES uploaded_files(object_key) ON DELETE CASCADE,
  chunk_size INTEGER NOT NULL,
  key_id TEXT NOT NULL
);
