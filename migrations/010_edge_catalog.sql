CREATE TABLE edge_agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
  software_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at INTEGER,
  last_complete_scan_at INTEGER,
  catalog_guard_fingerprint TEXT CHECK (
    catalog_guard_fingerprint IS NULL OR (
      length(catalog_guard_fingerprint) = 64
      AND catalog_guard_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  catalog_guard_generation INTEGER CHECK (
    catalog_guard_generation IS NULL OR catalog_guard_generation > 0
  ),
  catalog_guarded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX edge_agents_last_seen_idx ON edge_agents(last_seen_at);

CREATE TABLE edge_agent_tokens (
  id_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES edge_agents(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX edge_agent_tokens_agent_idx
  ON edge_agent_tokens(agent_id, revoked_at, expires_at);

CREATE TABLE edge_catalog_scans (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES edge_agents(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('collecting', 'committed', 'aborted')),
  expected_page_count INTEGER CHECK (
    expected_page_count IS NULL OR expected_page_count >= 0
  ),
  received_page_count INTEGER NOT NULL DEFAULT 0 CHECK (received_page_count >= 0),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  committed_at INTEGER,
  aborted_at INTEGER,
  UNIQUE (agent_id, generation)
);

CREATE INDEX edge_catalog_scans_agent_state_idx
  ON edge_catalog_scans(agent_id, state, started_at);

-- 单独记录分页本身，才能对空页和网络重试做幂等校验。服务只在首次
-- 插入该主键时递增 received_page_count；相同页码但摘要不同必须拒绝。
CREATE TABLE edge_catalog_scan_pages (
  scan_id TEXT NOT NULL REFERENCES edge_catalog_scans(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (scan_id, page_index)
);

-- 扫描分页先写入暂存表；只有 scan-commit 才能据此把旧目录项标为缺失。
-- 因而中断或超时的全量扫描不会批量破坏上一代目录视图。
CREATE TABLE edge_catalog_scan_entries (
  scan_id TEXT NOT NULL REFERENCES edge_catalog_scans(id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  PRIMARY KEY (scan_id, local_id)
);

CREATE INDEX edge_catalog_scan_entries_page_idx
  ON edge_catalog_scan_entries(scan_id, page_index);
CREATE UNIQUE INDEX edge_catalog_scan_entries_path_idx
  ON edge_catalog_scan_entries(scan_id, relative_path);

CREATE TABLE edge_catalog_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES edge_agents(id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_state TEXT NOT NULL CHECK (source_state IN ('present', 'missing')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  missing_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent_id, local_id),
  UNIQUE (agent_id, relative_path)
);

CREATE INDEX edge_catalog_items_agent_state_path_idx
  ON edge_catalog_items(agent_id, source_state, relative_path);

CREATE TABLE edge_catalog_versions (
  id TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL REFERENCES edge_catalog_items(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
  sha256 TEXT CHECK (
    sha256 IS NULL OR (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  source_state TEXT NOT NULL CHECK (source_state IN ('present', 'missing', 'changed')),
  first_seen_at INTEGER NOT NULL,
  last_verified_at INTEGER,
  missing_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (catalog_item_id, version_number)
);

CREATE INDEX edge_catalog_versions_item_state_idx
  ON edge_catalog_versions(catalog_item_id, source_state, version_number DESC);

ALTER TABLE edge_catalog_items
  ADD COLUMN current_version_id TEXT
  REFERENCES edge_catalog_versions(id) ON DELETE SET NULL;

CREATE TABLE edge_agent_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES edge_agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('catalog_scan', 'upload', 'verify_source', 'cancel_transfer')
  ),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'leased', 'completed', 'failed', 'cancelled')
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- 重试寿命由 retry_expires_at 决定；次数上限只防止异常热循环，不能让
  -- 几次短时断网把任务永久失败。
  max_attempts INTEGER NOT NULL DEFAULT 1024 CHECK (max_attempts > 0),
  not_before INTEGER NOT NULL,
  retry_expires_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token_hash TEXT,
  progress_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX edge_agent_tasks_claim_idx
  ON edge_agent_tasks(
    agent_id, state, retry_expires_at, priority DESC, not_before, lease_until
  );
