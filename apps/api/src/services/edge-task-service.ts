import { v7 as uuidv7 } from "uuid";

import {
  edgeAgentTaskPayloadSchema,
  type EdgeAgentTaskPayload,
  type EdgeClaimedJob,
  type EdgeJobFailureCode,
  type EdgeSourceProof,
} from "@simplewatch/contracts";

import type { AppDatabase } from "../database.js";
import { conflict, notFound } from "../errors.js";
import { createOpaqueToken, hashToken } from "../security.js";
import type { EdgeTransferLifecycleService } from "./edge-transfer-lifecycle-service.js";

const TASK_LEASE_MILLISECONDS = 60_000;
const MAX_LONG_POLL_MILLISECONDS = 25_000;
const HOST_CATALOG_REFRESH_PRIORITY = 10_000;
export const EDGE_TASK_RETRY_RETENTION_MILLISECONDS = 48 * 60 * 60 * 1000;
export const EDGE_TRANSFER_STALL_MILLISECONDS = 10 * 60 * 1000;
export const EDGE_RETRY_BACKOFF_MAX_MILLISECONDS = 15 * 60 * 1000;
const MAX_TASK_ATTEMPTS = 1024;

export function edgeRetryBackoff(
  attempt: number,
  random: () => number = Math.random,
): number {
  const boundedAttempt = Math.max(0, Math.min(30, Math.trunc(attempt)));
  const ceiling = Math.min(
    EDGE_RETRY_BACKOFF_MAX_MILLISECONDS,
    1_000 * 2 ** boundedAttempt,
  );
  const sample = Math.max(0, Math.min(1, random()));
  return Math.min(ceiling, Math.floor(sample * ceiling));
}

interface TaskRow {
  readonly id: string;
  readonly payload_json: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly retry_expires_at: number;
}

export class EdgeTaskService {
  private readonly waiters = new Map<string, Set<() => void>>();

  public constructor(
    private readonly database: AppDatabase,
    private readonly now: () => number = Date.now,
    private readonly lifecycle?: EdgeTransferLifecycleService,
    private readonly random: () => number = Math.random,
  ) {}

  public enqueue(
    agentId: string,
    payload: EdgeAgentTaskPayload,
    dedupeKey: string,
    priority = 0,
  ): string {
    const parsed = edgeAgentTaskPayloadSchema.parse(payload);
    const existing = this.database
      .prepare("SELECT id FROM edge_agent_tasks WHERE dedupe_key = ?")
      .get(dedupeKey) as { readonly id: string } | undefined;
    if (existing) return existing.id;
    const taskId = uuidv7();
    const timestamp = this.now();
    this.database
      .prepare(
        `INSERT INTO edge_agent_tasks(
           id, agent_id, kind, dedupe_key, payload_json, state, priority,
           attempts, max_attempts, not_before, retry_expires_at, lease_until,
           lease_token_hash, progress_json, error_code, error_message,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, NULL, NULL,
                   NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        taskId,
        agentId,
        parsed.kind,
        dedupeKey,
        JSON.stringify(parsed),
        priority,
        MAX_TASK_ATTEMPTS,
        timestamp,
        timestamp + EDGE_TASK_RETRY_RETENTION_MILLISECONDS,
        timestamp,
        timestamp,
      );
    this.notify(agentId);
    return taskId;
  }

  public requestCatalogScan(agentId: string): {
    readonly id: string;
    readonly state: "queued" | "leased";
    readonly deduplicated: boolean;
  } {
    const timestamp = this.now();
    const dedupeKey = `host-catalog-refresh:${agentId}`;
    const result = this.database
      .transaction(() => {
        const agent = this.database
          .prepare(`SELECT enabled, revoked_at FROM edge_agents WHERE id = ?`)
          .get(agentId) as
          | { readonly enabled: number; readonly revoked_at: number | null }
          | undefined;
        if (!agent) throw notFound("Edge Agent 不存在");
        if (agent.enabled === 0 || agent.revoked_at !== null) {
          throw conflict("EDGE_AGENT_UNAVAILABLE", "Edge Agent 已停用或撤销");
        }
        const existing = this.database
          .prepare(
            `SELECT id, state FROM edge_agent_tasks WHERE dedupe_key = ?`,
          )
          .get(dedupeKey) as
          | { readonly id: string; readonly state: string }
          | undefined;
        if (
          existing &&
          (existing.state === "queued" || existing.state === "leased")
        ) {
          return {
            id: existing.id,
            state: existing.state,
            deduplicated: true,
          } as const;
        }
        const latest = this.database
          .prepare(
            `SELECT MAX(generation) AS generation FROM edge_catalog_scans
             WHERE agent_id = ?`,
          )
          .get(agentId) as { readonly generation: number | null };
        const generation = Math.max(1, timestamp, (latest.generation ?? 0) + 1);
        const payload = edgeAgentTaskPayloadSchema.parse({
          kind: "catalog_scan",
          generation,
        });
        if (existing) {
          this.database
            .prepare(
              `UPDATE edge_agent_tasks
               SET payload_json = ?, state = 'queued', priority = ?,
                   attempts = 0, max_attempts = ?, not_before = ?,
                   retry_expires_at = ?, lease_until = NULL,
                   lease_token_hash = NULL, progress_json = NULL,
                   error_code = NULL, error_message = NULL, created_at = ?,
                   updated_at = ?, completed_at = NULL WHERE id = ?`,
            )
            .run(
              JSON.stringify(payload),
              HOST_CATALOG_REFRESH_PRIORITY,
              MAX_TASK_ATTEMPTS,
              timestamp,
              timestamp + EDGE_TASK_RETRY_RETENTION_MILLISECONDS,
              timestamp,
              timestamp,
              existing.id,
            );
          return {
            id: existing.id,
            state: "queued",
            deduplicated: false,
          } as const;
        }
        const taskId = uuidv7();
        this.database
          .prepare(
            `INSERT INTO edge_agent_tasks(
               id, agent_id, kind, dedupe_key, payload_json, state, priority,
               attempts, max_attempts, not_before, retry_expires_at,
               lease_until, lease_token_hash, progress_json, error_code,
               error_message, created_at, updated_at, completed_at
             ) VALUES (?, ?, 'catalog_scan', ?, ?, 'queued', ?, 0, ?, ?, ?,
                       NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
          )
          .run(
            taskId,
            agentId,
            dedupeKey,
            JSON.stringify(payload),
            HOST_CATALOG_REFRESH_PRIORITY,
            MAX_TASK_ATTEMPTS,
            timestamp,
            timestamp + EDGE_TASK_RETRY_RETENTION_MILLISECONDS,
            timestamp,
            timestamp,
          );
        return { id: taskId, state: "queued", deduplicated: false } as const;
      })
      .immediate();
    this.notify(agentId);
    return result;
  }

  public requestTransferCancellation(edgeTransferId: string): void {
    const timestamp = this.now();
    const row = this.database
      .prepare(
        `SELECT id, agent_id, state FROM edge_transfer_jobs WHERE id = ?`,
      )
      .get(edgeTransferId) as
      | {
          readonly id: string;
          readonly agent_id: string | null;
          readonly state: string;
        }
      | undefined;
    if (!row) throw notFound("Edge 传输任务不存在");
    if (row.state === "cancelled") return;
    if (
      new Set(["ready", "incompatible", "failed", "evicted"]).has(row.state)
    ) {
      throw conflict("EDGE_TRANSFER_NOT_CANCELLABLE", "该传输已经结束");
    }
    if (new Set(["received", "processing"]).has(row.state)) {
      throw conflict("EDGE_TRANSFER_NOT_CANCELLABLE", "影片已进入云端检片阶段");
    }
    const activeTask = this.database
      .prepare(
        `SELECT id, state FROM edge_agent_tasks
         WHERE json_extract(payload_json, '$.edgeTransferId') = ?
           AND kind = 'upload' AND state IN ('queued', 'leased')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(edgeTransferId) as
      | { readonly id: string; readonly state: string }
      | undefined;
    if (!activeTask || activeTask.state === "queued") {
      if (activeTask) {
        this.database
          .prepare(
            `UPDATE edge_agent_tasks SET state = 'cancelled', completed_at = ?,
                    updated_at = ? WHERE id = ?`,
          )
          .run(timestamp, timestamp, activeTask.id);
      }
      this.lifecycle?.finalize(
        edgeTransferId,
        "cancelled",
        "CANCELLED_BY_HOST",
        "由 Host 取消",
        timestamp,
      );
      return;
    }
    this.database
      .prepare(
        `UPDATE edge_transfer_jobs SET state = 'cancel_requested', updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, edgeTransferId);
  }

  public retryTransfer(edgeTransferId: string): void {
    const timestamp = this.now();
    const row = this.database
      .prepare(
        `SELECT t.id, t.agent_id, t.catalog_version_id, t.owner_account_id,
                v.bytes, v.mtime_ms, v.sha256, v.source_state,
                i.id AS catalog_item_id, i.local_id
         FROM edge_transfer_jobs t
         JOIN edge_catalog_versions v ON v.id = t.catalog_version_id
         JOIN edge_catalog_items i ON i.id = v.catalog_item_id
         WHERE t.id = ?`,
      )
      .get(edgeTransferId) as
      | {
          readonly id: string;
          readonly agent_id: string | null;
          readonly catalog_version_id: string;
          readonly owner_account_id: string | null;
          readonly bytes: number;
          readonly mtime_ms: number;
          readonly sha256: string | null;
          readonly source_state: string;
          readonly catalog_item_id: string;
          readonly local_id: string;
        }
      | undefined;
    if (!row?.agent_id || row.source_state !== "present") {
      throw conflict("EDGE_SOURCE_UNAVAILABLE", "家庭媒体源当前不可用");
    }
    const current = this.database
      .prepare("SELECT state FROM edge_transfer_jobs WHERE id = ?")
      .get(edgeTransferId) as { readonly state: string };
    if (
      !new Set([
        "blocked_storage",
        "source_missing",
        "source_changed",
        "permission_denied",
        "failed",
      ]).has(current.state)
    ) {
      throw conflict("EDGE_TRANSFER_NOT_RETRYABLE", "该传输当前不能重试");
    }
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE uploads SET edge_job_id = NULL
           WHERE edge_job_id = ? AND state IN (
             'cancelled', 'failed', 'incompatible', 'published'
           )`,
        )
        .run(edgeTransferId);
      this.database
        .prepare(
          `UPDATE edge_transfer_jobs
           SET state = 'queued', upload_id = NULL, media_id = NULL,
               transferred_bytes = 0, speed_bytes_per_second = NULL,
               last_progress_at = NULL, attempts = 0, error_code = NULL,
               error_message = NULL, updated_at = ?, ready_at = NULL,
               finished_at = NULL
           WHERE id = ?`,
        )
        .run(timestamp, edgeTransferId);
      this.database
        .prepare(
          `UPDATE program_queue_items
           SET media_id = NULL, preparation_state = 'queued', updated_at = ?
           WHERE transfer_job_id = ?`,
        )
        .run(timestamp, edgeTransferId);
    })();
    this.enqueue(
      row.agent_id,
      {
        kind: "upload",
        edgeTransferId,
        catalogItemId: row.catalog_item_id,
        catalogVersionId: row.catalog_version_id,
        localId: row.local_id,
        expectedBytes: row.bytes,
        expectedMtimeMs: row.mtime_ms,
        expectedSha256: row.sha256,
      },
      `edge-retry:${edgeTransferId}:${uuidv7()}`,
      1000,
    );
  }

  public async claim(
    agentId: string,
    waitMilliseconds = MAX_LONG_POLL_MILLISECONDS,
    signal?: AbortSignal,
  ): Promise<EdgeClaimedJob | null> {
    const initial = this.tryClaim(agentId);
    if (initial) return initial;
    await this.wait(
      agentId,
      Math.min(Math.max(0, waitMilliseconds), MAX_LONG_POLL_MILLISECONDS),
      signal,
    );
    if (signal?.aborted) return null;
    return this.tryClaim(agentId);
  }

  public heartbeat(
    agentId: string,
    taskId: string,
    leaseToken: string,
    bytesTransferred?: number,
  ): { readonly leaseExpiresAt: string; readonly cancelRequested: boolean } {
    const timestamp = this.now();
    const leaseUntil = timestamp + TASK_LEASE_MILLISECONDS;
    const task = this.requireLease(agentId, taskId, leaseToken, timestamp);
    const payload = edgeAgentTaskPayloadSchema.parse(
      JSON.parse(task.payload_json),
    );
    if (
      payload.kind === "upload" &&
      bytesTransferred !== undefined &&
      this.isUploadStalled(
        payload.edgeTransferId,
        Math.min(bytesTransferred, payload.expectedBytes),
        timestamp,
      )
    ) {
      const outcome = this.fail(agentId, taskId, leaseToken, {
        code: "TRANSFER_STALLED",
        message: "上传连续十分钟没有字节增长",
        retryable: true,
      });
      throw conflict(
        "EDGE_TRANSFER_STALLED",
        outcome.state === "queued"
          ? "上传长期无进度，已重新排队"
          : "上传长期无进度且重试期限已结束",
      );
    }
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE edge_agent_tasks
           SET lease_until = ?, progress_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          leaseUntil,
          bytesTransferred === undefined
            ? null
            : JSON.stringify({ bytesTransferred }),
          timestamp,
          taskId,
        );
      if (payload.kind === "upload" && bytesTransferred !== undefined) {
        this.database
          .prepare(
            `UPDATE edge_transfer_jobs
             SET state = CASE
                   WHEN state = 'received' THEN state
                   ELSE 'uploading'
                 END,
                 speed_bytes_per_second = CASE
                   WHEN MIN(?, declared_bytes) <= transferred_bytes
                     OR last_progress_at IS NULL OR ? <= last_progress_at
                     THEN NULL
                   ELSE
                     (MIN(?, declared_bytes) - transferred_bytes) * 1000.0 /
                       (? - last_progress_at)
                 END,
                 transferred_bytes = MAX(
                   transferred_bytes, MIN(?, declared_bytes)
                 ),
                 last_progress_at = CASE
                   WHEN MIN(?, declared_bytes) > transferred_bytes THEN ?
                   ELSE last_progress_at
                 END,
                 updated_at = ?
             WHERE id = ? AND state NOT IN (
               'ready', 'cancel_requested', 'cancelled', 'incompatible',
               'failed', 'evicted'
             )`,
          )
          .run(
            Math.min(bytesTransferred, payload.expectedBytes),
            timestamp,
            Math.min(bytesTransferred, payload.expectedBytes),
            timestamp,
            Math.min(bytesTransferred, payload.expectedBytes),
            Math.min(bytesTransferred, payload.expectedBytes),
            timestamp,
            timestamp,
            payload.edgeTransferId,
          );
      }
    })();
    const cancelRequested =
      (payload.kind === "upload" || payload.kind === "verify_source") &&
      payload.edgeTransferId !== null &&
      this.isTransferCancelRequested(payload.edgeTransferId);
    return {
      leaseExpiresAt: new Date(leaseUntil).toISOString(),
      cancelRequested,
    };
  }

  public prepareUploadCredential(
    agentId: string,
    taskId: string,
    leaseToken: string,
    source: EdgeSourceProof,
  ): {
    readonly edgeTransferId: string;
    readonly agentId: string;
    readonly taskId: string;
    readonly taskAttempt: number;
    readonly ownerAccountId: string;
    readonly filename: string;
    readonly bytes: number;
    readonly mime: string;
    readonly sourceSha256?: string;
  } {
    const timestamp = this.now();
    const task = this.requireLease(agentId, taskId, leaseToken, timestamp);
    const payload = edgeAgentTaskPayloadSchema.parse(
      JSON.parse(task.payload_json),
    );
    if (payload.kind !== "upload") {
      throw conflict("EDGE_TASK_KIND_MISMATCH", "该任务不是上传任务");
    }
    if (
      source.bytes !== payload.expectedBytes ||
      source.mtimeMs !== payload.expectedMtimeMs ||
      (payload.expectedSha256 !== null &&
        source.sha256 !== payload.expectedSha256)
    ) {
      throw conflict("EDGE_SOURCE_CHANGED", "家庭源文件版本已经改变");
    }
    const row = this.database
      .transaction(() => {
        const lockedTask = this.database
          .prepare(
            `SELECT attempts FROM edge_agent_tasks
             WHERE id = ? AND agent_id = ? AND state = 'leased'
               AND lease_token_hash = ? AND lease_until > ?`,
          )
          .get(taskId, agentId, hashToken(leaseToken), this.now()) as
          | { readonly attempts: number }
          | undefined;
        if (!lockedTask) {
          throw conflict("EDGE_TASK_LEASE_EXPIRED", "Edge任务租约已失效");
        }
        const current = this.database
          .prepare(
            `SELECT t.id, t.owner_account_id, t.expected_sha256, t.state,
                    i.display_name, v.id AS version_id,
                    v.sha256 AS version_sha256
             FROM edge_transfer_jobs t
             JOIN edge_catalog_versions v ON v.id = t.catalog_version_id
             JOIN edge_catalog_items i ON i.id = v.catalog_item_id
             WHERE t.id = ? AND t.agent_id = ?`,
          )
          .get(payload.edgeTransferId, agentId) as
          | {
              readonly id: string;
              readonly owner_account_id: string | null;
              readonly expected_sha256: string | null;
              readonly state: string;
              readonly display_name: string;
              readonly version_id: string;
              readonly version_sha256: string | null;
            }
          | undefined;
        if (!current?.owner_account_id) {
          throw notFound("Edge 传输任务或请求账户不存在");
        }
        const ownerAccountId = current.owner_account_id;
        if (
          new Set([
            "ready",
            "cancel_requested",
            "cancelled",
            "incompatible",
            "failed",
            "evicted",
          ]).has(current.state)
        ) {
          throw conflict("EDGE_TRANSFER_TERMINAL", "Edge 传输任务已经结束");
        }
        if (
          (current.expected_sha256 !== null &&
            current.expected_sha256 !== source.sha256) ||
          (current.version_sha256 !== null &&
            current.version_sha256 !== source.sha256)
        ) {
          throw conflict("EDGE_SOURCE_CHANGED", "家庭源文件摘要已经改变");
        }
        this.database
          .prepare(
            `UPDATE edge_catalog_versions
             SET sha256 = COALESCE(sha256, ?), source_state = 'present',
                 last_verified_at = ?, missing_at = NULL WHERE id = ?`,
          )
          .run(source.sha256, timestamp, current.version_id);
        this.database
          .prepare(
            `UPDATE edge_transfer_jobs
             SET state = CASE
                   WHEN state IN ('uploading', 'received') THEN state
                   ELSE 'validating'
                 END,
                 expected_sha256 = COALESCE(expected_sha256, ?), updated_at = ?
             WHERE id = ?`,
          )
          .run(source.sha256, timestamp, current.id);
        return {
          ...current,
          owner_account_id: ownerAccountId,
          expected_sha256: source.sha256,
          version_sha256: source.sha256,
          task_attempt: lockedTask.attempts,
        };
      })
      .immediate();
    return {
      edgeTransferId: row.id,
      agentId,
      taskId: task.id,
      taskAttempt: row.task_attempt,
      ownerAccountId: row.owner_account_id,
      filename: row.display_name,
      bytes: payload.expectedBytes,
      mime: "application/octet-stream",
      sourceSha256: row.expected_sha256,
    };
  }

  public cancelled(
    agentId: string,
    taskId: string,
    leaseToken: string,
  ): string | null {
    const timestamp = this.now();
    const replay = this.findAcknowledgedTask(
      agentId,
      taskId,
      leaseToken,
      new Set(["cancelled"]),
    );
    if (replay) {
      const replayPayload = edgeAgentTaskPayloadSchema.parse(
        JSON.parse(replay.payload_json),
      );
      return "edgeTransferId" in replayPayload
        ? replayPayload.edgeTransferId
        : null;
    }
    const task = this.requireLease(agentId, taskId, leaseToken, timestamp);
    const payload = edgeAgentTaskPayloadSchema.parse(
      JSON.parse(task.payload_json),
    );
    const edgeTransferId =
      "edgeTransferId" in payload ? payload.edgeTransferId : null;
    if (edgeTransferId && !this.isTransferCancelRequested(edgeTransferId)) {
      throw conflict("EDGE_CANCEL_NOT_REQUESTED", "该任务未处于待取消状态");
    }
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE edge_agent_tasks
           SET state = 'cancelled', lease_until = NULL,
               error_code = NULL,
               error_message = NULL, updated_at = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, timestamp, taskId);
      if (edgeTransferId) {
        this.cancelTransferWithinTransaction(edgeTransferId, timestamp);
      }
    })();
    if (edgeTransferId) {
      this.lifecycle?.finalize(
        edgeTransferId,
        "cancelled",
        "CANCELLED_BY_HOST",
        "由 Host 取消",
        timestamp,
      );
    }
    return edgeTransferId;
  }

  public complete(
    agentId: string,
    taskId: string,
    leaseToken: string,
    source?: EdgeSourceProof,
  ): string | null {
    const timestamp = this.now();
    const replay = this.findAcknowledgedTask(
      agentId,
      taskId,
      leaseToken,
      new Set(["completed"]),
    );
    if (replay) {
      const replayPayload = edgeAgentTaskPayloadSchema.parse(
        JSON.parse(replay.payload_json),
      );
      return replayPayload.kind === "cancel_transfer"
        ? replayPayload.edgeTransferId
        : null;
    }
    const task = this.requireLease(agentId, taskId, leaseToken, timestamp);
    const payload = edgeAgentTaskPayloadSchema.parse(
      JSON.parse(task.payload_json),
    );
    this.database.transaction(() => {
      if (payload.kind === "upload" || payload.kind === "verify_source") {
        if (!source) {
          throw conflict(
            "EDGE_SOURCE_PROOF_REQUIRED",
            "缺少家庭源文件校验结果",
          );
        }
        if (
          source.bytes !== payload.expectedBytes ||
          source.mtimeMs !== payload.expectedMtimeMs ||
          (payload.expectedSha256 !== null &&
            source.sha256 !== payload.expectedSha256)
        ) {
          throw conflict("EDGE_SOURCE_CHANGED", "家庭源文件版本已经改变");
        }
        if (payload.kind === "upload") {
          const transfer = this.database
            .prepare(
              `SELECT expected_sha256, state
               FROM edge_transfer_jobs WHERE id = ?`,
            )
            .get(payload.edgeTransferId) as
            | {
                readonly expected_sha256: string | null;
                readonly state: string;
              }
            | undefined;
          if (!transfer?.expected_sha256) {
            throw conflict(
              "EDGE_SOURCE_PROOF_REQUIRED",
              "上传前的家庭源文件证明尚未锁定",
            );
          }
          if (transfer.expected_sha256 !== source.sha256) {
            throw conflict(
              "EDGE_SOURCE_CHANGED",
              "上传后的源摘要与预证明不一致",
            );
          }
          if (transfer.state !== "received") {
            throw conflict(
              "EDGE_UPLOAD_NOT_RECEIVED",
              "云端尚未完整接收该上传",
            );
          }
        }
        this.database
          .prepare(
            `UPDATE edge_catalog_versions
             SET sha256 = COALESCE(sha256, ?), source_state = 'present', last_verified_at = ?,
                 missing_at = NULL
             WHERE id = ?`,
          )
          .run(source.sha256, timestamp, payload.catalogVersionId);
        if (payload.kind === "upload") {
          this.database
            .prepare(
              `UPDATE edge_transfer_jobs
               SET state = CASE
                     WHEN state = 'received' THEN 'processing' ELSE state END,
                   updated_at = ?
               WHERE id = ?`,
            )
            .run(timestamp, payload.edgeTransferId);
          this.database
            .prepare(
              `UPDATE media_jobs
               SET payload_json = json_set(
                     payload_json,
                     '$.edgeJobId', ?,
                     '$.expectedSourceSha256', ?
                   ),
                   not_before = MIN(not_before, ?), updated_at = ?
               WHERE id = (
                 SELECT j.id FROM media_jobs j
                 JOIN uploads u ON u.id = json_extract(j.payload_json, '$.uploadId')
                 WHERE u.edge_job_id = ? ORDER BY j.created_at DESC LIMIT 1
               )`,
            )
            .run(
              payload.edgeTransferId,
              source.sha256,
              timestamp,
              timestamp,
              payload.edgeTransferId,
            );
        }
        if (payload.kind === "verify_source") {
          this.database
            .prepare(
              `UPDATE edge_cache_replicas
               SET source_sha256 = ?, source_verified_at = ?,
                   generation = generation + 1, row_version = row_version + 1,
                   updated_at = ?
               WHERE id = ?`,
            )
            .run(source.sha256, timestamp, timestamp, payload.cacheReplicaId);
          this.database
            .prepare(
              `UPDATE edge_eviction_jobs
               SET state = 'queued',
                   expected_generation = (
                     SELECT generation FROM edge_cache_replicas WHERE id = ?
                   ),
                   expected_row_version = (
                     SELECT row_version FROM edge_cache_replicas WHERE id = ?
                   ),
                   updated_at = ?
               WHERE cache_replica_id = ? AND state = 'verifying_source'`,
            )
            .run(
              payload.cacheReplicaId,
              payload.cacheReplicaId,
              timestamp,
              payload.cacheReplicaId,
            );
        }
      }
      if (payload.kind === "cancel_transfer") {
        this.cancelTransferWithinTransaction(payload.edgeTransferId, timestamp);
      }
      this.database
        .prepare(
          `UPDATE edge_agent_tasks
           SET state = 'completed', lease_until = NULL,
               error_code = NULL, error_message = NULL, updated_at = ?,
               completed_at = ? WHERE id = ?`,
        )
        .run(timestamp, timestamp, taskId);
    })();
    if (payload.kind === "cancel_transfer") {
      this.lifecycle?.finalize(
        payload.edgeTransferId,
        "cancelled",
        "CANCELLED_BY_HOST",
        "由 Host 取消",
        timestamp,
      );
    }
    return payload.kind === "cancel_transfer" ? payload.edgeTransferId : null;
  }

  public fail(
    agentId: string,
    taskId: string,
    leaseToken: string,
    failure: {
      readonly code: EdgeJobFailureCode;
      readonly message: string;
      readonly retryable: boolean;
    },
  ): { readonly state: "queued" | "failed" } {
    const timestamp = this.now();
    const replay = this.findAcknowledgedTask(
      agentId,
      taskId,
      leaseToken,
      new Set(["queued", "failed"]),
    );
    if (replay) return { state: replay.state as "queued" | "failed" };
    const task = this.requireLease(agentId, taskId, leaseToken, timestamp);
    const payload = edgeAgentTaskPayloadSchema.parse(
      JSON.parse(task.payload_json),
    );
    const retry =
      failure.retryable &&
      task.attempts < task.max_attempts &&
      timestamp < task.retry_expires_at;
    const state = retry ? "queued" : "failed";
    const retryAt = Math.min(
      task.retry_expires_at,
      timestamp + edgeRetryBackoff(task.attempts, this.random),
    );
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE edge_agent_tasks
           SET state = ?, not_before = ?, lease_until = NULL,
               error_code = ?, error_message = ?,
               updated_at = ?, completed_at = ? WHERE id = ?`,
        )
        .run(
          state,
          retry ? retryAt : timestamp,
          failure.code,
          failure.message,
          timestamp,
          retry ? null : timestamp,
          taskId,
        );
      if (payload.kind === "upload") {
        const transferState = toTransferFailureState(failure.code, retry);
        this.database
          .prepare(
            `UPDATE edge_transfer_jobs
             SET state = CASE
                   WHEN ? = 'queued' AND state = 'received' THEN state
                   ELSE ?
                 END,
                 error_code = ?, error_message = ?, updated_at = ?,
                 finished_at = CASE WHEN ? = 'failed' THEN ? ELSE finished_at END
             WHERE id = ?`,
          )
          .run(
            transferState,
            transferState,
            failure.code,
            failure.message,
            timestamp,
            transferState,
            timestamp,
            payload.edgeTransferId,
          );
      }
      if (
        (payload.kind === "upload" || payload.kind === "verify_source") &&
        failure.code === "SOURCE_CHANGED"
      ) {
        this.database
          .prepare(
            `UPDATE edge_catalog_versions SET source_state = 'changed'
             WHERE id = ? AND source_state != 'missing'`,
          )
          .run(payload.catalogVersionId);
      }
      if (!retry && payload.kind === "verify_source") {
        this.failSourceVerificationWithinTransaction(
          payload.cacheReplicaId,
          failure.code,
          failure.message,
          timestamp,
        );
      }
    })();
    if (!retry && payload.kind === "upload") {
      this.lifecycle?.finalize(
        payload.edgeTransferId,
        toTerminalTransferFailureState(failure.code),
        failure.code,
        failure.message,
        timestamp,
      );
    }
    if (retry) this.notify(agentId);
    return { state };
  }

  private tryClaim(agentId: string): EdgeClaimedJob | null {
    const timestamp = this.now();
    this.finalizeExhaustedTasks(agentId, timestamp);
    return this.database
      .transaction(() => {
        const task = this.database
          .prepare(
            `SELECT id, payload_json, attempts, max_attempts, retry_expires_at
           FROM edge_agent_tasks
           WHERE agent_id = ? AND attempts < max_attempts
             AND retry_expires_at > ? AND (
             (state = 'queued' AND not_before <= ?) OR
             (state = 'leased' AND lease_until <= ?)
           )
             AND (
               kind NOT IN ('upload', 'verify_source') OR NOT EXISTS (
                 SELECT 1 FROM edge_agent_tasks active
                 WHERE active.agent_id = edge_agent_tasks.agent_id
                   AND active.kind IN ('upload', 'verify_source')
                   AND active.state = 'leased' AND active.lease_until > ?
               )
             )
           ORDER BY priority DESC, created_at, id LIMIT 1`,
          )
          .get(agentId, timestamp, timestamp, timestamp, timestamp) as
          | TaskRow
          | undefined;
        if (!task) return null;
        const leaseToken = createOpaqueToken();
        const leaseUntil = timestamp + TASK_LEASE_MILLISECONDS;
        this.database
          .prepare(
            `UPDATE edge_agent_tasks
           SET state = 'leased', attempts = attempts + 1, lease_until = ?,
               lease_token_hash = ?, updated_at = ? WHERE id = ?`,
          )
          .run(leaseUntil, hashToken(leaseToken), timestamp, task.id);
        const payload = edgeAgentTaskPayloadSchema.parse(
          JSON.parse(task.payload_json),
        );
        if (payload.kind === "upload") {
          this.database
            .prepare(
              `UPDATE edge_transfer_jobs
             SET state = 'leased', attempts = attempts + 1,
                 last_progress_at = ?, updated_at = ?
             WHERE id = ? AND state IN ('queued', 'leased')`,
            )
            .run(timestamp, timestamp, payload.edgeTransferId);
        }
        return {
          id: task.id,
          leaseToken,
          leaseExpiresAt: new Date(leaseUntil).toISOString(),
          attempts: task.attempts + 1,
          maxAttempts: task.max_attempts,
          payload,
        };
      })
      .immediate();
  }

  private requireLease(
    agentId: string,
    taskId: string,
    leaseToken: string,
    timestamp: number,
  ): TaskRow & { readonly payload_json: string } {
    const task = this.database
      .prepare(
        `SELECT id, payload_json, attempts, max_attempts, retry_expires_at
         FROM edge_agent_tasks
         WHERE id = ? AND agent_id = ? AND state = 'leased'
           AND lease_token_hash = ? AND lease_until > ?`,
      )
      .get(taskId, agentId, hashToken(leaseToken), timestamp) as
      | TaskRow
      | undefined;
    if (!task) throw conflict("EDGE_TASK_LEASE_EXPIRED", "Edge任务租约已失效");
    return task;
  }

  private findAcknowledgedTask(
    agentId: string,
    taskId: string,
    leaseToken: string,
    states: ReadonlySet<string>,
  ):
    | (TaskRow & { readonly payload_json: string; readonly state: string })
    | undefined {
    const row = this.database
      .prepare(
        `SELECT id, payload_json, attempts, max_attempts, retry_expires_at, state
         FROM edge_agent_tasks
         WHERE id = ? AND agent_id = ? AND lease_token_hash = ?`,
      )
      .get(taskId, agentId, hashToken(leaseToken)) as
      | (TaskRow & { readonly payload_json: string; readonly state: string })
      | undefined;
    return row && states.has(row.state) ? row : undefined;
  }

  private finalizeExhaustedTasks(agentId: string, timestamp: number): void {
    const rows = this.database
      .prepare(
        `SELECT id, payload_json,
                CASE
                  WHEN retry_expires_at <= ? THEN 'RETRY_WINDOW_EXPIRED'
                  ELSE 'LEASE_EXHAUSTED'
                END AS failure_code
         FROM edge_agent_tasks
         WHERE agent_id = ? AND (
           (state = 'queued' AND retry_expires_at <= ?) OR
           (state = 'leased' AND lease_until <= ? AND (
             attempts >= max_attempts OR retry_expires_at <= ?
           ))
         )`,
      )
      .all(timestamp, agentId, timestamp, timestamp, timestamp) as Array<{
      readonly id: string;
      readonly payload_json: string;
      readonly failure_code: "LEASE_EXHAUSTED" | "RETRY_WINDOW_EXPIRED";
    }>;
    for (const row of rows) {
      const payload = edgeAgentTaskPayloadSchema.parse(
        JSON.parse(row.payload_json),
      );
      const failureMessage =
        row.failure_code === "RETRY_WINDOW_EXPIRED"
          ? "任务四十八小时重试期限已结束"
          : "任务租约耗尽";
      const updated = this.database
        .prepare(
          `UPDATE edge_agent_tasks
           SET state = 'failed', error_code = ?, error_message = ?,
               lease_until = NULL, updated_at = ?, completed_at = ?
           WHERE id = ? AND state IN ('queued', 'leased')`,
        )
        .run(row.failure_code, failureMessage, timestamp, timestamp, row.id);
      if (updated.changes !== 1) continue;
      if (payload.kind === "upload") {
        this.lifecycle?.finalize(
          payload.edgeTransferId,
          "failed",
          row.failure_code,
          failureMessage,
          timestamp,
        );
      }
      if (payload.kind === "verify_source") {
        this.failSourceVerificationWithinTransaction(
          payload.cacheReplicaId,
          row.failure_code,
          failureMessage,
          timestamp,
        );
      }
    }
  }

  private isUploadStalled(
    edgeTransferId: string,
    bytesTransferred: number,
    timestamp: number,
  ): boolean {
    const row = this.database
      .prepare(
        `SELECT state, transferred_bytes, last_progress_at
         FROM edge_transfer_jobs WHERE id = ?`,
      )
      .get(edgeTransferId) as
      | {
          readonly state: string;
          readonly transferred_bytes: number;
          readonly last_progress_at: number | null;
        }
      | undefined;
    return (
      row !== undefined &&
      new Set(["leased", "validating", "uploading"]).has(row.state) &&
      row.last_progress_at !== null &&
      bytesTransferred <= row.transferred_bytes &&
      timestamp - row.last_progress_at >= EDGE_TRANSFER_STALL_MILLISECONDS
    );
  }

  private isTransferCancelRequested(edgeTransferId: string): boolean {
    const row = this.database
      .prepare("SELECT state FROM edge_transfer_jobs WHERE id = ?")
      .get(edgeTransferId) as { readonly state: string } | undefined;
    return row?.state === "cancel_requested";
  }

  private failSourceVerificationWithinTransaction(
    cacheReplicaId: string,
    errorCode: string,
    errorMessage: string,
    timestamp: number,
  ): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE edge_eviction_jobs
           SET state = 'failed', error_code = ?, error_message = ?,
               updated_at = ?, completed_at = ?
           WHERE cache_replica_id = ? AND state = 'verifying_source'`,
        )
        .run(
          errorCode,
          errorMessage.slice(0, 1000),
          timestamp,
          timestamp,
          cacheReplicaId,
        );
      this.database
        .prepare(
          `UPDATE edge_cache_replicas
           SET state = 'recovery_blocked', protected_reason = ?,
               row_version = row_version + 1, updated_at = ?
           WHERE id = ? AND state = 'verifying_source'`,
        )
        .run(errorCode, timestamp, cacheReplicaId);
    })();
  }

  private cancelTransferWithinTransaction(
    edgeTransferId: string,
    timestamp: number,
  ): void {
    const transfer = this.database
      .prepare("SELECT state FROM edge_transfer_jobs WHERE id = ?")
      .get(edgeTransferId) as { readonly state: string } | undefined;
    if (!transfer) throw notFound("Edge 传输任务不存在");
    if (
      transfer.state !== "cancel_requested" &&
      transfer.state !== "cancelled"
    ) {
      throw conflict("EDGE_CANCEL_NOT_REQUESTED", "该传输未处于待取消状态");
    }
    this.database
      .prepare(
        `UPDATE edge_transfer_jobs
         SET state = 'cancelled', updated_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, timestamp, edgeTransferId);
    this.database
      .prepare(
        `UPDATE uploads SET state = 'cancelled', reserved_bytes = 0,
                finished_at = ?
         WHERE edge_job_id = ?
           AND state IN ('authorized', 'uploading', 'received')`,
      )
      .run(timestamp, edgeTransferId);
    this.database
      .prepare(
        `UPDATE edge_upload_credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE edge_job_id = ?`,
      )
      .run(timestamp, edgeTransferId);
  }

  private wait(
    agentId: string,
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (milliseconds === 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolveWait) => {
      const waiters = this.waiters.get(agentId) ?? new Set<() => void>();
      this.waiters.set(agentId, waiters);
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        if (waiters.size === 0) this.waiters.delete(agentId);
        resolveWait();
      };
      waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      const timer = setTimeout(finish, milliseconds);
    });
  }

  private notify(agentId: string): void {
    for (const waiter of [...(this.waiters.get(agentId) ?? [])]) waiter();
  }
}

function toTransferFailureState(
  code: EdgeJobFailureCode,
  retry: boolean,
):
  | "queued"
  | "source_missing"
  | "source_changed"
  | "permission_denied"
  | "blocked_storage"
  | "failed" {
  if (retry) return "queued";
  if (code === "SOURCE_MISSING") return "source_missing";
  if (code === "SOURCE_CHANGED") return "source_changed";
  if (code === "PERMISSION_DENIED") return "permission_denied";
  if (code === "INSUFFICIENT_STORAGE") return "blocked_storage";
  return "failed";
}

function toTerminalTransferFailureState(
  code: EdgeJobFailureCode,
):
  | "source_missing"
  | "source_changed"
  | "permission_denied"
  | "blocked_storage"
  | "failed" {
  if (code === "SOURCE_MISSING") return "source_missing";
  if (code === "SOURCE_CHANGED") return "source_changed";
  if (code === "PERMISSION_DENIED") return "permission_denied";
  if (code === "INSUFFICIENT_STORAGE") return "blocked_storage";
  return "failed";
}
