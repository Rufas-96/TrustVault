-- TrustVault schema (SQLite). Applied on every start; every statement is idempotent.
-- All timestamps are milliseconds since the Unix epoch (UTC).

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,                -- random UUID, never sequential
  username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  email               TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('admin', 'owner', 'viewer')),
  password_hash       TEXT NOT NULL,                   -- scrypt$N$r$p$salt$hash
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  failed_logins       INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER,
  last_login_at       INTEGER,
  password_changed_at INTEGER NOT NULL,
  created_at          INTEGER NOT NULL
);

-- Server-side sessions. The cookie holds a random token; only its SHA-256 is stored,
-- so a copy of the database cannot be replayed as a login.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,                       -- non-secret handle shown on the Account page
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,                    -- random UUID
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,                             -- set = in the owner's trash
  deleted_by      TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);

-- Every uploaded file. The bytes live encrypted on disk under storage_key (random, not derived
-- from anything a user controls). The ciphertext is bound to this row's id (GCM associated data),
-- so swapping blobs between documents makes decryption fail instead of serving the wrong file.
CREATE TABLE IF NOT EXISTS document_versions (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  extension     TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,                         -- of the plaintext, re-checked on download
  storage_key   TEXT NOT NULL UNIQUE,
  uploaded_by   TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  UNIQUE (document_id, version)
);

-- Per-document grants to named people. No folders, no groups, no inheritance.
-- Revoking deletes the row; every request re-reads this table, so revocation is immediate.
CREATE TABLE IF NOT EXISTS permissions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  level       TEXT NOT NULL CHECK (level IN ('read', 'edit')),
  granted_by  TEXT NOT NULL REFERENCES users(id),
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER,                                 -- NULL = until revoked
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_permissions_user ON permissions(user_id);

-- Sharing suggestions. Creating one never grants anything; only an owner's click does.
CREATE TABLE IF NOT EXISTS share_suggestions (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  score       INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT REFERENCES users(id),
  UNIQUE (document_id, user_id)
);

-- Append-only, hash-chained audit trail. No foreign keys on purpose: purging a document or
-- user must never cascade into the evidence.
CREATE TABLE IF NOT EXISTS audit_log (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  actor_id       TEXT,
  actor_username TEXT,
  action         TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  document_id    TEXT,
  target_user_id TEXT,
  details        TEXT NOT NULL DEFAULT '{}',
  ip             TEXT,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL                         -- HMAC-SHA256(key, prev_hash + this row)
);
CREATE INDEX IF NOT EXISTS idx_audit_document ON audit_log(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
