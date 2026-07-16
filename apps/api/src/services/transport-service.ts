import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { TextEncoder } from "node:util";

import { jwtVerify, SignJWT } from "jose";
import {
  AccessToken,
  TrackSource,
  WebhookReceiver,
  type WebhookEvent,
} from "livekit-server-sdk";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

import type { AppDatabase } from "../database.js";
import { forbidden, unauthorized } from "../errors.js";
import { createOpaqueToken, hashToken } from "../security.js";
import type { RoomIdentity } from "./room-service.js";

interface TransportOptions {
  readonly mediaJwtSecret: string;
  readonly obsCredentialEncryptionKey: string;
  readonly mediaOrigin: string;
  readonly livekitApiKey: string;
  readonly livekitApiSecret: string;
  readonly livekitUrl: string;
  readonly mediamtxControlUrl: string;
  readonly now?: () => number;
}

const mediaClaimsSchema = z.object({
  roomId: z.string().uuid(),
  sub: z.string().uuid(),
  action: z.enum(["read", "publish"]),
  path: z.string().min(1),
  jti: z.string().min(1),
});

export class TransportService {
  private readonly now: () => number;
  private readonly mediaKey: Uint8Array;
  private readonly obsEncryptionKey: Buffer;
  private readonly webhookReceiver: WebhookReceiver;
  private readonly liveMetricSamples = new Map<string, SourceMetricSample>();

  public constructor(
    private readonly database: AppDatabase,
    private readonly options: TransportOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.mediaKey = new TextEncoder().encode(options.mediaJwtSecret);
    this.obsEncryptionKey = createHash("sha256")
      .update(options.obsCredentialEncryptionKey)
      .digest();
    this.webhookReceiver = new WebhookReceiver(
      options.livekitApiKey,
      options.livekitApiSecret,
    );
  }

  public async receiveLivekitWebhook(
    body: string,
    authorization?: string,
  ): Promise<WebhookEvent> {
    try {
      return await this.webhookReceiver.receive(body, authorization);
    } catch {
      throw unauthorized("LiveKit webhook 签名无效");
    }
  }

  public async issueCredential(
    identity: RoomIdentity,
    purpose: "voice" | "whep",
  ) {
    this.requireActiveMember(identity.roomId, identity.memberId);
    if (purpose === "voice") {
      const token = new AccessToken(
        this.options.livekitApiKey,
        this.options.livekitApiSecret,
        {
          identity: identity.memberId,
          name: identity.nickname,
          ttl: "2m",
          metadata: JSON.stringify({ roomId: identity.roomId }),
        },
      );
      token.addGrant({
        room: `voice:${identity.roomId}`,
        roomJoin: true,
        canSubscribe: true,
        canPublish: true,
        canPublishData: false,
        canPublishSources: [TrackSource.MICROPHONE],
      });
      return {
        purpose,
        url: this.options.livekitUrl,
        token: await token.toJwt(),
        expiresAt: new Date(this.now() + 2 * 60_000).toISOString(),
      };
    }

    const path = this.getLivePath(identity.roomId);
    return this.issueMediaToken(identity, "read", path, 5 * 60_000, purpose);
  }

  public getStablePublishCredential(identity: RoomIdentity) {
    if (identity.role !== "host") throw forbidden("只有主持人可以推流");
    this.requireActiveMember(identity.roomId, identity.memberId);
    const credential = this.getOrCreateStablePublishCredential();
    const path = this.getLivePath(identity.roomId);
    if (path !== credential.path) {
      this.database
        .prepare(
          "UPDATE room_state SET live_path = ?, updated_at = ? WHERE room_id = ?",
        )
        .run(credential.path, this.now(), identity.roomId);
    }
    return {
      purpose: "whip" as const,
      url: `${this.options.mediaOrigin}/program/${credential.path}/whip`,
      token: credential.token,
      path: credential.path,
      // 长期配置不自动过期，只能由管理员明确轮换。
      expiresAt: "9999-12-31T23:59:59.999Z",
    };
  }

  public getStablePublishPath(): string {
    return this.getOrCreateStablePublishCredential().path;
  }

  public rotateStablePublishCredential(): {
    readonly url: string;
    readonly token: string;
    readonly path: string;
    readonly expiresAt: string;
  } {
    const previous = this.getOrCreateStablePublishCredential();
    const path = createOpaqueToken(24);
    const token = createOpaqueToken(32);
    const now = this.now();
    const sessionIds = this.database
      .prepare(
        `SELECT mediamtx_session_id FROM media_transport_sessions
         WHERE action = 'publish' AND path = ? AND closed_at IS NULL
           AND mediamtx_session_id IS NOT NULL`,
      )
      .all(previous.path)
      .map(
        (row) => (row as { mediamtx_session_id: string }).mediamtx_session_id,
      );
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE broadcast_credentials
           SET path = ?, token_ciphertext = ?, token_hash = ?, rotated_at = ?
           WHERE id = 1`,
        )
        .run(path, this.encrypt(token), hashToken(token), now);
      this.database
        .prepare(
          "UPDATE room_state SET live_path = ?, updated_at = ? WHERE live_path = ?",
        )
        .run(path, now, previous.path);
      if (sessionIds.length > 0) {
        this.database
          .prepare(
            `INSERT INTO service_outbox(
              id, kind, dedupe_key, payload_json, state, attempts,
              not_before, lease_until, last_error, created_at, completed_at
            ) VALUES (?, 'mediamtx.kick-sessions', ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
          )
          .run(
            uuidv7(),
            `mediamtx-rotate:${uuidv7()}`,
            JSON.stringify({
              roomId: "rotation",
              memberId: "publisher",
              sessionIds,
            }),
            now,
            now,
          );
      }
    })();
    return {
      url: `${this.options.mediaOrigin}/program/${path}/whip`,
      token,
      path,
      expiresAt: "9999-12-31T23:59:59.999Z",
    };
  }

  public async getLiveStatus(roomId: string): Promise<{
    readonly state: "offline" | "online" | "unknown";
    readonly hasVideo: boolean;
    readonly hasAudio: boolean;
    readonly videoTrackCount: number;
    readonly audioTrackCount: number;
    readonly sourceBitrateMbps: number | null;
    readonly sourcePacketLossPercent: number | null;
    readonly sourceHealth: "good" | "degraded" | "poor" | "unknown";
    readonly checkedAt: string;
  }> {
    const checkedAt = new Date(this.now()).toISOString();
    const path = this.getLivePath(roomId);
    try {
      const response = await fetch(
        new URL("/v3/paths/list", this.options.mediamtxControlUrl),
        { signal: AbortSignal.timeout(1500) },
      );
      if (!response.ok) throw new Error(`MediaMTX HTTP ${response.status}`);
      const payload = (await response.json()) as { items?: unknown[] };
      const item = (payload.items ?? []).find((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        return (candidate as { name?: unknown }).name === path;
      }) as
        | {
            readonly ready?: boolean;
            readonly tracks?: unknown[];
            readonly source?: unknown;
          }
        | undefined;
      if (!item?.ready || !item.source) {
        return {
          state: "offline",
          hasVideo: false,
          hasAudio: false,
          videoTrackCount: 0,
          audioTrackCount: 0,
          sourceBitrateMbps: null,
          sourcePacketLossPercent: null,
          sourceHealth: "unknown",
          checkedAt,
        };
      }
      const tracks = (item.tracks ?? []).map((track) =>
        (typeof track === "string"
          ? track
          : JSON.stringify(track)
        ).toLowerCase(),
      );
      const videoTrackCount = tracks.filter((track) =>
        track.includes("h264"),
      ).length;
      const audioTrackCount = tracks.filter((track) =>
        track.includes("opus"),
      ).length;
      const hasVideo = videoTrackCount > 0;
      const hasAudio = audioTrackCount > 0;
      const quality = await this.getSourceQuality(path).catch(
        (): SourceQuality => ({
          sourceBitrateMbps: null,
          sourcePacketLossPercent: null,
          sourceHealth: "unknown",
        }),
      );
      return {
        state: hasVideo && hasAudio ? "online" : "offline",
        hasVideo,
        hasAudio,
        videoTrackCount,
        audioTrackCount,
        ...quality,
        checkedAt,
      };
    } catch {
      return {
        state: "unknown",
        hasVideo: false,
        hasAudio: false,
        videoTrackCount: 0,
        audioTrackCount: 0,
        sourceBitrateMbps: null,
        sourcePacketLossPercent: null,
        sourceHealth: "unknown",
        checkedAt,
      };
    }
  }

  private async getSourceQuality(path: string): Promise<SourceQuality> {
    const metricsUrl = new URL(this.options.mediamtxControlUrl);
    metricsUrl.port = "9998";
    metricsUrl.pathname = "/metrics";
    metricsUrl.search = new URLSearchParams({
      type: "webrtc_sessions",
      path,
    }).toString();
    const response = await fetch(metricsUrl, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`MediaMTX metrics ${response.status}`);
    const metrics = await response.text();
    const current = {
      atMs: this.now(),
      bytes: sumPrometheusMetric(
        metrics,
        "webrtc_sessions_inbound_bytes",
        path,
      ),
      packets: sumPrometheusMetric(
        metrics,
        "webrtc_sessions_inbound_rtp_packets",
        path,
      ),
      lost: sumPrometheusMetric(
        metrics,
        "webrtc_sessions_inbound_rtp_packets_lost",
        path,
      ),
    };
    const previous = this.liveMetricSamples.get(path);
    if (previous && current.atMs - previous.atMs < 800) return previous.quality;

    let quality: SourceQuality = {
      sourceBitrateMbps: null,
      sourcePacketLossPercent: null,
      sourceHealth: "unknown",
    };
    if (previous && current.atMs > previous.atMs) {
      const elapsedSeconds = (current.atMs - previous.atMs) / 1000;
      const bytesDelta = current.bytes - previous.bytes;
      const packetsDelta = current.packets - previous.packets;
      const lostDelta = current.lost - previous.lost;
      if (bytesDelta >= 0 && packetsDelta >= 0 && lostDelta >= 0) {
        const denominator = packetsDelta + lostDelta;
        const loss = denominator > 0 ? (lostDelta / denominator) * 100 : 0;
        quality = {
          sourceBitrateMbps: (bytesDelta * 8) / elapsedSeconds / 1_000_000,
          sourcePacketLossPercent: loss,
          sourceHealth: loss > 3 ? "poor" : loss > 1 ? "degraded" : "good",
        };
      }
    }
    this.liveMetricSamples.set(path, { ...current, quality });
    return quality;
  }

  public async authorizeMedia(input: {
    readonly token?: string | undefined;
    readonly action: string;
    readonly path: string;
    readonly id?: string | undefined;
  }): Promise<void> {
    if (!input.token) throw unauthorized("缺少媒体凭据");
    if (input.action === "publish") {
      this.authorizeStablePublisher(input);
      return;
    }
    let payload: z.infer<typeof mediaClaimsSchema>;
    try {
      const verified = await jwtVerify(input.token, this.mediaKey, {
        issuer: "simplewatch",
        audience: "mediamtx",
        currentDate: new Date(this.now()),
      });
      payload = mediaClaimsSchema.parse(verified.payload);
    } catch {
      throw unauthorized("媒体凭据无效或已过期");
    }
    const { roomId, sub: memberId, action, path, jti } = payload;
    if (action !== input.action || path !== input.path) {
      throw forbidden("媒体 action/path 与凭据不匹配");
    }
    this.requireActiveMember(roomId, memberId);
    const tokenRow = this.database
      .prepare(
        `SELECT revoked_at FROM token_jti
         WHERE jti_hash = ? AND kind = 'media' AND expires_at > ?
           AND room_id = ? AND scope = ?`,
      )
      .get(hashToken(jti), this.now(), roomId, action) as
      | { readonly revoked_at: number | null }
      | undefined;
    if (!tokenRow || tokenRow.revoked_at !== null)
      throw forbidden("媒体凭据已撤销");

    if (input.id) {
      const exists = this.database
        .prepare(
          "SELECT 1 FROM media_transport_sessions WHERE jti_hash = ? AND mediamtx_session_id = ? AND closed_at IS NULL",
        )
        .get(hashToken(jti), input.id);
      if (!exists) {
        this.database
          .prepare(
            `INSERT INTO media_transport_sessions(
              id, room_id, member_id, jti_hash, mediamtx_session_id,
              action, path, connected_at, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            uuidv7(),
            roomId,
            memberId,
            hashToken(jti),
            input.id,
            action,
            path,
            this.now(),
          );
      }
    }
  }

  private async issueMediaToken(
    identity: RoomIdentity,
    action: "read",
    path: string,
    ttlMs: number,
    purpose: "whep",
  ) {
    const jti = createOpaqueToken(24);
    const expiresAt = this.now() + ttlMs;
    const token = await new SignJWT({
      roomId: identity.roomId,
      action,
      path,
    })
      .setProtectedHeader({ alg: "HS256", kid: "local-v1", typ: "JWT" })
      .setIssuer("simplewatch")
      .setAudience("mediamtx")
      .setSubject(identity.memberId)
      .setJti(jti)
      .setIssuedAt(Math.floor(this.now() / 1000))
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(this.mediaKey);
    this.database
      .prepare(
        `INSERT INTO token_jti(
          jti_hash, kind, subject_id, expires_at, revoked_at, room_id, scope
        ) VALUES (?, 'media', ?, ?, NULL, ?, ?)`,
      )
      .run(
        hashToken(jti),
        identity.memberId,
        expiresAt,
        identity.roomId,
        action,
      );
    return {
      purpose,
      url: `${this.options.mediaOrigin}/program/${path}/${purpose}`,
      token,
      path,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private getLivePath(roomId: string): string {
    const state = this.database
      .prepare("SELECT live_path FROM room_state WHERE room_id = ?")
      .get(roomId) as { readonly live_path: string | null } | undefined;
    if (!state?.live_path) throw forbidden("房间直播路径不可用");
    return state.live_path;
  }

  private requireActiveMember(roomId: string, memberId: string): void {
    const row = this.database
      .prepare(
        `SELECT 1 FROM room_members m JOIN rooms r ON r.id = m.room_id
         WHERE m.room_id = ? AND m.member_id = ? AND r.status = 'active'
           AND m.left_at IS NULL AND m.kicked_at IS NULL`,
      )
      .get(roomId, memberId);
    if (!row) throw forbidden("房间成员状态无效");
  }

  private getOrCreateStablePublishCredential(): {
    readonly path: string;
    readonly token: string;
  } {
    const row = this.database
      .prepare(
        "SELECT path, token_ciphertext FROM broadcast_credentials WHERE id = 1",
      )
      .get() as { path: string; token_ciphertext: string } | undefined;
    if (row)
      return { path: row.path, token: this.decrypt(row.token_ciphertext) };
    const path = createOpaqueToken(24);
    const token = createOpaqueToken(32);
    const now = this.now();
    this.database
      .prepare(
        `INSERT INTO broadcast_credentials(
          id, path, token_ciphertext, token_hash, created_at, rotated_at
        ) VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(path, this.encrypt(token), hashToken(token), now, now);
    return { path, token };
  }

  private authorizeStablePublisher(input: {
    readonly token?: string | undefined;
    readonly path: string;
    readonly id?: string | undefined;
  }): void {
    const row = this.database
      .prepare(
        "SELECT path, token_hash FROM broadcast_credentials WHERE id = 1",
      )
      .get() as { path: string; token_hash: string } | undefined;
    if (!row || row.path !== input.path || !input.token) {
      throw unauthorized("OBS 推流配置无效");
    }
    const expected = Buffer.from(row.token_hash);
    const provided = Buffer.from(hashToken(input.token));
    if (
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    )
      throw unauthorized("OBS 推流码无效");
    const active = this.database
      .prepare(
        `SELECT r.id AS room_id, s.host_member_id
         FROM rooms r JOIN room_state s ON s.room_id = r.id
         WHERE r.status = 'active' AND s.live_path = ? LIMIT 1`,
      )
      .get(input.path) as
      | { room_id: string; host_member_id: string }
      | undefined;
    if (!active) throw forbidden("放映室未开放，暂不接受推流");
    if (!input.id) return;
    const key = hashToken(input.token);
    const exists = this.database
      .prepare(
        "SELECT 1 FROM media_transport_sessions WHERE jti_hash = ? AND mediamtx_session_id = ? AND closed_at IS NULL",
      )
      .get(key, input.id);
    if (!exists) {
      this.database
        .prepare(
          `INSERT INTO media_transport_sessions(
            id, room_id, member_id, jti_hash, mediamtx_session_id,
            action, path, connected_at, closed_at
          ) VALUES (?, ?, ?, ?, ?, 'publish', ?, ?, NULL)`,
        )
        .run(
          uuidv7(),
          active.room_id,
          active.host_member_id,
          key,
          input.id,
          input.path,
          this.now(),
        );
    }
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.obsEncryptionKey, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  private decrypt(value: string): string {
    const payload = Buffer.from(value, "base64url");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const body = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.obsEncryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  }
}

interface SourceQuality {
  readonly sourceBitrateMbps: number | null;
  readonly sourcePacketLossPercent: number | null;
  readonly sourceHealth: "good" | "degraded" | "poor" | "unknown";
}

interface SourceMetricSample {
  readonly atMs: number;
  readonly bytes: number;
  readonly packets: number;
  readonly lost: number;
  readonly quality: SourceQuality;
}

function sumPrometheusMetric(
  text: string,
  metric: string,
  path: string,
): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${metric}{`) || !line.includes(`path="${path}"`))
      continue;
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}
