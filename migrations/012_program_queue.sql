CREATE TABLE program_queues (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'cleared')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  cleared_at INTEGER
);

CREATE UNIQUE INDEX program_queues_single_active_idx
  ON program_queues(state) WHERE state = 'active';

CREATE TABLE program_queue_items (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES program_queues(id) ON DELETE CASCADE,
  catalog_version_id TEXT REFERENCES edge_catalog_versions(id) ON DELETE SET NULL,
  transfer_job_id TEXT REFERENCES edge_transfer_jobs(id) ON DELETE SET NULL,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  preparation_state TEXT NOT NULL CHECK (
    preparation_state IN (
      'pending',
      'queued',
      'validating',
      'uploading',
      'processing',
      'ready',
      'blocked',
      'failed',
      'evicted'
    )
  ),
  playback_state TEXT NOT NULL CHECK (
    playback_state IN ('upcoming', 'current', 'completed', 'incomplete', 'removed')
  ),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  activated_at INTEGER,
  finished_at INTEGER,
  UNIQUE (queue_id, position)
);

CREATE INDEX program_queue_items_queue_state_idx
  ON program_queue_items(queue_id, playback_state, preparation_state, position);
CREATE INDEX program_queue_items_transfer_idx
  ON program_queue_items(transfer_job_id);

CREATE TABLE program_play_history (
  id TEXT PRIMARY KEY,
  queue_id TEXT REFERENCES program_queues(id) ON DELETE SET NULL,
  program_item_id TEXT REFERENCES program_queue_items(id) ON DELETE SET NULL,
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  activation_sequence INTEGER NOT NULL CHECK (activation_sequence > 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  covered_ms INTEGER NOT NULL DEFAULT 0 CHECK (covered_ms >= 0),
  last_progress_sequence INTEGER NOT NULL DEFAULT -1,
  last_position_ms INTEGER,
  last_sampled_at_ms INTEGER,
  last_playing INTEGER CHECK (last_playing IS NULL OR last_playing IN (0, 1)),
  last_rate REAL,
  completion_kind TEXT CHECK (
    completion_kind IS NULL OR completion_kind IN ('automatic', 'manual', 'incomplete')
  ),
  activated_at INTEGER NOT NULL,
  departed_at INTEGER,
  completed_at INTEGER,
  UNIQUE (queue_id, activation_sequence)
);

CREATE INDEX program_play_history_queue_sequence_idx
  ON program_play_history(queue_id, activation_sequence DESC);
CREATE INDEX program_play_history_incomplete_idx
  ON program_play_history(queue_id, completion_kind, activation_sequence);

CREATE TABLE program_watch_ranges (
  play_history_id TEXT NOT NULL REFERENCES program_play_history(id) ON DELETE CASCADE,
  range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
  range_end_ms INTEGER NOT NULL CHECK (range_end_ms > range_start_ms),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (play_history_id, range_start_ms, range_end_ms)
);

CREATE INDEX program_watch_ranges_history_start_idx
  ON program_watch_ranges(play_history_id, range_start_ms);

ALTER TABLE room_state
  ADD COLUMN program_queue_id TEXT
  REFERENCES program_queues(id) ON DELETE SET NULL;

ALTER TABLE room_state
  ADD COLUMN current_program_item_id TEXT
  REFERENCES program_queue_items(id) ON DELETE SET NULL;
