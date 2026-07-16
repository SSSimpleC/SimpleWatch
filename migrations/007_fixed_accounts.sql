CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username_folded TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('host', 'viewer')),
  password_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);

CREATE TABLE account_sessions (
  id_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  device_id TEXT NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX account_sessions_account_idx ON account_sessions(account_id);
CREATE INDEX account_sessions_expiry_idx
  ON account_sessions(idle_expires_at, absolute_expires_at);

CREATE TABLE auth_rate_limits (
  key_hash TEXT NOT NULL,
  window_seconds INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (key_hash, window_seconds)
);

CREATE TABLE room_wait_queue (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES account_sessions(id_hash) ON DELETE CASCADE,
  queued_at INTEGER NOT NULL,
  suppressed_room_id TEXT REFERENCES rooms(id)
);
CREATE INDEX room_wait_queue_order_idx ON room_wait_queue(queued_at, account_id);

CREATE TABLE room_device_leases (
  member_id TEXT PRIMARY KEY REFERENCES room_members(member_id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES account_sessions(id_hash) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);

ALTER TABLE room_members ADD COLUMN account_id TEXT REFERENCES accounts(id);
CREATE UNIQUE INDEX room_members_active_account_idx
  ON room_members(room_id, account_id)
  WHERE account_id IS NOT NULL AND left_at IS NULL AND kicked_at IS NULL;

-- 统一账户上线时，所有旧口令、邀请链接和房间 Cookie 必须失效。
UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, unixepoch('now') * 1000);
UPDATE room_sessions SET revoked_at = COALESCE(revoked_at, unixepoch('now') * 1000);
