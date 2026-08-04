import { createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { join, sep } from "node:path";

import { v7 as uuidv7 } from "uuid";

import type {
  EdgeTusCredential,
  UploadAuthorizeRequest,
} from "@simplewatch/contracts";
import {
  evaluateCompatibility,
  moveFile,
  sanitizeDisplayName,
  validateWebVtt,
} from "@simplewatch/media";

import type { AppDatabase } from "../database.js";
import { AppError, conflict, notFound, unauthorized } from "../errors.js";
import { createOpaqueToken, hashToken } from "../security.js";

interface MediaRow {
  readonly id: string;
  readonly storage_key: string;
  readonly display_name: string;
  readonly state:
    | "scanning"
    | "compatible"
    | "incompatible"
    | "failed"
    | "published";
  readonly bytes: number;
  readonly mime: string | null;
  readonly duration_ms: number | null;
  readonly video_codec: "h264" | "hevc" | null;
  readonly playback_support: "broad" | "device-dependent" | "unsupported";
  readonly video_width: number | null;
  readonly video_height: number | null;
  readonly video_fps: number | null;
  readonly video_pixel_format: string | null;
  readonly probe_json: string | null;
  readonly created_at: number;
}

interface UploadRow {
  readonly id: string;
  readonly owner_admin_id: string;
  readonly state:
    | "authorized"
    | "uploading"
    | "received"
    | "scanning"
    | "compatible"
    | "incompatible"
    | "failed"
    | "published"
    | "cancelled";
  readonly filename: string;
  readonly mime: string;
  readonly declared_bytes: number;
  readonly received_bytes: number;
  readonly expires_at: number;
  readonly edge_job_id: string | null;
}

interface JobRow {
  readonly id: string;
  readonly media_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly attempts: number;
}

interface WorkerHeartbeatRow {
  readonly worker_id: string;
  readonly status: "idle" | "busy" | "degraded";
  readonly current_job_id: string | null;
  readonly last_error: string | null;
  readonly started_at: number;
  readonly last_seen_at: number;
}

const JOB_LEASE_MILLISECONDS = 60_000;
const WORKER_FRESHNESS_MILLISECONDS = 60_000;
const MAX_JOB_ATTEMPTS = 5;
const STORAGE_SAFETY_FLOOR_BYTES = 12 * 1024 * 1024 * 1024;

export interface MediaServiceOptions {
  readonly mediaRoot: string;
  readonly uploadRoot: string;
  readonly inboxRoot: string;
  readonly subtitleRoot: string;
  readonly trashRoot: string;
  readonly tusEndpoint: string;
  readonly contentSigningSecret: string;
  readonly now?: () => number;
}

export interface ContentIdentity {
  readonly sessionHash: string;
  readonly expiresAt: number;
  readonly kind: "admin" | "room";
  readonly roomId?: string;
}

export class MediaService {
  private readonly now: () => number;

  public constructor(
    private readonly database: AppDatabase,
    private readonly options: MediaServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    mkdirSync(options.mediaRoot, { recursive: true });
    mkdirSync(options.uploadRoot, { recursive: true });
    mkdirSync(options.inboxRoot, { recursive: true });
    mkdirSync(options.subtitleRoot, { recursive: true });
    mkdirSync(options.trashRoot, { recursive: true });
  }

  public listMedia() {
    this.purgeExpiredTrash();
    const rows = this.database
      .prepare(
        `SELECT id, storage_key, display_name, state, bytes, mime, duration_ms, created_at,
                video_codec, playback_support, video_width, video_height,
                video_fps, video_pixel_format, probe_json
         FROM media WHERE trashed_at IS NULL ORDER BY created_at DESC`,
      )
      .all() as MediaRow[];
    return rows.map((row) => this.serializeMediaWithSubtitles(row));
  }

  private purgeExpiredTrash(): void {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    const rows = this.database
      .prepare(
        "SELECT id, storage_key, trashed_at FROM media WHERE trashed_at IS NOT NULL AND trashed_at <= ?",
      )
      .all(cutoff) as Array<{
      id: string;
      storage_key: string;
      trashed_at: number;
    }>;
    for (const row of rows) {
      const activeReference = this.database
        .prepare(
          `SELECT 1 FROM room_state s
           JOIN rooms r ON r.id = s.room_id
           WHERE r.status = 'active' AND s.media_id = ?`,
        )
        .get(row.id);
      if (activeReference) continue;

      const subtitles = this.database
        .prepare("SELECT storage_key FROM subtitles WHERE media_id = ?")
        .all(row.id) as Array<{ storage_key: string }>;
      rmSync(
        join(this.options.trashRoot, `${row.storage_key}-${row.trashed_at}`),
        {
          recursive: true,
          force: true,
        },
      );
      rmSync(join(this.options.mediaRoot, row.storage_key), {
        recursive: true,
        force: true,
      });
      rmSync(join(this.options.inboxRoot, row.storage_key), {
        recursive: true,
        force: true,
      });
      for (const subtitle of subtitles) {
        rmSync(join(this.options.subtitleRoot, `${subtitle.storage_key}.vtt`), {
          force: true,
        });
      }
      this.database.transaction(() => {
        this.database
          .prepare(
            `UPDATE room_state SET media_id = NULL, transport_json = NULL
             WHERE media_id = ? AND room_id IN (
               SELECT id FROM rooms WHERE status = 'closed'
             )`,
          )
          .run(row.id);
        this.database
          .prepare("DELETE FROM media_jobs WHERE media_id = ?")
          .run(row.id);
        this.database.prepare("DELETE FROM media WHERE id = ?").run(row.id);
      })();
    }
  }

  public getMedia(mediaId: string) {
    return this.serializeMediaWithSubtitles(this.getMediaRow(mediaId));
  }

  public trashMedia(adminId: string, mediaId: string): void {
    void adminId;
    const row = this.getMediaRow(mediaId);
    const activeReference = this.database
      .prepare(
        `SELECT 1 FROM room_state s
         JOIN rooms r ON r.id = s.room_id
         WHERE r.status = 'active' AND s.media_id = ?`,
      )
      .get(row.id);
    if (activeReference) {
      throw conflict(
        "MEDIA_IN_USE",
        "当前放映室正在使用这条影片，请先换片或关闭房间",
      );
    }

    const trashedAt = this.now();
    const source = storedFinalPath(row.probe_json);
    let safeSource: string | null = null;
    let destination: string | null = null;
    if (source && existsSync(source)) {
      safeSource = requirePathWithinAny(source, [
        this.options.mediaRoot,
        this.options.inboxRoot,
        this.options.uploadRoot,
      ]);
      destination = join(
        this.options.trashRoot,
        `${row.storage_key}-${trashedAt}`,
      );
      try {
        moveFile(safeSource, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        safeSource = null;
        destination = null;
      }
    }
    try {
      this.database
        .prepare("UPDATE media SET trashed_at = ? WHERE id = ?")
        .run(trashedAt, row.id);
    } catch (error) {
      if (safeSource && destination) moveFile(destination, safeSource);
      throw error;
    }
    rmSync(join(this.options.mediaRoot, row.storage_key), {
      recursive: true,
      force: true,
    });
    rmSync(join(this.options.inboxRoot, row.storage_key), {
      recursive: true,
      force: true,
    });
  }

  public rescanMedia(adminId: string, mediaId: string): { jobId: string } {
    void adminId;
    const row = this.getMediaRow(mediaId);
    if (row.state !== "incompatible")
      throw conflict("MEDIA_NOT_RESCANNABLE", "只有待兼容影片可以重新检片");
    const filePath = storedFinalPath(row.probe_json);
    if (!filePath) throw conflict("MEDIA_SOURCE_MISSING", "找不到原始影片文件");
    requirePathWithin(filePath, this.options.inboxRoot);
    const jobId = uuidv7();
    const now = this.now();
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE media SET state = 'scanning' WHERE id = ?")
        .run(row.id);
      this.database
        .prepare(
          `INSERT INTO media_jobs(
            id, media_id, kind, state, attempts, not_before, lease_until,
            error_code, created_at, updated_at, payload_json
          ) VALUES (?, ?, 'probe', 'pending', 0, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          jobId,
          row.id,
          now,
          now,
          now,
          JSON.stringify({
            filePath,
            storageKey: row.storage_key,
            source: "sftp",
          }),
        );
    })();
    return { jobId };
  }

  public createSubtitleJob(
    mediaId: string,
    input: {
      readonly language: string;
      readonly label: string;
      readonly content: string;
    },
  ) {
    const media = this.getMediaRow(mediaId);
    if (media.state !== "published")
      throw conflict("MEDIA_NOT_READY", "媒体尚未发布");
    const content = validateWebVtt(input.content);
    const jobId = uuidv7();
    const storageKey = createOpaqueToken(32);
    const now = this.now();
    this.database
      .prepare(
        `INSERT INTO media_jobs(
          id, media_id, kind, state, attempts, not_before, lease_until,
          error_code, created_at, updated_at, payload_json
        ) VALUES (?, ?, 'subtitle', 'pending', 0, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        jobId,
        mediaId,
        now,
        now,
        now,
        JSON.stringify({
          storageKey,
          language: input.language,
          label: input.label,
          contentBase64: Buffer.from(content).toString("base64"),
        }),
      );
    return { jobId };
  }

  public importSftpFile(input: {
    readonly filename: string;
    readonly filePath: string;
    readonly bytes: number;
  }) {
    const displayName = sanitizeDisplayName(input.filename);
    const safePath = requirePathWithin(input.filePath, this.options.inboxRoot);
    const existing = this.database
      .prepare("SELECT id FROM media WHERE source_path = ?")
      .get(safePath) as { id: string } | undefined;
    if (existing) return { mediaId: existing.id };
    const mediaId = uuidv7();
    const jobId = uuidv7();
    const storageKey = createOpaqueToken(32);
    const now = this.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO media(
            id, storage_key, display_name, state, bytes, sha256,
            mime, probe_json, duration_ms, created_at, trashed_at, source_path
          ) VALUES (?, ?, ?, 'scanning', ?, NULL, 'video/mp4', NULL, NULL, ?, NULL, ?)`,
        )
        .run(mediaId, storageKey, displayName, input.bytes, now, safePath);
      this.database
        .prepare(
          `INSERT INTO media_jobs(
            id, media_id, kind, state, attempts, not_before, lease_until,
            error_code, created_at, updated_at, payload_json
          ) VALUES (?, ?, 'probe', 'pending', 0, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          jobId,
          mediaId,
          now,
          now,
          now,
          JSON.stringify({ filePath: safePath, storageKey, source: "sftp" }),
        );
      this.database
        .prepare(
          `INSERT INTO audit_events(id, actor_kind, actor_id, action, target_id, outcome, created_at)
           VALUES (?, 'service', 'worker', 'sftp.import', ?, 'queued', ?)`,
        )
        .run(uuidv7(), mediaId, now);
    })();
    return { mediaId, jobId };
  }

  public completeSubtitleJob(
    jobId: string,
    leaseToken: string,
    result: {
      readonly finalPath: string;
      readonly sha256: string;
      readonly bytes: number;
    },
  ): void {
    const now = this.now();
    this.database.transaction(() => {
      const job = this.database
        .prepare(
          `SELECT media_id, payload_json FROM media_jobs
           WHERE id = ? AND kind = 'subtitle' AND state = 'leased'
             AND lease_token_hash = ? AND lease_until > ?`,
        )
        .get(jobId, hashToken(leaseToken), now) as
        | { readonly media_id: string; readonly payload_json: string }
        | undefined;
      if (!job) throw conflict("JOB_LEASE_EXPIRED", "任务租约已失效");
      requirePathWithin(result.finalPath, this.options.subtitleRoot);
      const payload = JSON.parse(job.payload_json) as {
        storageKey: string;
        language: string;
        label: string;
      };
      this.database
        .prepare(
          `INSERT INTO subtitles(id, media_id, storage_key, language, label, format, created_at)
           VALUES (?, ?, ?, ?, ?, 'webvtt', ?)`,
        )
        .run(
          uuidv7(),
          job.media_id,
          payload.storageKey,
          payload.language,
          payload.label,
          now,
        );
      this.database
        .prepare(
          `UPDATE media_jobs SET state = 'completed', lease_until = NULL,
             lease_token_hash = NULL, worker_id = NULL, progress_json = ?,
             error_code = NULL, error_message = NULL, finished_at = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify({ sha256: result.sha256, bytes: result.bytes }),
          now,
          now,
          jobId,
        );
    })();
  }

  public readSubtitle(identity: ContentIdentity, subtitleId: string): string {
    const subtitle = this.database
      .prepare("SELECT media_id, storage_key FROM subtitles WHERE id = ?")
      .get(subtitleId) as
      | { readonly media_id: string; readonly storage_key: string }
      | undefined;
    if (!subtitle) throw notFound("字幕不存在");
    this.requireMediaAccess(identity, subtitle.media_id);
    return readFileSync(
      join(this.options.subtitleRoot, `${subtitle.storage_key}.vtt`),
      "utf8",
    );
  }

  public requireAccess(identity: ContentIdentity, mediaId: string): void {
    this.getMediaRow(mediaId);
    this.requireMediaAccess(identity, mediaId);
  }

  public authorizeUpload(adminId: string, input: UploadAuthorizeRequest) {
    const filename = sanitizeDisplayName(input.filename);
    const id = uuidv7();
    const token = createOpaqueToken();
    const createdAt = this.now();
    const expiresAt = createdAt + 60 * 60 * 1000;
    this.database
      .transaction(() => {
        const reserved = this.database
          .prepare(
            `SELECT COALESCE(SUM(reserved_bytes), 0) AS total FROM uploads
             WHERE reserved_bytes > 0`,
          )
          .get() as { readonly total: number };
        const disk = statfsSync(this.options.uploadRoot);
        const availableBytes = disk.bavail * disk.bsize;
        const requiredReserve = input.bytes * 2;
        if (
          availableBytes - reserved.total - requiredReserve <
          STORAGE_SAFETY_FLOOR_BYTES
        ) {
          throw new AppError(507, "INSUFFICIENT_STORAGE", "磁盘空间不足");
        }
        this.database
          .prepare(
            `INSERT INTO uploads(
            id, owner_admin_id, state, declared_bytes, reserved_bytes,
            received_bytes, tus_id, source, expires_at, error_code,
            created_at, finished_at, filename, mime, upload_token_hash
          ) VALUES (?, ?, 'authorized', ?, ?, 0, NULL, 'tus', ?, NULL, ?, NULL, ?, ?, ?)`,
          )
          .run(
            id,
            adminId,
            input.bytes,
            requiredReserve,
            expiresAt,
            createdAt,
            filename,
            input.mime,
            hashToken(token),
          );
        this.database
          .prepare(
            `INSERT INTO token_jti(jti_hash, kind, subject_id, expires_at, revoked_at)
           VALUES (?, 'upload', ?, ?, NULL)`,
          )
          .run(hashToken(token), id, expiresAt);
      })
      .immediate();

    return {
      uploadId: id,
      tusEndpoint: this.options.tusEndpoint,
      uploadToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      maxChunkBytes: 16 * 1024 * 1024,
    };
  }

  public getUpload(adminId: string, uploadId: string) {
    const row = this.database
      .prepare(
        `SELECT id, owner_admin_id, state, filename, mime, declared_bytes,
                received_bytes, expires_at
         FROM uploads WHERE id = ? AND owner_admin_id = ?`,
      )
      .get(uploadId, adminId) as UploadRow | undefined;
    if (!row) throw notFound("上传不存在");
    return serializeUpload(row);
  }

  public authorizeEdgeUpload(input: {
    readonly edgeTransferId: string;
    readonly agentId: string;
    readonly taskId: string;
    readonly taskAttempt: number;
    readonly ownerAccountId: string;
    readonly filename: string;
    readonly bytes: number;
    readonly mime: string;
    readonly sourceSha256?: string;
  }): EdgeTusCredential {
    const filename = sanitizeDisplayName(input.filename);
    const timestamp = this.now();
    const credentialExpiresAt = timestamp + 20 * 60 * 1000;
    const refreshAfter = timestamp + 10 * 60 * 1000;
    const token = `swupload_v1_${createOpaqueToken(32)}`;
    let uploadId = "";
    let existingUpload = false;
    this.database.transaction(() => {
      const transfer = this.database
        .prepare(
          `SELECT t.id, t.agent_id, t.declared_bytes, t.upload_id, t.state,
                  t.expected_sha256, u.tus_id, a.enabled AS agent_enabled,
                  a.revoked_at AS agent_revoked_at, task.state AS task_state,
                  task.attempts AS task_attempt, task.lease_until AS task_lease_until
           FROM edge_transfer_jobs t
           LEFT JOIN uploads u ON u.id = t.upload_id
           JOIN edge_agents a ON a.id = t.agent_id
           JOIN edge_agent_tasks task ON task.id = ? AND task.agent_id = t.agent_id
           WHERE t.id = ?`,
        )
        .get(input.taskId, input.edgeTransferId) as
        | {
            readonly id: string;
            readonly agent_id: string | null;
            readonly declared_bytes: number;
            readonly upload_id: string | null;
            readonly state: string;
            readonly expected_sha256: string | null;
            readonly tus_id: string | null;
            readonly agent_enabled: number;
            readonly agent_revoked_at: number | null;
            readonly task_state: string;
            readonly task_attempt: number;
            readonly task_lease_until: number | null;
          }
        | undefined;
      if (!transfer || transfer.agent_id !== input.agentId) {
        throw notFound("Edge 传输任务不存在");
      }
      if (
        transfer.agent_enabled !== 1 ||
        transfer.agent_revoked_at !== null ||
        transfer.task_state !== "leased" ||
        transfer.task_attempt !== input.taskAttempt ||
        transfer.task_lease_until === null ||
        transfer.task_lease_until <= timestamp
      ) {
        throw conflict("EDGE_TASK_LEASE_EXPIRED", "Edge任务租约已失效");
      }
      if (transfer.declared_bytes !== input.bytes) {
        throw conflict("EDGE_SOURCE_CHANGED", "家庭源文件大小已经改变");
      }
      if (
        new Set([
          "ready",
          "cancel_requested",
          "cancelled",
          "incompatible",
          "failed",
          "evicted",
        ]).has(transfer.state)
      ) {
        throw conflict("EDGE_TRANSFER_TERMINAL", "Edge 传输任务已经结束");
      }
      uploadId = transfer.upload_id ?? uuidv7();
      existingUpload = transfer.tus_id !== null;
      if (
        input.sourceSha256 &&
        transfer.expected_sha256 &&
        input.sourceSha256 !== transfer.expected_sha256
      ) {
        throw conflict("EDGE_SOURCE_CHANGED", "家庭源文件摘要已经改变");
      }
      if (!transfer.upload_id) {
        const requiredReserve = input.bytes * 2;
        this.requireStorageReservation(requiredReserve);
        this.database
          .prepare(
            `INSERT INTO uploads(
               id, owner_admin_id, state, declared_bytes, reserved_bytes,
               received_bytes, tus_id, source, expires_at, error_code,
               created_at, finished_at, filename, mime, upload_token_hash,
               edge_job_id
             ) VALUES (?, ?, 'authorized', ?, ?, 0, NULL, 'tus', ?, NULL,
                       ?, NULL, ?, ?, NULL, ?)`,
          )
          .run(
            uploadId,
            input.ownerAccountId,
            input.bytes,
            requiredReserve,
            timestamp + 2 * 60 * 60 * 1000,
            timestamp,
            filename,
            input.mime,
            input.edgeTransferId,
          );
        this.database
          .prepare(
            `UPDATE edge_transfer_jobs
             SET upload_id = ?, state = 'validating',
                 expected_sha256 = COALESCE(?, expected_sha256),
                 updated_at = ? WHERE id = ?`,
          )
          .run(
            uploadId,
            input.sourceSha256 ?? null,
            timestamp,
            input.edgeTransferId,
          );
      } else {
        this.database
          .prepare(
            `UPDATE edge_upload_credentials
             SET expires_at = MIN(expires_at, ?), overlap_until = ?
             WHERE edge_job_id = ? AND revoked_at IS NULL`,
          )
          .run(
            timestamp + 5 * 60 * 1000,
            timestamp + 5 * 60 * 1000,
            input.edgeTransferId,
          );
      }
      this.database
        .prepare(
          `INSERT INTO edge_upload_credentials(
             id_hash, edge_job_id, agent_id, task_id, task_attempt,
             upload_id, expires_at, overlap_until, last_used_at,
             created_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
        )
        .run(
          hashToken(token),
          input.edgeTransferId,
          input.agentId,
          input.taskId,
          input.taskAttempt,
          uploadId,
          credentialExpiresAt,
          timestamp,
        );
    })();
    return {
      edgeTransferId: input.edgeTransferId,
      uploadId,
      tusUrl: this.edgeTusUrl(uploadId, existingUpload),
      token,
      expiresAt: new Date(credentialExpiresAt).toISOString(),
      refreshAfter: new Date(refreshAfter).toISOString(),
      chunkBytes: 16 * 1024 * 1024,
    };
  }

  public cancelUpload(adminId: string, uploadId: string): void {
    const row = this.database
      .prepare("SELECT state FROM uploads WHERE id = ? AND owner_admin_id = ?")
      .get(uploadId, adminId) as { readonly state: string } | undefined;
    if (!row) throw notFound("上传不存在");
    if (row.state !== "cancelled") {
      const result = this.database
        .prepare(
          `UPDATE uploads SET state = 'cancelled', reserved_bytes = 0, finished_at = ?
           WHERE id = ? AND owner_admin_id = ?
             AND state IN ('authorized', 'uploading', 'received')`,
        )
        .run(this.now(), uploadId, adminId);
      if (result.changes !== 1)
        throw conflict(
          "UPLOAD_NOT_CANCELLABLE",
          "上传已进入检片阶段，无法取消",
        );
      this.database
        .prepare(
          "UPDATE token_jti SET revoked_at = ? WHERE kind = 'upload' AND subject_id = ?",
        )
        .run(this.now(), uploadId);
    }
    rmSync(join(this.options.uploadRoot, uploadId), { force: true });
    rmSync(join(this.options.uploadRoot, `${uploadId}.info`), { force: true });
  }

  public removeCancelledEdgeUploadFiles(edgeTransferId: string): void {
    const row = this.database
      .prepare(
        `SELECT id FROM uploads
         WHERE edge_job_id = ? AND state = 'cancelled'`,
      )
      .get(edgeTransferId) as { readonly id: string } | undefined;
    if (!row) return;
    rmSync(join(this.options.uploadRoot, row.id), { force: true });
    rmSync(join(this.options.uploadRoot, `${row.id}.info`), { force: true });
  }

  public validateUploadToken(uploadId: string, token: string): UploadRow {
    const row = this.findUploadByToken(token);
    if (
      row.id !== uploadId ||
      !new Set(["authorized", "uploading"]).has(row.state)
    ) {
      throw unauthorized("Upload Token 无效或已过期");
    }
    return row;
  }

  public handleTusHook(input: {
    readonly type: string;
    readonly uploadId?: string;
    readonly uploadToken?: string;
    readonly size?: number;
    readonly offset?: number;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Record<string, unknown> {
    if (!input.uploadToken) throw unauthorized("缺少 Upload-Token");
    const upload = this.findUploadByToken(input.uploadToken);
    if (input.uploadId && input.uploadId !== upload.id) {
      throw unauthorized("上传标识与 Token 不匹配");
    }

    if (input.type === "pre-create") {
      if (input.size !== upload.declared_bytes) {
        return tusRejected("上传大小与授权不一致");
      }
      if (
        input.metadata?.filename !== upload.filename ||
        input.metadata?.filetype !== upload.mime
      ) {
        return tusRejected("上传元数据与授权不一致");
      }
      return { ChangeFileInfo: { ID: upload.id } };
    }

    if (input.type === "post-create") {
      this.database
        .prepare(
          `UPDATE uploads SET state = 'uploading', tus_id = ?
           WHERE id = ? AND state = 'authorized'`,
        )
        .run(upload.id, upload.id);
      return {};
    }

    if (input.type === "post-receive") {
      const received = Math.min(input.offset ?? 0, upload.declared_bytes);
      const reserved =
        Math.max(0, upload.declared_bytes - received) + upload.declared_bytes;
      this.database
        .prepare(
          `UPDATE uploads
           SET state = 'uploading', received_bytes = ?, reserved_bytes = ?
           WHERE id = ? AND state IN ('authorized', 'uploading')`,
        )
        .run(received, reserved, upload.id);
      return {};
    }

    if (input.type === "post-finish") {
      if (!new Set(["authorized", "uploading"]).has(upload.state)) return {};
      this.completeUpload(
        upload.id,
        input.uploadToken,
        join(this.options.uploadRoot, upload.id),
        input.offset ?? upload.declared_bytes,
      );
      return {};
    }

    if (input.type === "post-terminate") {
      if (new Set(["authorized", "uploading"]).has(upload.state)) {
        this.database
          .prepare(
            `UPDATE uploads SET state = 'cancelled', reserved_bytes = 0, finished_at = ?
             WHERE id = ?`,
          )
          .run(this.now(), upload.id);
      }
      return {};
    }

    return {};
  }

  public authorizeTusRequest(
    token: string | undefined,
    originalUri: string,
    originalMethod: string,
  ): void {
    if (!token) throw unauthorized("缺少 Upload-Token");
    const upload = this.findUploadByToken(token);
    const method = originalMethod.toUpperCase();
    const active = new Set(["authorized", "uploading"]).has(upload.state);
    const completedHead = upload.state === "received" && method === "HEAD";
    if (!active && !completedHead) {
      throw unauthorized("上传已结束或已撤销");
    }
    const pathname = new URL(originalUri, "https://internal.invalid").pathname;
    const match = /^\/files\/([^/]+)\/?$/.exec(pathname);
    if (match?.[1] && match[1] !== upload.id) {
      throw unauthorized("上传标识与 Token 不匹配");
    }
  }

  public completeUpload(
    uploadId: string,
    token: string,
    filePath: string,
    receivedBytes: number,
  ) {
    const upload = this.validateUploadToken(uploadId, token);
    if (receivedBytes !== upload.declared_bytes) {
      throw conflict("UPLOAD_SIZE_MISMATCH", "实际上传大小与声明大小不一致");
    }
    const safePath = requirePathWithin(filePath, this.options.uploadRoot);
    const mediaId = uuidv7();
    const storageKey = createOpaqueToken(32);
    const jobId = uuidv7();
    const now = this.now();

    this.database.transaction(() => {
      const edgeTransfer = upload.edge_job_id
        ? (this.database
            .prepare(
              `SELECT expected_sha256 FROM edge_transfer_jobs WHERE id = ?`,
            )
            .get(upload.edge_job_id) as
            | { readonly expected_sha256: string | null }
            | undefined)
        : undefined;
      const jobNotBefore = upload.edge_job_id ? now + 24 * 60 * 60 * 1000 : now;
      this.database
        .prepare(
          `UPDATE uploads
           SET state = 'received', received_bytes = ?, reserved_bytes = declared_bytes,
               finished_at = ?
           WHERE id = ?`,
        )
        .run(receivedBytes, now, uploadId);
      this.database
        .prepare(
          `INSERT INTO media(
            id, storage_key, display_name, state, bytes, sha256,
            mime, probe_json, duration_ms, created_at, trashed_at
          ) VALUES (?, ?, ?, 'scanning', ?, NULL, ?, NULL, NULL, ?, NULL)`,
        )
        .run(
          mediaId,
          storageKey,
          upload.filename,
          receivedBytes,
          upload.mime,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO media_jobs(
            id, media_id, kind, state, attempts, not_before, lease_until,
            error_code, created_at, updated_at, payload_json
          ) VALUES (?, ?, 'probe', 'pending', 0, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          jobId,
          mediaId,
          jobNotBefore,
          now,
          now,
          JSON.stringify({
            uploadId,
            filePath: safePath,
            storageKey,
            ...(upload.edge_job_id ? { edgeJobId: upload.edge_job_id } : {}),
            ...(edgeTransfer?.expected_sha256
              ? { expectedSourceSha256: edgeTransfer.expected_sha256 }
              : {}),
          }),
        );
      this.database
        .prepare(
          "UPDATE token_jti SET revoked_at = ? WHERE kind = 'upload' AND subject_id = ?",
        )
        .run(now, uploadId);
      if (upload.edge_job_id) {
        this.database
          .prepare(
            `UPDATE edge_transfer_jobs
             SET state = 'received', upload_id = ?, media_id = ?,
                 transferred_bytes = declared_bytes, last_progress_at = ?,
                 updated_at = ? WHERE id = ?`,
          )
          .run(uploadId, mediaId, now, now, upload.edge_job_id);
        this.database
          .prepare(
            `UPDATE edge_upload_credentials
             SET expires_at = MIN(expires_at, ?), overlap_until = ?
             WHERE edge_job_id = ? AND revoked_at IS NULL`,
          )
          .run(now + 5 * 60 * 1000, now + 5 * 60 * 1000, upload.edge_job_id);
      }
    })();

    return { mediaId, jobId };
  }

  public claimJob(workerId: string) {
    const now = this.now();
    const leaseToken = createOpaqueToken();
    let claimed: JobRow | undefined;
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE media_jobs
           SET state = 'pending', attempts = 0, not_before = ?,
               lease_until = NULL, worker_id = NULL, lease_token_hash = NULL,
               error_code = 'LEGACY_RECOVERY',
               error_message = 'Granted one bounded recovery for a legacy lease without an error',
               updated_at = ?
           WHERE state = 'leased' AND lease_until <= ?
             AND attempts >= ? AND error_code IS NULL`,
        )
        .run(now, now, now, MAX_JOB_ATTEMPTS);
      this.finalizeExhaustedJobs(now);
      claimed = this.database
        .prepare(
          `SELECT id, media_id, kind, payload_json, attempts
           FROM media_jobs
           WHERE ((state = 'pending' AND not_before <= ?)
              OR (state = 'leased' AND lease_until <= ?))
             AND attempts < ?
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(now, now, MAX_JOB_ATTEMPTS) as JobRow | undefined;
      if (!claimed) return;
      this.database
        .prepare(
          `UPDATE media_jobs
           SET state = 'leased', attempts = attempts + 1, worker_id = ?,
               lease_token_hash = ?, lease_until = ?, error_message = NULL,
               finished_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          workerId,
          hashToken(leaseToken),
          now + JOB_LEASE_MILLISECONDS,
          now,
          claimed.id,
        );
    })();
    if (!claimed) return null;
    return {
      id: claimed.id,
      mediaId: claimed.media_id,
      kind: claimed.kind,
      payload: JSON.parse(claimed.payload_json) as unknown,
      leaseToken,
      leaseUntil: new Date(now + JOB_LEASE_MILLISECONDS).toISOString(),
      attempt: claimed.attempts + 1,
      maxAttempts: MAX_JOB_ATTEMPTS,
    };
  }

  public recordWorkerHeartbeat(input: {
    readonly workerId: string;
    readonly currentJobId?: string | null | undefined;
    readonly lastError?: string | null | undefined;
  }): void {
    const now = this.now();
    const currentJobId = input.currentJobId ?? null;
    const lastError = input.lastError?.trim().slice(0, 2048) || null;
    const status = currentJobId ? "busy" : lastError ? "degraded" : "idle";
    this.database
      .prepare(
        `INSERT INTO worker_heartbeats(
           worker_id, status, current_job_id, last_error, started_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           status = excluded.status,
           current_job_id = excluded.current_job_id,
           last_error = excluded.last_error,
           started_at = CASE
             WHEN worker_heartbeats.last_seen_at < excluded.last_seen_at - ?
               THEN excluded.started_at
             ELSE worker_heartbeats.started_at
           END,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        input.workerId,
        status,
        currentJobId,
        lastError,
        now,
        now,
        WORKER_FRESHNESS_MILLISECONDS,
      );
  }

  public getWorkerHealth(workerId?: string) {
    const row = (
      workerId
        ? this.database
            .prepare(
              `SELECT worker_id, status, current_job_id, last_error,
                    started_at, last_seen_at
             FROM worker_heartbeats WHERE worker_id = ?`,
            )
            .get(workerId)
        : this.database
            .prepare(
              `SELECT worker_id, status, current_job_id, last_error,
                    started_at, last_seen_at
             FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1`,
            )
            .get()
    ) as WorkerHeartbeatRow | undefined;
    if (!row) {
      return {
        health: "missing" as const,
        healthy: false,
        workerId: workerId ?? null,
        status: null,
        currentJobId: null,
        lastError: null,
        startedAt: null,
        lastSeenAt: null,
        ageMs: null,
      };
    }
    const ageMs = Math.max(0, this.now() - row.last_seen_at);
    const healthy = ageMs <= WORKER_FRESHNESS_MILLISECONDS;
    return {
      health: healthy ? ("healthy" as const) : ("stale" as const),
      healthy,
      workerId: row.worker_id,
      status: row.status,
      currentJobId: row.current_job_id,
      lastError: row.last_error,
      startedAt: new Date(row.started_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      ageMs,
    };
  }

  public heartbeatJob(
    jobId: string,
    leaseToken: string,
    progress: unknown,
  ): void {
    const now = this.now();
    const result = this.database
      .prepare(
        `UPDATE media_jobs SET lease_until = ?, progress_json = ?, updated_at = ?
         WHERE id = ? AND state = 'leased' AND lease_token_hash = ? AND lease_until > ?`,
      )
      .run(
        now + JOB_LEASE_MILLISECONDS,
        JSON.stringify(progress),
        now,
        jobId,
        hashToken(leaseToken),
        now,
      );
    if (result.changes !== 1)
      throw conflict("JOB_LEASE_EXPIRED", "任务租约已失效");
  }

  public failJob(
    jobId: string,
    leaseToken: string,
    error: string,
    errorCode = "WORKER_ERROR",
  ) {
    const now = this.now();
    const message = error.trim().slice(0, 2048) || "Worker task failed";
    let outcome:
      | {
          readonly state: "pending";
          readonly attempt: number;
          readonly maxAttempts: number;
          readonly retryAt: string;
        }
      | {
          readonly state: "failed";
          readonly attempt: number;
          readonly maxAttempts: number;
          readonly retryAt: null;
        };
    this.database.transaction(() => {
      const job = this.database
        .prepare(
          `SELECT id, media_id, kind, payload_json, attempts
           FROM media_jobs
           WHERE id = ? AND state = 'leased' AND lease_token_hash = ?
             AND lease_until > ?`,
        )
        .get(jobId, hashToken(leaseToken), now) as JobRow | undefined;
      if (!job) throw conflict("JOB_LEASE_EXPIRED", "任务租约已失效");
      if (job.attempts >= MAX_JOB_ATTEMPTS) {
        this.finalizeJobFailure(job, errorCode, message, now);
        outcome = {
          state: "failed",
          attempt: job.attempts,
          maxAttempts: MAX_JOB_ATTEMPTS,
          retryAt: null,
        };
        return;
      }
      const retryDelay = Math.min(
        5 * 60_000,
        5_000 * 2 ** Math.max(0, job.attempts - 1),
      );
      const retryAt = now + retryDelay;
      this.database
        .prepare(
          `UPDATE media_jobs
           SET state = 'pending', not_before = ?, lease_until = NULL,
               lease_token_hash = NULL, worker_id = NULL,
               error_code = ?, error_message = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(retryAt, errorCode, message, now, job.id);
      outcome = {
        state: "pending",
        attempt: job.attempts,
        maxAttempts: MAX_JOB_ATTEMPTS,
        retryAt: new Date(retryAt).toISOString(),
      };
    })();
    return outcome!;
  }

  private finalizeExhaustedJobs(now: number): void {
    const exhausted = this.database
      .prepare(
        `SELECT id, media_id, kind, payload_json, attempts
         FROM media_jobs
         WHERE attempts >= ?
           AND (state = 'pending' OR (state = 'leased' AND lease_until <= ?))`,
      )
      .all(MAX_JOB_ATTEMPTS, now) as JobRow[];
    for (const job of exhausted) {
      this.finalizeJobFailure(
        job,
        "MAX_ATTEMPTS_EXCEEDED",
        "任务超过最大重试次数",
        now,
      );
    }
  }

  private finalizeJobFailure(
    job: JobRow,
    errorCode: string,
    errorMessage: string,
    now: number,
  ): void {
    this.database
      .prepare(
        `UPDATE media_jobs
         SET state = 'failed', lease_until = NULL, lease_token_hash = NULL,
             worker_id = NULL, error_code = ?, error_message = ?,
             finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(errorCode, errorMessage, now, now, job.id);
    if (job.kind !== "probe") return;
    this.database
      .prepare(
        `UPDATE media SET state = 'failed'
         WHERE id = ? AND state = 'scanning'`,
      )
      .run(job.media_id);
    let uploadId: string | undefined;
    try {
      const payload = JSON.parse(job.payload_json) as { uploadId?: unknown };
      if (typeof payload.uploadId === "string") uploadId = payload.uploadId;
    } catch {
      // 终态失败仍需可记录；损坏的历史 payload 不应阻止队列继续领取。
    }
    if (uploadId) {
      const edgeUpload = this.database
        .prepare("SELECT edge_job_id FROM uploads WHERE id = ?")
        .get(uploadId) as { readonly edge_job_id: string | null } | undefined;
      this.database
        .prepare(
          `UPDATE uploads
           SET state = 'failed', error_code = ?, reserved_bytes = 0,
               finished_at = ?
           WHERE id = ?`,
        )
        .run(errorCode, now, uploadId);
      if (edgeUpload?.edge_job_id) {
        this.database
          .prepare(
            `UPDATE edge_transfer_jobs
             SET state = 'failed', error_code = ?, error_message = ?,
                 updated_at = ?, finished_at = ?
             WHERE id = ? AND state NOT IN ('ready', 'incompatible', 'evicted')`,
          )
          .run(errorCode, errorMessage, now, now, edgeUpload.edge_job_id);
        this.database
          .prepare(
            `UPDATE edge_upload_credentials
             SET revoked_at = COALESCE(revoked_at, ?)
             WHERE edge_job_id = ?`,
          )
          .run(now, edgeUpload.edge_job_id);
        this.database
          .prepare(
            `UPDATE program_queue_items
             SET preparation_state = 'failed', updated_at = ?
             WHERE transfer_job_id = ? AND preparation_state != 'ready'`,
          )
          .run(now, edgeUpload.edge_job_id);
        rmSync(join(this.options.uploadRoot, uploadId), { force: true });
        rmSync(join(this.options.uploadRoot, `${uploadId}.info`), {
          force: true,
        });
      }
    }
  }

  public completeJob(
    jobId: string,
    leaseToken: string,
    result: {
      readonly compatible: boolean;
      readonly probe: unknown;
      readonly reasons: readonly string[];
      readonly sha256: string;
      readonly sourceSha256?: string | undefined;
      readonly bytes: number;
      readonly durationMs: number | null;
      readonly finalPath: string;
    },
  ): void {
    const now = this.now();
    this.database.transaction(() => {
      const job = this.database
        .prepare(
          `SELECT id, media_id, payload_json FROM media_jobs
           WHERE id = ? AND state = 'leased' AND lease_token_hash = ? AND lease_until > ?`,
        )
        .get(jobId, hashToken(leaseToken), now) as
        | {
            readonly id: string;
            readonly media_id: string;
            readonly payload_json: string;
          }
        | undefined;
      if (!job) throw conflict("JOB_LEASE_EXPIRED", "任务租约已失效");
      const payload = JSON.parse(job.payload_json) as {
        readonly expectedSourceSha256?: unknown;
        readonly edgeJobId?: unknown;
      };
      if (
        typeof payload.expectedSourceSha256 === "string" &&
        result.sourceSha256 !== payload.expectedSourceSha256
      ) {
        throw conflict(
          "EDGE_SOURCE_MISMATCH",
          "云端收到的文件与家庭目录版本不一致",
        );
      }
      const compatibility = evaluateCompatibility(result.probe);
      const compatible = result.compatible && compatibility.compatible;
      requirePathWithin(
        result.finalPath,
        compatible ? this.options.mediaRoot : this.options.inboxRoot,
      );
      const state = compatible ? "published" : "incompatible";
      this.database
        .prepare(
          `UPDATE media
           SET state = ?, bytes = ?, sha256 = ?, probe_json = ?, duration_ms = ?,
               video_codec = ?, playback_support = ?, video_width = ?,
               video_height = ?, video_fps = ?, video_pixel_format = ?
           WHERE id = ?`,
        )
        .run(
          state,
          result.bytes,
          result.sha256,
          JSON.stringify({
            probe: result.probe,
            reasons: result.reasons,
            finalPath: result.finalPath,
            ...(result.sourceSha256
              ? { sourceSha256: result.sourceSha256 }
              : {}),
          }),
          result.durationMs,
          compatibility.video.codec,
          compatibility.playbackSupport,
          compatibility.video.width,
          compatibility.video.height,
          compatibility.video.fps,
          compatibility.video.pixelFormat,
          job.media_id,
        );
      this.database
        .prepare(
          `UPDATE media_jobs
           SET state = 'completed', lease_until = NULL, lease_token_hash = NULL,
               worker_id = NULL, error_code = NULL, error_message = NULL,
               finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, jobId);
      this.database
        .prepare(
          `UPDATE uploads SET state = ?, reserved_bytes = 0, finished_at = ?
           WHERE id = json_extract((SELECT payload_json FROM media_jobs WHERE id = ?), '$.uploadId')`,
        )
        .run(state, now, jobId);
      if (typeof payload.edgeJobId === "string") {
        this.database
          .prepare(
            `UPDATE edge_transfer_jobs
             SET state = ?, media_id = ?, expected_sha256 = ?,
                 transferred_bytes = declared_bytes, updated_at = ?,
                 ready_at = CASE WHEN ? = 'ready' THEN ? ELSE ready_at END,
                 finished_at = ?
             WHERE id = ?`,
          )
          .run(
            compatible ? "ready" : "incompatible",
            job.media_id,
            result.sourceSha256 ?? null,
            now,
            compatible ? "ready" : "incompatible",
            now,
            now,
            payload.edgeJobId,
          );
        if (compatible) {
          const transfer = this.database
            .prepare(
              `SELECT agent_id, catalog_version_id FROM edge_transfer_jobs
               WHERE id = ?`,
            )
            .get(payload.edgeJobId) as
            | {
                readonly agent_id: string | null;
                readonly catalog_version_id: string | null;
              }
            | undefined;
          this.database
            .prepare(
              `INSERT INTO edge_cache_replicas(
                 id, agent_id, catalog_version_id, transfer_job_id, media_id,
                 state, pinned, generation, row_version, source_sha256,
                 source_verified_at, protected_reason, created_at, updated_at,
                 evicted_at
               ) VALUES (?, ?, ?, ?, ?, 'ready', 0, 1, 0, ?, ?, NULL, ?, ?, NULL)`,
            )
            .run(
              uuidv7(),
              transfer?.agent_id ?? null,
              transfer?.catalog_version_id ?? null,
              payload.edgeJobId,
              job.media_id,
              result.sourceSha256 ?? null,
              now,
              now,
              now,
            );
        }
        this.database
          .prepare(
            `UPDATE program_queue_items
             SET media_id = ?, preparation_state = ?, updated_at = ?
             WHERE transfer_job_id = ?`,
          )
          .run(
            compatible ? job.media_id : null,
            compatible ? "ready" : "failed",
            now,
            payload.edgeJobId,
          );
      }
    })();
  }

  public createContentUrl(
    identity: ContentIdentity,
    mediaId: string,
    method: "GET" | "HEAD",
  ) {
    const media = this.getMediaRow(mediaId);
    if (!new Set(["compatible", "published"]).has(media.state)) {
      throw conflict("MEDIA_NOT_READY", "媒体尚未就绪");
    }
    this.requireMediaAccess(identity, mediaId);
    const expiresAt = Math.min(
      identity.expiresAt,
      this.now() + 12 * 60 * 60 * 1000,
    );
    const signature = this.signContent(
      method,
      identity.sessionHash,
      media.storage_key,
      expiresAt,
    );
    return `/media-files/${media.storage_key}/content.mp4?e=${expiresAt}&s=${signature}`;
  }

  public authorizeContent(
    identity: ContentIdentity,
    originalUri: string,
    method: "GET" | "HEAD",
  ): void {
    const url = new URL(originalUri, "https://internal.invalid");
    const match = /^\/media-files\/([a-z0-9_-]{40,})\/content\.mp4$/.exec(
      url.pathname,
    );
    const expiresAt = Number(url.searchParams.get("e"));
    const provided = url.searchParams.get("s");
    if (
      !match?.[1] ||
      !provided ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.now()
    ) {
      throw unauthorized("内容 URL 无效或已过期");
    }
    const media = this.database
      .prepare(
        "SELECT id, storage_key FROM media WHERE storage_key = ? AND trashed_at IS NULL",
      )
      .get(match[1]) as
      | { readonly id: string; readonly storage_key: string }
      | undefined;
    if (!media) throw notFound("媒体不存在");
    this.requireMediaAccess(identity, media.id);
    const expected = this.signContent(
      method,
      identity.sessionHash,
      media.storage_key,
      expiresAt,
    );
    if (!safeEqual(provided, expected)) throw unauthorized("内容签名无效");
  }

  private getMediaRow(mediaId: string): MediaRow {
    const row = this.database
      .prepare(
        `SELECT id, storage_key, display_name, state, bytes, mime, duration_ms, created_at,
                video_codec, playback_support, video_width, video_height,
                video_fps, video_pixel_format, probe_json
         FROM media WHERE id = ? AND trashed_at IS NULL`,
      )
      .get(mediaId) as MediaRow | undefined;
    if (!row) throw notFound("媒体不存在");
    return row;
  }

  private findUploadByToken(token: string): UploadRow {
    const tokenHash = hashToken(token);
    let row = this.database
      .prepare(
        `SELECT id, owner_admin_id, state, filename, mime, declared_bytes,
                received_bytes, expires_at, edge_job_id
         FROM uploads WHERE upload_token_hash = ? AND expires_at > ?`,
      )
      .get(tokenHash, this.now()) as UploadRow | undefined;
    if (!row) {
      row = this.database
        .prepare(
          `SELECT u.id, u.owner_admin_id, u.state, u.filename, u.mime,
                  u.declared_bytes, u.received_bytes, u.expires_at,
                  u.edge_job_id
           FROM edge_upload_credentials c
           JOIN uploads u ON u.id = c.upload_id
           JOIN edge_agents a ON a.id = c.agent_id
           JOIN edge_agent_tasks t ON t.id = c.task_id
           WHERE c.id_hash = ? AND c.revoked_at IS NULL
             AND c.expires_at > ? AND a.enabled = 1 AND a.revoked_at IS NULL
             AND t.agent_id = c.agent_id AND t.state = 'leased'
             AND t.attempts = c.task_attempt AND t.lease_until > ?`,
        )
        .get(tokenHash, this.now(), this.now()) as UploadRow | undefined;
      if (row) {
        this.database
          .prepare(
            "UPDATE edge_upload_credentials SET last_used_at = ? WHERE id_hash = ?",
          )
          .run(this.now(), tokenHash);
      }
    }
    if (!row || row.state === "cancelled") {
      throw unauthorized("Upload Token 无效或已过期");
    }
    return row;
  }

  private requireStorageReservation(requiredReserve: number): void {
    const reserved = this.database
      .prepare(
        `SELECT COALESCE(SUM(reserved_bytes), 0) AS total FROM uploads
         WHERE reserved_bytes > 0`,
      )
      .get() as { readonly total: number };
    const disk = statfsSync(this.options.uploadRoot);
    const availableBytes = disk.bavail * disk.bsize;
    if (
      availableBytes - reserved.total - requiredReserve <
      STORAGE_SAFETY_FLOOR_BYTES
    ) {
      throw new AppError(507, "INSUFFICIENT_STORAGE", "磁盘空间不足");
    }
  }

  private edgeTusUrl(uploadId: string, existingUpload: boolean): string {
    if (!existingUpload) return this.options.tusEndpoint;
    const base = this.options.tusEndpoint.endsWith("/")
      ? this.options.tusEndpoint
      : `${this.options.tusEndpoint}/`;
    return new URL(encodeURIComponent(uploadId), base).toString();
  }

  private requireMediaAccess(identity: ContentIdentity, mediaId: string): void {
    if (identity.kind === "admin") return;
    const allowed = this.database
      .prepare(
        `SELECT 1 FROM room_state s JOIN rooms r ON r.id = s.room_id
         WHERE s.room_id = ? AND s.media_id = ? AND r.status = 'active'`,
      )
      .get(identity.roomId, mediaId);
    if (!allowed) throw unauthorized("当前房间未播放此媒体");
  }

  private serializeMediaWithSubtitles(row: MediaRow) {
    const subtitles = this.database
      .prepare(
        `SELECT id, language, label, format FROM subtitles
         WHERE media_id = ? ORDER BY created_at ASC`,
      )
      .all(row.id) as Array<{
      id: string;
      language: string;
      label: string;
      format: "webvtt";
    }>;
    return { ...serializeMedia(row), subtitles };
  }

  private signContent(
    method: "GET" | "HEAD",
    sessionHash: string,
    storageKey: string,
    expiresAt: number,
  ): string {
    return createHmac("sha256", this.options.contentSigningSecret)
      .update(`${method}\n${sessionHash}\n${storageKey}\n${expiresAt}`)
      .digest("base64url");
  }
}

function serializeMedia(row: MediaRow) {
  const probe = parseStoredProbe(row.probe_json);
  return {
    id: row.id,
    displayName: row.display_name,
    state: row.state,
    bytes: row.bytes,
    mime: row.mime,
    compatibilityReasons: probe.reasons,
    durationMs: row.duration_ms,
    video: {
      codec: row.video_codec,
      playbackSupport: row.playback_support,
      width: row.video_width,
      height: row.video_height,
      fps: row.video_fps,
      pixelFormat: row.video_pixel_format,
    },
    audio: probe.audio,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function parseStoredProbe(value: string | null): {
  reasons: string[];
  audio: {
    codec: string | null;
    channels: number | null;
    sampleRate: number | null;
  };
} {
  try {
    const stored = JSON.parse(value ?? "{}") as {
      probe?: unknown;
      reasons?: unknown;
    };
    const compatibility = evaluateCompatibility(stored.probe);
    return {
      reasons: Array.isArray(stored.reasons)
        ? stored.reasons.filter(
            (reason): reason is string => typeof reason === "string",
          )
        : [...compatibility.reasons],
      audio: {
        codec: compatibility.audio.codec,
        channels: compatibility.audio.channels,
        sampleRate: compatibility.audio.sampleRate,
      },
    };
  } catch {
    return {
      reasons: [],
      audio: { codec: null, channels: null, sampleRate: null },
    };
  }
}

function storedFinalPath(value: string | null): string | null {
  try {
    const stored = JSON.parse(value ?? "{}") as { finalPath?: unknown };
    return typeof stored.finalPath === "string" ? stored.finalPath : null;
  } catch {
    return null;
  }
}

function serializeUpload(row: UploadRow) {
  return {
    id: row.id,
    state: row.state,
    filename: row.filename,
    mime: row.mime,
    declaredBytes: row.declared_bytes,
    receivedBytes: row.received_bytes,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function requirePathWithin(path: string, root: string): string {
  let realRoot: string;
  let absolute: string;
  try {
    realRoot = realpathSync(root);
    absolute = realpathSync(path);
  } catch {
    throw new AppError(400, "INVALID_FILE_PATH", "文件路径不存在或不可访问");
  }
  if (absolute !== realRoot && !absolute.startsWith(`${realRoot}${sep}`)) {
    throw new AppError(400, "PATH_OUTSIDE_ROOT", "文件路径超出允许目录");
  }
  return absolute;
}

function requirePathWithinAny(path: string, roots: string[]): string {
  for (const root of roots) {
    try {
      return requirePathWithin(path, root);
    } catch (error) {
      if (
        error instanceof AppError &&
        new Set(["PATH_OUTSIDE_ROOT", "INVALID_FILE_PATH"]).has(error.code)
      )
        continue;
      throw error;
    }
  }
  throw new AppError(400, "PATH_OUTSIDE_ROOT", "文件路径超出允许目录");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function tusRejected(message: string): Record<string, unknown> {
  return {
    RejectUpload: true,
    HTTPResponse: {
      StatusCode: 403,
      Body: JSON.stringify({ message }),
      Header: { "Content-Type": "application/json" },
    },
  };
}
