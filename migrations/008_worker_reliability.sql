ALTER TABLE media_jobs ADD COLUMN error_message TEXT;
ALTER TABLE media_jobs ADD COLUMN finished_at INTEGER;

CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('idle', 'busy', 'degraded')),
  current_job_id TEXT REFERENCES media_jobs(id) ON DELETE SET NULL,
  last_error TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX worker_heartbeats_last_seen_idx
  ON worker_heartbeats(last_seen_at);

-- 008 上线前，Worker 进程会在单任务异常时整体退出；因此历史任务可能
-- 累积了上千次“领取后崩溃”，却从未记录一次可归因的任务错误。给这类
-- 无错误码的过期任务一次受控恢复窗口，后续仍受新的有限重试约束。
UPDATE media_jobs
SET state = 'pending',
    attempts = 0,
    not_before = unixepoch('now') * 1000,
    lease_until = NULL,
    worker_id = NULL,
    lease_token_hash = NULL,
    error_code = 'LEGACY_RECOVERY',
    error_message = '008 migration granted one bounded idempotent recovery window',
    updated_at = unixepoch('now') * 1000
WHERE state IN ('pending', 'leased')
  AND attempts >= 5
  AND error_code IS NULL;
