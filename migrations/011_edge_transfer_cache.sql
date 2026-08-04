CREATE TABLE edge_transfer_jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES edge_agents(id) ON DELETE SET NULL,
  catalog_version_id TEXT REFERENCES edge_catalog_versions(id) ON DELETE SET NULL,
  owner_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'queued',
      'leased',
      'validating',
      'uploading',
      'received',
      'processing',
      'ready',
      'blocked_storage',
      'source_missing',
      'source_changed',
      'permission_denied',
      'cancel_requested',
      'cancelled',
      'incompatible',
      'failed',
      'evicted'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes >= 0),
  transferred_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
    transferred_bytes >= 0 AND transferred_bytes <= declared_bytes
  ),
  expected_sha256 TEXT CHECK (
    expected_sha256 IS NULL OR (
      length(expected_sha256) = 64
      AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 1024 CHECK (max_attempts > 0),
  error_code TEXT,
  error_message TEXT,
  speed_bytes_per_second REAL CHECK (
    speed_bytes_per_second IS NULL OR speed_bytes_per_second >= 0
  ),
  last_progress_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ready_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX edge_transfer_jobs_state_priority_idx
  ON edge_transfer_jobs(state, priority DESC, created_at);
CREATE INDEX edge_transfer_jobs_agent_state_idx
  ON edge_transfer_jobs(agent_id, state, updated_at);
CREATE INDEX edge_transfer_jobs_catalog_version_idx
  ON edge_transfer_jobs(catalog_version_id, created_at DESC);

ALTER TABLE uploads
  ADD COLUMN edge_job_id TEXT
  REFERENCES edge_transfer_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX uploads_edge_job_idx
  ON uploads(edge_job_id) WHERE edge_job_id IS NOT NULL;

CREATE TABLE edge_upload_credentials (
  id_hash TEXT PRIMARY KEY,
  edge_job_id TEXT NOT NULL REFERENCES edge_transfer_jobs(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES edge_agents(id) ON DELETE SET NULL,
  task_id TEXT NOT NULL REFERENCES edge_agent_tasks(id) ON DELETE CASCADE,
  task_attempt INTEGER NOT NULL CHECK (task_attempt > 0),
  upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  overlap_until INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX edge_upload_credentials_job_idx
  ON edge_upload_credentials(edge_job_id, revoked_at, expires_at);
CREATE INDEX edge_upload_credentials_task_idx
  ON edge_upload_credentials(task_id, task_attempt, revoked_at, expires_at);

CREATE TABLE edge_cache_replicas (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES edge_agents(id) ON DELETE SET NULL,
  catalog_version_id TEXT REFERENCES edge_catalog_versions(id) ON DELETE SET NULL,
  transfer_job_id TEXT REFERENCES edge_transfer_jobs(id) ON DELETE SET NULL,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'ready',
      'protected',
      'eligible',
      'verifying_source',
      'evicting',
      'evicted',
      'recovery_blocked'
    )
  ),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  source_sha256 TEXT CHECK (
    source_sha256 IS NULL OR (
      length(source_sha256) = 64
      AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  source_verified_at INTEGER,
  protected_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  evicted_at INTEGER
);

CREATE UNIQUE INDEX edge_cache_replicas_media_idx
  ON edge_cache_replicas(media_id) WHERE media_id IS NOT NULL;
CREATE INDEX edge_cache_replicas_state_idx
  ON edge_cache_replicas(state, pinned, updated_at);
CREATE INDEX edge_cache_replicas_source_idx
  ON edge_cache_replicas(agent_id, catalog_version_id, state);

CREATE TABLE edge_eviction_jobs (
  id TEXT PRIMARY KEY,
  cache_replica_id TEXT REFERENCES edge_cache_replicas(id) ON DELETE SET NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  expected_row_version INTEGER NOT NULL CHECK (expected_row_version >= 0),
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'verifying_source', 'evicting', 'completed', 'failed', 'cancelled')
  ),
  quarantine_storage_key TEXT,
  reason TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX edge_eviction_jobs_state_idx
  ON edge_eviction_jobs(state, created_at);
