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

import type { UploadAuthorizeRequest } from "@simplewatch/contracts";
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
}

interface JobRow {
  readonly id: string;
  readonly media_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly attempts: number;
}

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
             lease_token_hash = NULL, progress_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify({ sha256: result.sha256, bytes: result.bytes }),
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
           WHERE state IN ('authorized', 'uploading', 'received', 'scanning') AND expires_at > ?`,
          )
          .get(createdAt) as { readonly total: number };
        const disk = statfsSync(this.options.uploadRoot);
        const availableBytes = disk.bavail * disk.bsize;
        const requiredReserve = input.bytes + 12 * 1024 * 1024 * 1024;
        if (availableBytes - reserved.total < requiredReserve) {
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
            input.bytes,
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

  public validateUploadToken(uploadId: string, token: string): UploadRow {
    const row = this.database
      .prepare(
        `SELECT id, owner_admin_id, state, filename, mime, declared_bytes,
                received_bytes, expires_at
         FROM uploads
         WHERE id = ? AND upload_token_hash = ? AND expires_at > ?
           AND state IN ('authorized', 'uploading')`,
      )
      .get(uploadId, hashToken(token), this.now()) as UploadRow | undefined;
    if (!row) throw unauthorized("Upload Token 无效或已过期");
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
      this.database
        .prepare(
          `UPDATE uploads SET state = 'uploading', received_bytes = ?
           WHERE id = ? AND state IN ('authorized', 'uploading')`,
        )
        .run(received, upload.id);
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
  ): void {
    if (!token) throw unauthorized("缺少 Upload-Token");
    const upload = this.findUploadByToken(token);
    if (!new Set(["authorized", "uploading"]).has(upload.state)) {
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
      this.database
        .prepare(
          `UPDATE uploads
           SET state = 'received', received_bytes = ?, reserved_bytes = 0, finished_at = ?
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
          now,
          now,
          now,
          JSON.stringify({ uploadId, filePath: safePath, storageKey }),
        );
      this.database
        .prepare(
          "UPDATE token_jti SET revoked_at = ? WHERE kind = 'upload' AND subject_id = ?",
        )
        .run(now, uploadId);
    })();

    return { mediaId, jobId };
  }

  public claimJob(workerId: string) {
    const now = this.now();
    const leaseToken = createOpaqueToken();
    let claimed: JobRow | undefined;
    this.database.transaction(() => {
      claimed = this.database
        .prepare(
          `SELECT id, media_id, kind, payload_json, attempts
           FROM media_jobs
           WHERE (state = 'pending' AND not_before <= ?)
              OR (state = 'leased' AND lease_until <= ?)
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(now, now) as JobRow | undefined;
      if (!claimed) return;
      this.database
        .prepare(
          `UPDATE media_jobs
           SET state = 'leased', attempts = attempts + 1, worker_id = ?,
               lease_token_hash = ?, lease_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(workerId, hashToken(leaseToken), now + 60_000, now, claimed.id);
    })();
    if (!claimed) return null;
    return {
      id: claimed.id,
      mediaId: claimed.media_id,
      kind: claimed.kind,
      payload: JSON.parse(claimed.payload_json) as unknown,
      leaseToken,
      leaseUntil: new Date(now + 60_000).toISOString(),
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
        now + 60_000,
        JSON.stringify(progress),
        now,
        jobId,
        hashToken(leaseToken),
        now,
      );
    if (result.changes !== 1)
      throw conflict("JOB_LEASE_EXPIRED", "任务租约已失效");
  }

  public completeJob(
    jobId: string,
    leaseToken: string,
    result: {
      readonly compatible: boolean;
      readonly probe: unknown;
      readonly reasons: readonly string[];
      readonly sha256: string;
      readonly bytes: number;
      readonly durationMs: number | null;
      readonly finalPath: string;
    },
  ): void {
    const now = this.now();
    this.database.transaction(() => {
      const job = this.database
        .prepare(
          `SELECT id, media_id FROM media_jobs
           WHERE id = ? AND state = 'leased' AND lease_token_hash = ? AND lease_until > ?`,
        )
        .get(jobId, hashToken(leaseToken), now) as
        | { readonly id: string; readonly media_id: string }
        | undefined;
      if (!job) throw conflict("JOB_LEASE_EXPIRED", "任务租约已失效");
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
           SET state = 'completed', lease_until = NULL, lease_token_hash = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, jobId);
      this.database
        .prepare(
          `UPDATE uploads SET state = ?, finished_at = ?
           WHERE id = json_extract((SELECT payload_json FROM media_jobs WHERE id = ?), '$.uploadId')`,
        )
        .run(state, now, jobId);
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
    const row = this.database
      .prepare(
        `SELECT id, owner_admin_id, state, filename, mime, declared_bytes,
                received_bytes, expires_at
         FROM uploads WHERE upload_token_hash = ? AND expires_at > ?`,
      )
      .get(hashToken(token), this.now()) as UploadRow | undefined;
    if (!row || row.state === "cancelled") {
      throw unauthorized("Upload Token 无效或已过期");
    }
    return row;
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
