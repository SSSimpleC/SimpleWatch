import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import { v7 as uuidv7 } from "uuid";

import type { AppDatabase } from "../database.js";
import { conflict, notFound } from "../errors.js";
import type { EdgeTaskService } from "./edge-task-service.js";

const SOURCE_PROOF_FRESH_MS = 60 * 60 * 1000;
const STORAGE_SAFETY_FLOOR_BYTES = 12 * 1024 * 1024 * 1024;

interface ReplicaRow {
  readonly id: string;
  readonly agent_id: string | null;
  readonly catalog_version_id: string | null;
  readonly transfer_job_id: string | null;
  readonly media_id: string | null;
  readonly state: string;
  readonly pinned: number;
  readonly generation: number;
  readonly row_version: number;
  readonly source_sha256: string | null;
  readonly source_verified_at: number | null;
}

export class EdgeEvictionService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly taskService: EdgeTaskService,
    private readonly mediaRoot: string,
    private readonly trashRoot: string,
    private readonly now: () => number = Date.now,
    private readonly availableBytes: () => number = () => {
      const disk = statfsSync(this.mediaRoot);
      return disk.bavail * disk.bsize;
    },
  ) {}

  public setPinned(
    replicaId: string,
    expectedGeneration: number,
    expectedRowVersion: number,
    pinned: boolean,
  ): void {
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE edge_cache_replicas
         SET pinned = ?, state = CASE WHEN ? = 1 THEN 'protected' ELSE state END,
             protected_reason = CASE WHEN ? = 1 THEN 'manual-pin'
               WHEN protected_reason = 'manual-pin' THEN NULL ELSE protected_reason END,
             row_version = row_version + 1, updated_at = ?
         WHERE id = ? AND generation = ? AND row_version = ?
           AND state != 'evicted'`,
      )
      .run(
        pinned ? 1 : 0,
        pinned ? 1 : 0,
        pinned ? 1 : 0,
        timestamp,
        replicaId,
        expectedGeneration,
        expectedRowVersion,
      );
    if (result.changes !== 1) {
      throw conflict(
        "EDGE_CACHE_CAS_CONFLICT",
        "缓存状态已经变化，请刷新后重试",
      );
    }
  }

  public requestEviction(
    replicaId: string,
    expectedGeneration: number,
    expectedRowVersion: number,
  ): { readonly evictionId: string; readonly state: string } {
    const replica = this.requireReplica(replicaId);
    if (
      replica.generation !== expectedGeneration ||
      replica.row_version !== expectedRowVersion
    ) {
      throw conflict(
        "EDGE_CACHE_CAS_CONFLICT",
        "缓存状态已经变化，请刷新后重试",
      );
    }
    if (replica.pinned === 1 || replica.state !== "eligible") {
      throw conflict("EDGE_CACHE_PROTECTED", "该缓存仍受节目单或固定保护");
    }
    if (!replica.agent_id || !replica.catalog_version_id || !replica.media_id) {
      throw conflict(
        "EDGE_CACHE_NOT_EVICTABLE",
        "缓存引用不完整，不能自动回收",
      );
    }
    const timestamp = this.now();
    const version = this.database
      .prepare(
        `SELECT v.sha256, v.bytes, v.mtime_ms, v.source_state,
                i.id AS catalog_item_id, i.local_id
         FROM edge_catalog_versions v
         JOIN edge_catalog_items i ON i.id = v.catalog_item_id
         WHERE v.id = ? AND i.current_version_id = v.id`,
      )
      .get(replica.catalog_version_id) as
      | {
          readonly sha256: string | null;
          readonly bytes: number;
          readonly mtime_ms: number;
          readonly source_state: string;
          readonly catalog_item_id: string;
          readonly local_id: string;
        }
      | undefined;
    if (!version || version.source_state !== "present") {
      throw conflict(
        "EDGE_SOURCE_UNAVAILABLE",
        "家庭源文件当前不可用，禁止回收缓存",
      );
    }
    const proofFresh =
      replica.source_sha256 !== null &&
      replica.source_sha256 === version.sha256 &&
      replica.source_verified_at !== null &&
      timestamp - replica.source_verified_at <= SOURCE_PROOF_FRESH_MS;
    const evictionId = uuidv7();
    this.database
      .prepare(
        `INSERT INTO edge_eviction_jobs(
           id, cache_replica_id, expected_generation, expected_row_version,
           state, quarantine_storage_key, reason, error_code, error_message,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, NULL, 'host-request', NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        evictionId,
        replica.id,
        replica.generation,
        replica.row_version,
        proofFresh ? "queued" : "verifying_source",
        timestamp,
        timestamp,
      );
    if (!proofFresh) {
      this.database
        .prepare(
          `UPDATE edge_cache_replicas
           SET state = 'verifying_source', row_version = row_version + 1,
               updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, replica.id);
      this.database
        .prepare(
          `UPDATE edge_eviction_jobs
           SET expected_row_version = expected_row_version + 1 WHERE id = ?`,
        )
        .run(evictionId);
      this.taskService.enqueue(
        replica.agent_id,
        {
          kind: "verify_source",
          edgeTransferId: replica.transfer_job_id,
          cacheReplicaId: replica.id,
          catalogItemId: version.catalog_item_id,
          catalogVersionId: replica.catalog_version_id,
          localId: version.local_id,
          expectedBytes: version.bytes,
          expectedMtimeMs: version.mtime_ms,
          expectedSha256: version.sha256,
        },
        `edge-eviction-verify:${evictionId}`,
        2000,
      );
    }
    return { evictionId, state: proofFresh ? "queued" : "verifying_source" };
  }

  public reconcile(): void {
    const jobs = this.database
      .prepare(
        `SELECT id FROM edge_eviction_jobs
         WHERE state IN ('queued', 'evicting') ORDER BY created_at`,
      )
      .all() as Array<{ readonly id: string }>;
    for (const job of jobs) this.process(job.id);
    this.recoverBlockedTransfers();
  }

  private recoverBlockedTransfers(): void {
    const blocked = this.database
      .prepare(
        `SELECT t.id, t.declared_bytes
         FROM edge_transfer_jobs t
         WHERE t.state = 'blocked_storage'
           AND EXISTS (
             SELECT 1 FROM program_queue_items i
             JOIN program_queues q ON q.id = i.queue_id AND q.state = 'active'
             WHERE i.transfer_job_id = t.id
               AND i.playback_state IN ('upcoming', 'current')
           )
         ORDER BY t.priority DESC, t.created_at`,
      )
      .all() as Array<{ readonly id: string; readonly declared_bytes: number }>;
    for (const transfer of blocked) {
      const reserved = this.database
        .prepare(
          `SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM uploads
           WHERE reserved_bytes > 0`,
        )
        .get() as { readonly bytes: number };
      const requiredReserve = transfer.declared_bytes * 2;
      if (
        this.availableBytes() - reserved.bytes - requiredReserve >=
        STORAGE_SAFETY_FLOOR_BYTES
      ) {
        this.taskService.retryTransfer(transfer.id);
        continue;
      }
      const candidate = this.database
        .prepare(
          `SELECT r.id, r.generation, r.row_version
           FROM edge_cache_replicas r
           JOIN edge_catalog_versions v ON v.id = r.catalog_version_id
           JOIN edge_catalog_items i ON i.id = v.catalog_item_id
           LEFT JOIN media m ON m.id = r.media_id
           WHERE r.state = 'eligible' AND r.pinned = 0
             AND r.media_id IS NOT NULL AND i.source_state = 'present'
             AND NOT EXISTS (
               SELECT 1 FROM edge_eviction_jobs e
               WHERE e.cache_replica_id = r.id
                 AND e.state IN ('queued', 'verifying_source', 'evicting')
             )
             AND NOT EXISTS (
               SELECT 1 FROM room_state s
               JOIN rooms room ON room.id = s.room_id AND room.status = 'active'
               WHERE s.media_id = r.media_id
             )
           ORDER BY COALESCE(m.bytes, v.bytes) DESC, r.updated_at, r.id
           LIMIT 1`,
        )
        .get() as
        | {
            readonly id: string;
            readonly generation: number;
            readonly row_version: number;
          }
        | undefined;
      if (!candidate) return;
      try {
        this.requestEviction(
          candidate.id,
          candidate.generation,
          candidate.row_version,
        );
      } catch {
        // 候选在读取后被置顶、保护或来源发生变化；下一轮重新选取。
      }
      return;
    }
  }

  private process(evictionId: string): void {
    const row = this.database
      .prepare(
        `SELECT e.id, e.cache_replica_id, e.expected_generation,
                e.expected_row_version, e.state, e.quarantine_storage_key,
                r.media_id, r.state AS replica_state, r.pinned,
                r.generation, r.row_version, r.source_sha256,
                r.source_verified_at, v.sha256 AS catalog_sha,
                v.source_state, m.storage_key
         FROM edge_eviction_jobs e
         JOIN edge_cache_replicas r ON r.id = e.cache_replica_id
         JOIN edge_catalog_versions v ON v.id = r.catalog_version_id
         JOIN media m ON m.id = r.media_id
         WHERE e.id = ?`,
      )
      .get(evictionId) as Record<string, string | number | null> | undefined;
    if (!row) return;
    const timestamp = this.now();
    if (
      row.pinned === 1 ||
      row.source_state !== "present" ||
      !row.source_sha256 ||
      row.source_sha256 !== row.catalog_sha ||
      !row.source_verified_at ||
      timestamp - Number(row.source_verified_at) > SOURCE_PROOF_FRESH_MS
    ) {
      this.fail(
        evictionId,
        String(row.cache_replica_id),
        "EDGE_SOURCE_UNVERIFIED",
        "家庭源证明不再有效",
        timestamp,
      );
      return;
    }
    if (row.state === "queued") {
      const changed = this.database.transaction(() => {
        const result = this.database
          .prepare(
            `UPDATE edge_cache_replicas
             SET state = 'evicting', generation = generation + 1,
                 row_version = row_version + 1, updated_at = ?
             WHERE id = ? AND state = 'eligible' AND pinned = 0
               AND generation = ? AND row_version = ?`,
          )
          .run(
            timestamp,
            row.cache_replica_id,
            row.expected_generation,
            row.expected_row_version,
          );
        if (result.changes !== 1) return false;
        const quarantineKey = `${evictionId}-${basename(String(row.storage_key))}`;
        this.database
          .prepare(
            `UPDATE edge_eviction_jobs
             SET state = 'evicting', quarantine_storage_key = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(quarantineKey, timestamp, evictionId);
        row.quarantine_storage_key = quarantineKey;
        return true;
      })();
      if (!changed) {
        this.fail(
          evictionId,
          String(row.cache_replica_id),
          "EDGE_CACHE_CAS_CONFLICT",
          "缓存状态已经变化",
          timestamp,
        );
        return;
      }
    }
    mkdirSync(join(this.trashRoot, "edge-quarantine"), { recursive: true });
    if (statSync(this.mediaRoot).dev !== statSync(this.trashRoot).dev) {
      this.fail(
        evictionId,
        String(row.cache_replica_id),
        "EDGE_CROSS_DEVICE",
        "媒体与隔离区不在同一文件系统",
        timestamp,
      );
      return;
    }
    const source = join(this.mediaRoot, String(row.storage_key));
    const quarantine = join(
      this.trashRoot,
      "edge-quarantine",
      String(row.quarantine_storage_key),
    );
    try {
      if (existsSync(source) && existsSync(quarantine)) {
        throw new Error("源目录与隔离目录同时存在");
      }
      if (existsSync(source)) renameSync(source, quarantine);
      if (existsSync(quarantine))
        rmSync(quarantine, { recursive: true, force: true });
      this.database.transaction(() => {
        this.database
          .prepare("UPDATE media SET trashed_at = ? WHERE id = ?")
          .run(timestamp, row.media_id);
        this.database
          .prepare(
            `UPDATE edge_cache_replicas
             SET media_id = NULL, state = 'evicted', protected_reason = NULL,
                 row_version = row_version + 1, updated_at = ?, evicted_at = ?
             WHERE id = ? AND state = 'evicting'`,
          )
          .run(timestamp, timestamp, row.cache_replica_id);
        this.database
          .prepare(
            `UPDATE edge_transfer_jobs SET state = 'evicted', media_id = NULL,
                    updated_at = ?, finished_at = ?
             WHERE id = (SELECT transfer_job_id FROM edge_cache_replicas WHERE id = ?)`,
          )
          .run(timestamp, timestamp, row.cache_replica_id);
        this.database
          .prepare(
            `UPDATE program_queue_items
             SET media_id = NULL, preparation_state = 'evicted', updated_at = ?
             WHERE transfer_job_id = (
               SELECT transfer_job_id FROM edge_cache_replicas WHERE id = ?
             ) AND playback_state != 'current'`,
          )
          .run(timestamp, row.cache_replica_id);
        this.database
          .prepare(
            `UPDATE edge_eviction_jobs SET state = 'completed', updated_at = ?,
                    completed_at = ? WHERE id = ?`,
          )
          .run(timestamp, timestamp, evictionId);
      })();
    } catch (error) {
      this.fail(
        evictionId,
        String(row.cache_replica_id),
        "EDGE_EVICTION_IO",
        error instanceof Error ? error.message : "缓存回收失败",
        timestamp,
      );
    }
  }

  private requireReplica(replicaId: string): ReplicaRow {
    const row = this.database
      .prepare("SELECT * FROM edge_cache_replicas WHERE id = ?")
      .get(replicaId) as ReplicaRow | undefined;
    if (!row) throw notFound("缓存副本不存在");
    return row;
  }

  private fail(
    evictionId: string,
    replicaId: string,
    code: string,
    message: string,
    timestamp: number,
  ): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE edge_eviction_jobs SET state = 'failed', error_code = ?,
                  error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
        )
        .run(code, message.slice(0, 1000), timestamp, timestamp, evictionId);
      this.database
        .prepare(
          `UPDATE edge_cache_replicas SET state = 'recovery_blocked',
                  protected_reason = ?, row_version = row_version + 1,
                  updated_at = ? WHERE id = ?`,
        )
        .run(code, timestamp, replicaId);
    })();
  }
}
