import { v7 as uuidv7 } from "uuid";

import type {
  ActivateProgramQueueItemCommand,
  PlaybackProgress,
  ProgramQueue,
  TransportAnchor,
} from "@simplewatch/contracts";

import type { AppDatabase } from "../database.js";
import { conflict, notFound } from "../errors.js";
import type { EdgeTaskService } from "./edge-task-service.js";

const COMPLETION_RATIO = 0.9;

interface QueueRow {
  readonly id: string;
  readonly display_name: string;
  readonly state: "active" | "completed" | "cleared";
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export class ProgramService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly taskService: EdgeTaskService,
    private readonly now: () => number = Date.now,
  ) {}

  public getOrCreateActiveQueue(
    ownerAccountId: string,
    displayName = "本次放映节目单",
  ): ProgramQueue {
    let queue = this.findActiveQueue();
    if (!queue) {
      const timestamp = this.now();
      const id = uuidv7();
      this.database
        .prepare(
          `INSERT INTO program_queues(
             id, owner_account_id, display_name, state, revision,
             created_at, updated_at, completed_at, cleared_at
           ) VALUES (?, ?, ?, 'active', 0, ?, ?, NULL, NULL)`,
        )
        .run(id, ownerAccountId, displayName, timestamp, timestamp);
      queue = this.requireQueue(id);
    }
    return this.serializeQueue(queue);
  }

  public getActiveQueue(): ProgramQueue | null {
    const queue = this.findActiveQueue();
    return queue ? this.serializeQueue(queue) : null;
  }

  public requestTransferCancellation(edgeTransferId: string): void {
    this.taskService.requestTransferCancellation(edgeTransferId);
  }

  public retryTransfer(edgeTransferId: string): void {
    this.taskService.retryTransfer(edgeTransferId);
  }

  public addItems(
    ownerAccountId: string,
    expectedRevision: number,
    catalogVersionIds: readonly string[],
  ): ProgramQueue {
    const queue = this.findActiveQueue();
    if (!queue) {
      this.getOrCreateActiveQueue(ownerAccountId);
      return this.addItems(ownerAccountId, 0, catalogVersionIds);
    }
    if (queue.revision !== expectedRevision) {
      throw conflict("PROGRAM_REVISION_CONFLICT", "节目单版本已经变化", {
        currentRevision: queue.revision,
      });
    }
    const timestamp = this.now();
    this.database.transaction(() => {
      const position = this.database
        .prepare(
          `SELECT COALESCE(MAX(position), -1) AS position
           FROM program_queue_items WHERE queue_id = ?`,
        )
        .get(queue.id) as { readonly position: number };
      let nextPosition = position.position + 1;
      for (const versionId of catalogVersionIds) {
        const version = this.database
          .prepare(
            `SELECT v.id, i.display_name, i.source_state
             FROM edge_catalog_versions v
             JOIN edge_catalog_items i ON i.id = v.catalog_item_id
             WHERE v.id = ? AND i.current_version_id = v.id`,
          )
          .get(versionId) as
          | {
              readonly id: string;
              readonly display_name: string;
              readonly source_state: "present" | "missing";
            }
          | undefined;
        if (!version || version.source_state !== "present") {
          throw conflict(
            "EDGE_SOURCE_UNAVAILABLE",
            "节目单影片已不在家庭片库中",
          );
        }
        const duplicate = this.database
          .prepare(
            `SELECT id FROM program_queue_items
             WHERE queue_id = ? AND catalog_version_id = ?
               AND playback_state != 'removed'`,
          )
          .get(queue.id, versionId);
        if (duplicate) continue;
        this.database
          .prepare(
            `INSERT INTO program_queue_items(
               id, queue_id, catalog_version_id, transfer_job_id, media_id,
               display_name, position, preparation_state, playback_state,
               pinned, created_at, updated_at, activated_at, finished_at
             ) VALUES (?, ?, ?, NULL, NULL, ?, ?, 'pending', 'upcoming',
                       0, ?, ?, NULL, NULL)`,
          )
          .run(
            uuidv7(),
            queue.id,
            versionId,
            version.display_name,
            nextPosition,
            timestamp,
            timestamp,
          );
        nextPosition += 1;
      }
      this.bumpQueue(queue.id, timestamp);
    })();
    this.reconcilePrefetch(queue.id, ownerAccountId);
    return this.serializeQueue(this.requireQueue(queue.id));
  }

  public reorder(
    queueId: string,
    expectedRevision: number,
    itemIds: readonly string[],
  ): ProgramQueue {
    const queue = this.requireQueue(queueId);
    if (queue.state !== "active")
      throw conflict("PROGRAM_CLOSED", "节目单已结束");
    if (queue.revision !== expectedRevision) {
      throw conflict("PROGRAM_REVISION_CONFLICT", "节目单版本已经变化", {
        currentRevision: queue.revision,
      });
    }
    const existing = this.database
      .prepare(
        `SELECT id FROM program_queue_items
         WHERE queue_id = ? AND playback_state != 'removed' ORDER BY position`,
      )
      .all(queueId) as Array<{ readonly id: string }>;
    if (
      existing.length !== itemIds.length ||
      new Set(existing.map((row) => row.id)).size !== new Set(itemIds).size ||
      itemIds.some((id) => !existing.some((row) => row.id === id))
    ) {
      throw conflict("PROGRAM_ITEMS_MISMATCH", "节目单排序项目不完整");
    }
    const timestamp = this.now();
    this.database.transaction(() => {
      const temporaryOffset = itemIds.length + 1000;
      this.database
        .prepare(
          `UPDATE program_queue_items SET position = position + ?, updated_at = ?
           WHERE queue_id = ?`,
        )
        .run(temporaryOffset, timestamp, queueId);
      const update = this.database.prepare(
        "UPDATE program_queue_items SET position = ?, updated_at = ? WHERE id = ? AND queue_id = ?",
      );
      itemIds.forEach((id, index) => update.run(index, timestamp, id, queueId));
      this.bumpQueue(queueId, timestamp);
    })();
    const owner = this.database
      .prepare("SELECT owner_account_id FROM program_queues WHERE id = ?")
      .get(queueId) as { readonly owner_account_id: string | null };
    if (owner.owner_account_id)
      this.reconcilePrefetch(queueId, owner.owner_account_id);
    return this.serializeQueue(this.requireQueue(queueId));
  }

  public removeItem(
    queueId: string,
    itemId: string,
    expectedRevision: number,
  ): ProgramQueue {
    const queue = this.requireQueue(queueId);
    if (queue.revision !== expectedRevision) {
      throw conflict("PROGRAM_REVISION_CONFLICT", "节目单版本已经变化", {
        currentRevision: queue.revision,
      });
    }
    const item = this.database
      .prepare(
        `SELECT transfer_job_id, playback_state FROM program_queue_items
         WHERE id = ? AND queue_id = ? AND playback_state != 'removed'`,
      )
      .get(itemId, queueId) as
      | {
          readonly transfer_job_id: string | null;
          readonly playback_state: string;
        }
      | undefined;
    if (!item) throw notFound("节目单项目不存在");
    if (item.playback_state === "current") {
      throw conflict("PROGRAM_CURRENT_ITEM", "正在放映的项目不能移除");
    }
    const timestamp = this.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE program_queue_items SET playback_state = 'removed',
                  finished_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, timestamp, itemId);
      const remaining = this.database
        .prepare(
          `SELECT id FROM program_queue_items WHERE queue_id = ?
           AND playback_state != 'removed' ORDER BY position`,
        )
        .all(queueId) as Array<{ readonly id: string }>;
      const update = this.database.prepare(
        "UPDATE program_queue_items SET position = ?, updated_at = ? WHERE id = ?",
      );
      remaining.forEach((entry, index) =>
        update.run(index, timestamp, entry.id),
      );
      this.bumpQueue(queueId, timestamp);
    })();
    if (item.transfer_job_id) {
      const other = this.database
        .prepare(
          `SELECT 1 FROM program_queue_items
           WHERE transfer_job_id = ? AND playback_state != 'removed' LIMIT 1`,
        )
        .get(item.transfer_job_id);
      if (!other) {
        try {
          this.taskService.requestTransferCancellation(item.transfer_job_id);
        } catch {
          // 已进入检片或已终态时不回滚节目单移除。
        }
      }
    }
    this.recomputeCacheProtection(queueId);
    return this.serializeQueue(this.requireQueue(queueId));
  }

  public setItemPinned(
    queueId: string,
    itemId: string,
    expectedRevision: number,
    pinned: boolean,
  ): ProgramQueue {
    const queue = this.requireQueue(queueId);
    if (queue.revision !== expectedRevision) {
      throw conflict("PROGRAM_REVISION_CONFLICT", "节目单版本已经变化", {
        currentRevision: queue.revision,
      });
    }
    const timestamp = this.now();
    const result = this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `UPDATE program_queue_items SET pinned = ?, updated_at = ?
           WHERE id = ? AND queue_id = ? AND playback_state != 'removed'`,
        )
        .run(pinned ? 1 : 0, timestamp, itemId, queueId);
      if (changed.changes !== 1) throw notFound("节目单项目不存在");
      this.database
        .prepare(
          `UPDATE edge_cache_replicas
           SET pinned = ?, state = CASE WHEN ? = 1 THEN 'protected' ELSE state END,
               protected_reason = CASE WHEN ? = 1 THEN 'program-pin' ELSE protected_reason END,
               row_version = row_version + 1, updated_at = ?
           WHERE transfer_job_id = (
             SELECT transfer_job_id FROM program_queue_items WHERE id = ?
           )`,
        )
        .run(pinned ? 1 : 0, pinned ? 1 : 0, pinned ? 1 : 0, timestamp, itemId);
      this.bumpQueue(queueId, timestamp);
      return changed.changes;
    })();
    if (result !== 1) throw notFound("节目单项目不存在");
    this.recomputeCacheProtection(queueId);
    return this.serializeQueue(this.requireQueue(queueId));
  }

  public activateWithinRoomTransaction(
    roomId: string,
    command: ActivateProgramQueueItemCommand,
    effectiveAt: number,
  ): {
    readonly mode: "vod";
    readonly mediaId: string;
    readonly transport: TransportAnchor;
    readonly programQueueId: string;
    readonly programItemId: string;
  } {
    const timestamp = this.now();
    const item = this.database
      .prepare(
        `SELECT i.id, i.queue_id, i.media_id, i.display_name,
                i.preparation_state, i.playback_state, i.position,
                m.duration_ms
         FROM program_queue_items i
         LEFT JOIN media m ON m.id = i.media_id
         JOIN program_queues q ON q.id = i.queue_id AND q.state = 'active'
         WHERE i.id = ? AND i.queue_id = ?`,
      )
      .get(command.programItemId, command.programQueueId) as
      | {
          readonly id: string;
          readonly queue_id: string;
          readonly media_id: string | null;
          readonly display_name: string;
          readonly preparation_state: string;
          readonly playback_state: string;
          readonly position: number;
          readonly duration_ms: number | null;
        }
      | undefined;
    if (!item) throw notFound("节目单项目不存在");
    if (item.preparation_state !== "ready" || !item.media_id) {
      throw conflict("PROGRAM_ITEM_NOT_READY", "该影片尚未准备完成");
    }
    const current = this.database
      .prepare(
        `SELECT i.id, i.position, h.id AS history_id, h.duration_ms,
                h.covered_ms
         FROM program_queue_items i
         LEFT JOIN program_play_history h
           ON h.program_item_id = i.id AND h.departed_at IS NULL
         WHERE i.queue_id = ? AND i.playback_state = 'current' LIMIT 1`,
      )
      .get(item.queue_id) as
      | {
          readonly id: string;
          readonly position: number;
          readonly history_id: string | null;
          readonly duration_ms: number | null;
          readonly covered_ms: number | null;
        }
      | undefined;
    if (current?.id === item.id) {
      throw conflict("PROGRAM_ITEM_ALREADY_CURRENT", "该影片已经是当前节目");
    }
    if (current) {
      const coveredRatio =
        current.duration_ms && current.duration_ms > 0
          ? Math.min(1, (current.covered_ms ?? 0) / current.duration_ms)
          : 0;
      if (coveredRatio < COMPLETION_RATIO && !command.departureDecision) {
        throw conflict(
          "PROGRAM_DEPARTURE_DECISION_REQUIRED",
          "当前影片观看不足 90%，请选择确认看完或继续保留未完成状态",
          { coveredRatio },
        );
      }
      const completionKind =
        coveredRatio >= COMPLETION_RATIO
          ? "automatic"
          : command.departureDecision === "confirm-complete"
            ? "manual"
            : "incomplete";
      this.database
        .prepare(
          `UPDATE program_queue_items
           SET playback_state = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          completionKind === "incomplete" ? "incomplete" : "completed",
          timestamp,
          timestamp,
          current.id,
        );
      if (current.history_id) {
        this.database
          .prepare(
            `UPDATE program_play_history
             SET completion_kind = ?, departed_at = ?, completed_at = ?
             WHERE id = ?`,
          )
          .run(
            completionKind,
            timestamp,
            completionKind === "incomplete" ? null : timestamp,
            current.history_id,
          );
      }
    }
    this.database
      .prepare(
        `UPDATE program_queue_items
         SET playback_state = 'current', activated_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, timestamp, item.id);
    const sequence = this.database
      .prepare(
        `SELECT COALESCE(MAX(activation_sequence), 0) + 1 AS sequence
         FROM program_play_history WHERE queue_id = ?`,
      )
      .get(item.queue_id) as { readonly sequence: number };
    this.database
      .prepare(
        `INSERT INTO program_play_history(
           id, queue_id, program_item_id, room_id, media_id, display_name,
           activation_sequence, duration_ms, covered_ms,
           last_progress_sequence, last_position_ms, last_sampled_at_ms,
           last_playing, last_rate, completion_kind, activated_at,
           departed_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, -1, NULL, NULL, NULL, NULL,
                   NULL, ?, NULL, NULL)`,
      )
      .run(
        uuidv7(),
        item.queue_id,
        item.id,
        roomId,
        item.media_id,
        item.display_name,
        sequence.sequence,
        item.duration_ms,
        timestamp,
      );
    this.bumpQueue(item.queue_id, timestamp);
    this.recomputeCacheProtection(item.queue_id);
    return {
      mode: "vod",
      mediaId: item.media_id,
      transport: {
        state: "paused",
        positionSec: 0,
        rate: 1,
        anchoredAtServerMs: effectiveAt,
      },
      programQueueId: item.queue_id,
      programItemId: item.id,
    };
  }

  public recordProgress(roomId: string, progress: PlaybackProgress): void {
    const state = this.database
      .prepare(
        `SELECT revision, media_id, program_queue_id, current_program_item_id
         FROM room_state WHERE room_id = ?`,
      )
      .get(roomId) as
      | {
          readonly revision: number;
          readonly media_id: string | null;
          readonly program_queue_id: string | null;
          readonly current_program_item_id: string | null;
        }
      | undefined;
    if (
      !state ||
      state.revision !== progress.roomRevision ||
      state.media_id !== progress.mediaId ||
      state.program_queue_id !== progress.programQueueId ||
      state.current_program_item_id !== progress.programItemId
    ) {
      throw conflict("PLAYBACK_PROGRESS_STALE", "播放进度与当前节目不一致");
    }
    const history = this.database
      .prepare(
        `SELECT id, duration_ms, last_progress_sequence, last_position_ms,
                last_sampled_at_ms, last_playing, last_rate
         FROM program_play_history
         WHERE room_id = ? AND program_item_id = ? AND departed_at IS NULL
         ORDER BY activation_sequence DESC LIMIT 1`,
      )
      .get(roomId, progress.programItemId) as
      | {
          readonly id: string;
          readonly duration_ms: number | null;
          readonly last_progress_sequence: number;
          readonly last_position_ms: number | null;
          readonly last_sampled_at_ms: number | null;
          readonly last_playing: number | null;
          readonly last_rate: number | null;
        }
      | undefined;
    if (!history) throw notFound("当前节目缺少播放历史");
    if (progress.sequence <= history.last_progress_sequence) return;
    const positionMs = Math.max(
      0,
      Math.min(
        Math.round(progress.positionSec * 1000),
        history.duration_ms ?? Number.MAX_SAFE_INTEGER,
      ),
    );
    this.database.transaction(() => {
      if (
        history.last_playing === 1 &&
        history.last_position_ms !== null &&
        history.last_sampled_at_ms !== null
      ) {
        const elapsed = Math.max(
          0,
          progress.sampledAtClientMs - history.last_sampled_at_ms,
        );
        const delta = positionMs - history.last_position_ms;
        const maximumPlausible =
          elapsed * Math.max(history.last_rate ?? 1, progress.rate) + 2000;
        if (delta > 0 && delta <= maximumPlausible) {
          this.mergeWatchRange(
            history.id,
            history.last_position_ms,
            positionMs,
          );
        }
      }
      const covered = this.database
        .prepare(
          `SELECT COALESCE(SUM(range_end_ms - range_start_ms), 0) AS covered
           FROM program_watch_ranges WHERE play_history_id = ?`,
        )
        .get(history.id) as { readonly covered: number };
      this.database
        .prepare(
          `UPDATE program_play_history
           SET covered_ms = ?, last_progress_sequence = ?, last_position_ms = ?,
               last_sampled_at_ms = ?, last_playing = ?, last_rate = ?
           WHERE id = ?`,
        )
        .run(
          covered.covered,
          progress.sequence,
          positionMs,
          progress.sampledAtClientMs,
          progress.playing ? 1 : 0,
          progress.rate,
          history.id,
        );
    })();
  }

  public reconcilePrefetch(queueId: string, ownerAccountId: string): void {
    const current = this.database
      .prepare(
        `SELECT position FROM program_queue_items
         WHERE queue_id = ? AND playback_state = 'current'`,
      )
      .get(queueId) as { readonly position: number } | undefined;
    const incomplete = this.database
      .prepare(
        `SELECT id FROM program_queue_items
         WHERE queue_id = ? AND playback_state = 'incomplete'
         ORDER BY finished_at DESC, position LIMIT 1`,
      )
      .get(queueId) as { readonly id: string } | undefined;
    // 自动窗口永远只有两个槽位：首次为前两项；开始播放后为当前项和
    // 下一项。若 Host 保留了未完成影片，它占用第二个槽位并暂停继续预取。
    const prefetchLimit = current ? (incomplete ? 0 : 1) : 2;
    if (prefetchLimit === 0) {
      this.recomputeCacheProtection(queueId);
      return;
    }
    const targets = this.database
      .prepare(
        `WITH desired_window AS (
           SELECT id FROM program_queue_items
           WHERE queue_id = ? AND position > ?
             AND playback_state = 'upcoming'
           ORDER BY position LIMIT ?
         )
         SELECT i.id, i.catalog_version_id, i.position, v.bytes, v.mtime_ms,
                v.sha256, c.agent_id, c.local_id
         FROM desired_window desired
         JOIN program_queue_items i ON i.id = desired.id
         JOIN edge_catalog_versions v ON v.id = i.catalog_version_id
         JOIN edge_catalog_items c ON c.id = v.catalog_item_id
         WHERE i.preparation_state IN ('pending', 'evicted')
           AND c.source_state = 'present'
         ORDER BY i.position`,
      )
      .all(queueId, current?.position ?? -1, prefetchLimit) as Array<{
      readonly id: string;
      readonly catalog_version_id: string;
      readonly position: number;
      readonly bytes: number;
      readonly mtime_ms: number;
      readonly sha256: string | null;
      readonly agent_id: string;
      readonly local_id: string;
    }>;
    const timestamp = this.now();
    for (const target of targets) {
      const transferId = uuidv7();
      const created = this.database.transaction(() => {
        const existing = this.database
          .prepare(
            `SELECT id, state, media_id FROM edge_transfer_jobs
             WHERE catalog_version_id = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(target.catalog_version_id) as
          | {
              readonly id: string;
              readonly state: string;
              readonly media_id: string | null;
            }
          | undefined;
        if (existing?.state === "ready" && existing.media_id) {
          this.database
            .prepare(
              `UPDATE program_queue_items
               SET transfer_job_id = ?, media_id = ?, preparation_state = 'ready',
                   updated_at = ? WHERE id = ?`,
            )
            .run(existing.id, existing.media_id, timestamp, target.id);
          return null;
        }
        if (
          existing &&
          new Set([
            "queued",
            "leased",
            "validating",
            "uploading",
            "received",
            "processing",
          ]).has(existing.state)
        ) {
          this.database
            .prepare(
              `UPDATE program_queue_items
               SET transfer_job_id = ?, preparation_state = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              existing.id,
              toPreparationState(existing.state),
              timestamp,
              target.id,
            );
          return null;
        }
        this.database
          .prepare(
            `INSERT INTO edge_transfer_jobs(
               id, agent_id, catalog_version_id, owner_account_id, state,
               priority, declared_bytes, transferred_bytes, expected_sha256,
               upload_id, media_id, attempts, max_attempts, error_code,
               error_message, last_progress_at, created_at, updated_at,
               ready_at, finished_at
             ) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, NULL, NULL, 0, 1024,
                       NULL, NULL, NULL, ?, ?, NULL, NULL)`,
          )
          .run(
            transferId,
            target.agent_id,
            target.catalog_version_id,
            ownerAccountId,
            1000 - target.position,
            target.bytes,
            target.sha256,
            timestamp,
            timestamp,
          );
        this.database
          .prepare(
            `UPDATE program_queue_items
             SET transfer_job_id = ?, preparation_state = 'queued', updated_at = ?
             WHERE id = ?`,
          )
          .run(transferId, timestamp, target.id);
        return transferId;
      })();
      if (created) {
        this.taskService.enqueue(
          target.agent_id,
          {
            kind: "upload",
            edgeTransferId: created,
            catalogItemId: this.catalogItemId(target.catalog_version_id),
            catalogVersionId: target.catalog_version_id,
            localId: target.local_id,
            expectedBytes: target.bytes,
            expectedMtimeMs: target.mtime_ms,
            expectedSha256: target.sha256,
          },
          `edge-upload:${target.catalog_version_id}:${created}`,
          1000 - target.position,
        );
      }
    }
    this.recomputeCacheProtection(queueId);
  }

  public recomputeCacheProtection(queueId: string): void {
    const windowItems = this.database
      .prepare(
        `WITH current_item AS (
           SELECT id, position FROM program_queue_items
           WHERE queue_id = ? AND playback_state = 'current' LIMIT 1
         ), incomplete_item AS (
           SELECT id FROM program_queue_items
           WHERE queue_id = ? AND playback_state = 'incomplete'
           ORDER BY finished_at DESC, position LIMIT 1
         ), next_item AS (
           SELECT id FROM program_queue_items
           WHERE queue_id = ? AND playback_state = 'upcoming'
             AND position > COALESCE((SELECT position FROM current_item), -1)
           ORDER BY position LIMIT CASE
             WHEN EXISTS(SELECT 1 FROM incomplete_item) THEN 0
             WHEN EXISTS(SELECT 1 FROM current_item) THEN 1
             ELSE 2
           END
         )
         SELECT id FROM current_item
         UNION SELECT id FROM incomplete_item
         UNION SELECT id FROM next_item`,
      )
      .all(queueId, queueId, queueId) as Array<{ readonly id: string }>;
    const windowIds = new Set(windowItems.map((item) => item.id));
    const timestamp = this.now();
    const replicas = this.database
      .prepare(
        `SELECT r.id, r.state, r.pinned, r.protected_reason,
                i.id AS program_item_id, i.pinned AS item_pinned
         FROM edge_cache_replicas r
         JOIN program_queue_items i ON i.transfer_job_id = r.transfer_job_id
         WHERE i.queue_id = ?
           AND r.state IN ('ready', 'eligible', 'protected')`,
      )
      .all(queueId) as Array<{
      readonly id: string;
      readonly state: string;
      readonly pinned: number;
      readonly protected_reason: string | null;
      readonly program_item_id: string;
      readonly item_pinned: number;
    }>;
    const update = this.database.prepare(
      `UPDATE edge_cache_replicas
       SET state = ?, protected_reason = ?, row_version = row_version + 1,
           updated_at = ? WHERE id = ?`,
    );
    for (const replica of replicas) {
      const manuallyPinned = replica.pinned === 1 || replica.item_pinned === 1;
      const protectedByWindow = windowIds.has(replica.program_item_id);
      const nextState =
        manuallyPinned || protectedByWindow ? "protected" : "eligible";
      const nextReason = manuallyPinned
        ? "program-pin"
        : protectedByWindow
          ? "program-window"
          : null;
      if (
        replica.state !== nextState ||
        replica.protected_reason !== nextReason
      ) {
        update.run(nextState, nextReason, timestamp, replica.id);
      }
    }
  }

  public recomputeActiveProtection(): void {
    const queue = this.findActiveQueue();
    if (queue) this.recomputeCacheProtection(queue.id);
  }

  public reconcileRoomBindings(): number {
    const stale = this.database
      .prepare(
        `SELECT s.room_id, s.program_queue_id, s.current_program_item_id,
                i.queue_id AS item_queue_id
         FROM room_state s
         LEFT JOIN program_queue_items i ON i.id = s.current_program_item_id
         WHERE s.current_program_item_id IS NOT NULL AND (
           s.program_queue_id IS NULL OR i.id IS NULL
           OR i.queue_id IS NOT s.program_queue_id
           OR i.media_id IS NULL OR i.media_id IS NOT s.media_id
           OR i.playback_state != 'current' OR s.mode != 'vod'
         )`,
      )
      .all() as Array<{
      readonly room_id: string;
      readonly program_queue_id: string | null;
      readonly current_program_item_id: string;
      readonly item_queue_id: string | null;
    }>;
    const affectedQueues = new Set<string>();
    for (const binding of stale) {
      const timestamp = this.now();
      this.database.transaction(() => {
        this.database
          .prepare(
            `UPDATE program_queue_items
             SET playback_state = 'incomplete', finished_at = ?, updated_at = ?
             WHERE id = ? AND playback_state = 'current'`,
          )
          .run(timestamp, timestamp, binding.current_program_item_id);
        this.database
          .prepare(
            `UPDATE program_play_history
             SET completion_kind = 'incomplete', departed_at = ?
             WHERE program_item_id = ? AND departed_at IS NULL`,
          )
          .run(timestamp, binding.current_program_item_id);
        this.database
          .prepare(
            `UPDATE room_state
             SET program_queue_id = NULL, current_program_item_id = NULL,
                 updated_at = ? WHERE room_id = ?`,
          )
          .run(timestamp, binding.room_id);
        const queueId = binding.item_queue_id ?? binding.program_queue_id;
        if (queueId) {
          this.bumpQueue(queueId, timestamp);
          affectedQueues.add(queueId);
        }
      })();
    }
    for (const queueId of affectedQueues)
      this.recomputeCacheProtection(queueId);
    return stale.length;
  }

  private mergeWatchRange(
    historyId: string,
    startMs: number,
    endMs: number,
  ): void {
    const ranges = this.database
      .prepare(
        `SELECT range_start_ms, range_end_ms FROM program_watch_ranges
         WHERE play_history_id = ? ORDER BY range_start_ms`,
      )
      .all(historyId) as Array<{
      readonly range_start_ms: number;
      readonly range_end_ms: number;
    }>;
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of [
      ...ranges.map((row) => ({
        start: row.range_start_ms,
        end: row.range_end_ms,
      })),
      { start: startMs, end: endMs },
    ].sort((left, right) => left.start - right.start)) {
      const last = merged.at(-1);
      if (!last || range.start > last.end) merged.push({ ...range });
      else last.end = Math.max(last.end, range.end);
    }
    this.database
      .prepare("DELETE FROM program_watch_ranges WHERE play_history_id = ?")
      .run(historyId);
    const insert = this.database.prepare(
      `INSERT INTO program_watch_ranges(
         play_history_id, range_start_ms, range_end_ms, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const timestamp = this.now();
    for (const range of merged) {
      insert.run(historyId, range.start, range.end, timestamp, timestamp);
    }
  }

  private serializeQueue(queue: QueueRow): ProgramQueue {
    const items = this.database
      .prepare(
        `SELECT i.id, i.catalog_version_id, i.transfer_job_id, i.media_id,
                i.display_name, i.position, i.preparation_state,
                i.playback_state, i.pinned,
                h.id AS history_id, h.duration_ms, h.covered_ms,
                h.completion_kind
         FROM program_queue_items i
         LEFT JOIN program_play_history h ON h.id = (
           SELECT id FROM program_play_history
           WHERE program_item_id = i.id ORDER BY activation_sequence DESC LIMIT 1
         )
         WHERE i.queue_id = ? AND i.playback_state != 'removed'
         ORDER BY i.position`,
      )
      .all(queue.id) as Array<Record<string, unknown>>;
    const current = items.find((item) => item.playback_state === "current");
    return {
      id: queue.id,
      displayName: queue.display_name,
      state: queue.state,
      revision: queue.revision,
      currentItemId: typeof current?.id === "string" ? current.id : null,
      items: items.map((item) => {
        const historyId =
          typeof item.history_id === "string" ? item.history_id : null;
        const duration =
          typeof item.duration_ms === "number" ? item.duration_ms : null;
        const covered =
          typeof item.covered_ms === "number" ? item.covered_ms : 0;
        return {
          id: String(item.id),
          queueId: queue.id,
          catalogVersionId:
            typeof item.catalog_version_id === "string"
              ? item.catalog_version_id
              : null,
          transferId:
            typeof item.transfer_job_id === "string"
              ? item.transfer_job_id
              : null,
          mediaId: typeof item.media_id === "string" ? item.media_id : null,
          displayName: String(item.display_name),
          position: Number(item.position),
          preparationState:
            item.preparation_state as ProgramQueue["items"][number]["preparationState"],
          playbackState:
            item.playback_state as ProgramQueue["items"][number]["playbackState"],
          pinned: item.pinned === 1,
          watchCoverage: historyId
            ? {
                historyId,
                durationMs: duration,
                coveredMs: covered,
                coveredRatio:
                  duration && duration > 0
                    ? Math.min(1, covered / duration)
                    : 0,
                completed:
                  item.completion_kind === "automatic" ||
                  item.completion_kind === "manual",
                completionKind:
                  (item.completion_kind as
                    | "automatic"
                    | "manual"
                    | "incomplete"
                    | null) ?? null,
                ranges: this.database
                  .prepare(
                    `SELECT range_start_ms, range_end_ms
                     FROM program_watch_ranges WHERE play_history_id = ?
                     ORDER BY range_start_ms`,
                  )
                  .all(historyId)
                  .map((range) => ({
                    startMs: (range as { range_start_ms: number })
                      .range_start_ms,
                    endMs: (range as { range_end_ms: number }).range_end_ms,
                  })),
              }
            : null,
        };
      }),
      createdAt: new Date(queue.created_at).toISOString(),
      updatedAt: new Date(queue.updated_at).toISOString(),
    };
  }

  private findActiveQueue(): QueueRow | undefined {
    return this.database
      .prepare("SELECT * FROM program_queues WHERE state = 'active' LIMIT 1")
      .get() as QueueRow | undefined;
  }

  private requireQueue(queueId: string): QueueRow {
    const queue = this.database
      .prepare("SELECT * FROM program_queues WHERE id = ?")
      .get(queueId) as QueueRow | undefined;
    if (!queue) throw notFound("节目单不存在");
    return queue;
  }

  private bumpQueue(queueId: string, timestamp: number): void {
    this.database
      .prepare(
        `UPDATE program_queues SET revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, queueId);
  }

  private catalogItemId(versionId: string): string {
    const row = this.database
      .prepare("SELECT catalog_item_id FROM edge_catalog_versions WHERE id = ?")
      .get(versionId) as { readonly catalog_item_id: string } | undefined;
    if (!row) throw notFound("家庭片库版本不存在");
    return row.catalog_item_id;
  }
}

function toPreparationState(
  state: string,
): "queued" | "validating" | "uploading" | "processing" {
  if (state === "validating") return "validating";
  if (state === "uploading" || state === "received") return "uploading";
  if (state === "processing") return "processing";
  return "queued";
}
