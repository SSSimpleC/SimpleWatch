import { timingSafeEqual } from "node:crypto";

import { v7 as uuidv7 } from "uuid";

import type {
  CreateRoomRequest,
  JoinActiveRoomRequest,
  RoomCommandRequest,
  RoomSnapshot,
  TransportAnchor,
  UpdateRoomRequest,
} from "@simplewatch/contracts";

import type { AppDatabase } from "../database.js";
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "../errors.js";
import {
  createOpaqueToken,
  createSessionCredential,
  hashPassword,
  hashToken,
  verifyTokenHash,
} from "../security.js";

interface RoomRow {
  readonly id: string;
  readonly password_hash: string;
  readonly status: "active" | "closed";
  readonly max_members: number;
  readonly created_at: number;
}

interface RoomSessionRow {
  readonly id_hash: string;
  readonly room_id: string;
  readonly member_id: string;
  readonly nickname: string;
  readonly csrf_hash: string;
  readonly expires_at: number;
  readonly role: "host" | "member";
}

interface RoomStateRow {
  readonly room_id: string;
  readonly revision: number;
  readonly mode: "idle" | "vod" | "live";
  readonly media_id: string | null;
  readonly live_path: string | null;
  readonly transport_json: string | null;
  readonly host_member_id: string;
}

interface MediaRow {
  readonly id: string;
  readonly display_name: string;
  readonly duration_ms: number | null;
}

interface MemberRow {
  readonly member_id: string;
  readonly nickname: string;
  readonly role: "host" | "member";
  readonly last_seen_at: number;
}

export interface RoomIdentity {
  readonly sessionHash: string;
  readonly roomId: string;
  readonly memberId: string;
  readonly nickname: string;
  readonly role: "host" | "member";
  readonly csrfHash: string;
  readonly expiresAt: number;
}

export interface RoomSessionResult {
  readonly roomId: string;
  readonly member: {
    readonly id: string;
    readonly nickname: string;
    readonly role: "host" | "member";
  };
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export interface CreateRoomResult extends RoomSessionResult {
  readonly joinUrl: string;
}

export class RoomService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly publicOrigin: string,
    private readonly friendInviteToken: string,
    private readonly now: () => number = Date.now,
  ) {}

  public async createRoom(
    adminId: string,
    input: CreateRoomRequest,
    livePath = createOpaqueToken(24),
  ): Promise<CreateRoomResult> {
    const nickname = normalizeNickname(input.hostNickname);
    const passwordHash = await hashPassword(createOpaqueToken(32));
    const credential = createSessionCredential();
    const roomId = uuidv7();
    const memberId = uuidv7();
    const timestamp = this.now();
    const expiresAt = timestamp + 12 * 60 * 60 * 1000;

    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO rooms(
              id, password_hash, status, max_members, created_by, created_at, closed_at
            ) VALUES (?, ?, 'active', 5, ?, ?, NULL)`,
          )
          .run(roomId, passwordHash, adminId, timestamp);
        this.database
          .prepare(
            `INSERT INTO room_members(
              member_id, room_id, nickname, nickname_folded, role,
              joined_at, last_seen_at, left_at, kicked_at
            ) VALUES (?, ?, ?, ?, 'host', ?, ?, NULL, NULL)`,
          )
          .run(
            memberId,
            roomId,
            nickname,
            foldNickname(nickname),
            timestamp,
            timestamp,
          );
        this.database
          .prepare(
            `INSERT INTO room_state(
              room_id, revision, mode, media_id, live_path,
              transport_json, host_member_id, updated_at
            ) VALUES (?, 0, 'idle', NULL, ?, NULL, ?, ?)`,
          )
          .run(roomId, livePath, memberId, timestamp);
        this.insertRoomSession(
          credential.tokenHash,
          roomId,
          memberId,
          nickname,
          credential.csrfHash,
          expiresAt,
          timestamp,
        );
      })();
    } catch (error) {
      if (error instanceof Error && error.message.includes("rooms.status")) {
        throw conflict("ACTIVE_ROOM_EXISTS", "已有一个活动房间");
      }
      throw error;
    }

    return {
      roomId,
      joinUrl: `${this.publicOrigin}/join/${this.friendInviteToken}`,
      member: { id: memberId, nickname, role: "host" },
      sessionToken: credential.token,
      csrfToken: credential.csrfToken,
      expiresAt,
    };
  }

  public joinActiveRoom(input: JoinActiveRoomRequest): RoomSessionResult {
    if (!safeEqual(input.inviteToken, this.friendInviteToken)) {
      throw notFound("好友链接无效");
    }
    const room = this.database
      .prepare(
        "SELECT id, password_hash, status, max_members, created_at FROM rooms WHERE status = 'active' LIMIT 1",
      )
      .get() as RoomRow | undefined;
    if (!room) throw new AppError(410, "ROOM_CLOSED", "放映室尚未开放");
    const roomId = room.id;

    const nickname = normalizeNickname(input.nickname);
    const memberId = uuidv7();
    const credential = createSessionCredential();
    const timestamp = this.now();
    const expiresAt = timestamp + 12 * 60 * 60 * 1000;

    try {
      this.database.transaction(() => {
        const count = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM room_members
             WHERE room_id = ? AND left_at IS NULL AND kicked_at IS NULL`,
          )
          .get(roomId) as { readonly count: number };
        if (count.count >= room.max_members) {
          throw new AppError(429, "ROOM_FULL", "房间人数已满");
        }

        this.database
          .prepare(
            `INSERT INTO room_members(
              member_id, room_id, nickname, nickname_folded, role,
              joined_at, last_seen_at, left_at, kicked_at
            ) VALUES (?, ?, ?, ?, 'member', ?, ?, NULL, NULL)`,
          )
          .run(
            memberId,
            roomId,
            nickname,
            foldNickname(nickname),
            timestamp,
            timestamp,
          );
        this.insertRoomSession(
          credential.tokenHash,
          roomId,
          memberId,
          nickname,
          credential.csrfHash,
          expiresAt,
          timestamp,
        );
      })();
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw conflict("NICKNAME_IN_USE", "该昵称已在房间中使用");
      }
      throw error;
    }

    return {
      roomId,
      member: { id: memberId, nickname, role: "member" },
      sessionToken: credential.token,
      csrfToken: credential.csrfToken,
      expiresAt,
    };
  }

  public createActiveHostSession(adminId: string): CreateRoomResult {
    const row = this.database
      .prepare(
        `SELECT r.id AS room_id, s.host_member_id, m.nickname
         FROM rooms r
         JOIN room_state s ON s.room_id = r.id
         JOIN room_members m ON m.member_id = s.host_member_id
         WHERE r.status = 'active' AND r.created_by = ?
           AND m.left_at IS NULL AND m.kicked_at IS NULL
         LIMIT 1`,
      )
      .get(adminId) as
      | {
          readonly room_id: string;
          readonly host_member_id: string;
          readonly nickname: string;
        }
      | undefined;
    if (!row) throw notFound("当前没有可接管的活动房间");
    const credential = createSessionCredential();
    const timestamp = this.now();
    const expiresAt = timestamp + 12 * 60 * 60 * 1000;
    this.database.transaction(() => {
      this.database
        .prepare(
          "UPDATE room_sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL",
        )
        .run(timestamp, row.host_member_id);
      this.insertRoomSession(
        credential.tokenHash,
        row.room_id,
        row.host_member_id,
        row.nickname,
        credential.csrfHash,
        expiresAt,
        timestamp,
      );
      this.database
        .prepare("UPDATE room_members SET last_seen_at = ? WHERE member_id = ?")
        .run(timestamp, row.host_member_id);
    })();
    return {
      roomId: row.room_id,
      joinUrl: `${this.publicOrigin}/join/${this.friendInviteToken}`,
      member: { id: row.host_member_id, nickname: row.nickname, role: "host" },
      sessionToken: credential.token,
      csrfToken: credential.csrfToken,
      expiresAt,
    };
  }

  public getActiveRoomSummary(adminId: string) {
    const room = this.database
      .prepare(
        `SELECT id, created_at FROM rooms
         WHERE status = 'active' AND created_by = ? LIMIT 1`,
      )
      .get(adminId) as
      | { readonly id: string; readonly created_at: number }
      | undefined;
    if (!room) return null;
    const snapshot = this.getSnapshot(room.id);
    const host = snapshot.members.find(
      (member) => member.id === snapshot.hostMemberId,
    );
    return {
      id: room.id,
      createdAt: new Date(room.created_at).toISOString(),
      inviteUrl: `${this.publicOrigin}/join/${this.friendInviteToken}`,
      memberCount: snapshot.members.length,
      onlineCount: snapshot.members.filter((member) => member.online).length,
      maxMembers: 5 as const,
      host: host
        ? { id: host.id, nickname: host.nickname, online: host.online }
        : null,
      mode: snapshot.mode,
      content: snapshot.media
        ? {
            kind: "vod" as const,
            id: snapshot.media.id,
            title: snapshot.media.title,
          }
        : snapshot.mode === "live"
          ? { kind: "live" as const, title: "OBS 直播" }
          : null,
    };
  }

  public authenticate(
    sessionToken: string | undefined,
    expectedRoomId?: string,
  ): RoomIdentity {
    if (!sessionToken) throw unauthorized();
    const row = this.database
      .prepare(
        `SELECT s.id_hash, s.room_id, s.member_id, s.nickname, s.csrf_hash, s.expires_at, m.role
         FROM room_sessions s
         JOIN room_members m ON m.member_id = s.member_id
         JOIN rooms r ON r.id = s.room_id
         WHERE s.id_hash = ?
           AND s.revoked_at IS NULL
           AND s.expires_at > ?
           AND m.left_at IS NULL
           AND m.kicked_at IS NULL
           AND r.status = 'active'`,
      )
      .get(hashToken(sessionToken), this.now()) as RoomSessionRow | undefined;
    if (!row) throw unauthorized();
    if (expectedRoomId && row.room_id !== expectedRoomId)
      throw forbidden("房间会话不匹配");

    return {
      sessionHash: row.id_hash,
      roomId: row.room_id,
      memberId: row.member_id,
      nickname: row.nickname,
      role: row.role,
      csrfHash: row.csrf_hash,
      expiresAt: row.expires_at,
    };
  }

  public requireCsrf(
    identity: RoomIdentity,
    csrfToken: string | undefined,
  ): void {
    if (!csrfToken || !verifyTokenHash(csrfToken, identity.csrfHash)) {
      throw unauthorized("CSRF Token 无效");
    }
  }

  public rotateCsrf(identity: RoomIdentity): string {
    const csrfToken = createOpaqueToken();
    const result = this.database
      .prepare(
        "UPDATE room_sessions SET csrf_hash = ? WHERE id_hash = ? AND revoked_at IS NULL",
      )
      .run(hashToken(csrfToken), identity.sessionHash);
    if (result.changes !== 1) throw unauthorized();
    return csrfToken;
  }

  public getSnapshot(roomId: string): RoomSnapshot {
    const room = this.database
      .prepare("SELECT status FROM rooms WHERE id = ?")
      .get(roomId) as { readonly status: "active" | "closed" } | undefined;
    if (!room) throw notFound("房间不存在");
    const state = this.getRoomState(roomId);
    const members = this.database
      .prepare(
        `SELECT member_id, nickname, role, last_seen_at
         FROM room_members
         WHERE room_id = ? AND left_at IS NULL AND kicked_at IS NULL
         ORDER BY joined_at ASC`,
      )
      .all(roomId) as MemberRow[];
    const media = state.media_id
      ? (this.database
          .prepare(
            "SELECT id, display_name, duration_ms FROM media WHERE id = ?",
          )
          .get(state.media_id) as MediaRow | undefined)
      : undefined;
    const now = this.now();

    return {
      roomId,
      revision: state.revision,
      status: room.status,
      mode: state.mode,
      media: media
        ? {
            id: media.id,
            title: media.display_name,
            durationSec: (media.duration_ms ?? 0) / 1000,
          }
        : null,
      live: state.mode === "live" ? { state: "offline" } : null,
      transport: parseTransport(state.transport_json),
      hostMemberId: state.host_member_id,
      members: members.map((member) => ({
        id: member.member_id,
        nickname: member.nickname,
        role: member.role,
        online: now - member.last_seen_at <= 60_000,
      })),
      serverNowMs: now,
    };
  }

  public applyCommand(
    identity: RoomIdentity,
    request: RoomCommandRequest,
  ): RoomSnapshot {
    if (identity.role !== "host") throw forbidden("只有主持人可以控制节目");
    const now = this.now();
    const effectiveAt = now + 750;

    let result: RoomSnapshot | undefined;
    this.database.transaction(() => {
      const previous = this.database
        .prepare(
          "SELECT result_json FROM room_commands WHERE room_id = ? AND command_id = ? AND expires_at > ?",
        )
        .get(identity.roomId, request.commandId, now) as
        | { readonly result_json: string }
        | undefined;
      if (previous) {
        result = JSON.parse(previous.result_json) as RoomSnapshot;
        return;
      }

      const state = this.getRoomState(identity.roomId);
      if (state.revision !== request.expectedRevision) {
        throw conflict("REVISION_CONFLICT", "房间状态版本已变化", {
          currentRevision: state.revision,
          snapshot: this.getSnapshot(identity.roomId),
        });
      }

      const next = applyRoomCommand(this.database, state, request, effectiveAt);
      const revision = state.revision + 1;
      this.database
        .prepare("DELETE FROM room_commands WHERE expires_at <= ?")
        .run(now);
      this.database
        .prepare(
          `UPDATE room_state
           SET revision = ?, mode = ?, media_id = ?, transport_json = ?, updated_at = ?
           WHERE room_id = ?`,
        )
        .run(
          revision,
          next.mode,
          next.mediaId,
          next.transport ? JSON.stringify(next.transport) : null,
          now,
          identity.roomId,
        );
      result = this.getSnapshot(identity.roomId);
      this.database
        .prepare(
          `INSERT INTO room_commands(
            room_id, command_id, result_revision, result_json, expires_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          identity.roomId,
          request.commandId,
          revision,
          JSON.stringify(result),
          now + 10 * 60 * 1000,
        );
    })();

    if (!result) throw new Error("房间命令未产生结果");
    return result;
  }

  public leave(identity: RoomIdentity): void {
    if (identity.role === "host") {
      throw conflict("HOST_MUST_CLOSE", "主持人请返回控制台或关闭房间");
    }
    const now = this.now();
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE room_sessions SET revoked_at = ? WHERE id_hash = ?")
        .run(now, identity.sessionHash);
      this.database
        .prepare(
          "UPDATE room_members SET left_at = ?, last_seen_at = ? WHERE member_id = ?",
        )
        .run(now, now, identity.memberId);
      this.revokeRealtimeAccess(
        identity.roomId,
        identity.memberId,
        "left",
        now,
      );
    })();
  }

  public kickMember(
    identity: RoomIdentity,
    targetMemberId: string,
    reason?: string,
  ): void {
    if (identity.role !== "host") throw forbidden("只有主持人可以移出成员");
    if (identity.memberId === targetMemberId) {
      throw conflict("CANNOT_KICK_SELF", "主持人不能移出自己");
    }
    const now = this.now();
    this.database.transaction(() => {
      const target = this.database
        .prepare(
          `SELECT member_id FROM room_members
           WHERE member_id = ? AND room_id = ? AND left_at IS NULL AND kicked_at IS NULL`,
        )
        .get(targetMemberId, identity.roomId);
      if (!target) throw notFound("目标成员不存在");

      this.database
        .prepare("UPDATE room_members SET kicked_at = ? WHERE member_id = ?")
        .run(now, targetMemberId);
      this.database
        .prepare(
          "UPDATE room_sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL",
        )
        .run(now, targetMemberId);
      this.revokeRealtimeAccess(
        identity.roomId,
        targetMemberId,
        reason?.trim() || "kicked",
        now,
      );
    })();
  }

  private revokeRealtimeAccess(
    roomId: string,
    memberId: string,
    reason: string,
    now: number,
  ): void {
    this.database
      .prepare(
        "UPDATE token_jti SET revoked_at = ? WHERE subject_id = ? AND revoked_at IS NULL",
      )
      .run(now, memberId);
    const revocationId = uuidv7();
    const mediaSessionIds = this.database
      .prepare(
        `SELECT mediamtx_session_id FROM media_transport_sessions
         WHERE member_id = ? AND closed_at IS NULL
           AND mediamtx_session_id IS NOT NULL`,
      )
      .all(memberId)
      .map(
        (row) =>
          (row as { readonly mediamtx_session_id: string }).mediamtx_session_id,
      );
    this.database
      .prepare(
        `INSERT INTO rtc_revocations(
          id, room_id, member_id, identity, reason, revoked_at, cleared_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(revocationId, roomId, memberId, memberId, reason, now);
    this.database
      .prepare(
        `INSERT INTO service_outbox(
          id, kind, dedupe_key, payload_json, state, attempts,
          not_before, lease_until, last_error, created_at, completed_at
        ) VALUES (?, 'mediamtx.kick-sessions', ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
      )
      .run(
        uuidv7(),
        `mediamtx-kick:${revocationId}`,
        JSON.stringify({ roomId, memberId, sessionIds: mediaSessionIds }),
        now,
        now,
      );
    this.database
      .prepare(
        `INSERT INTO service_outbox(
          id, kind, dedupe_key, payload_json, state, attempts,
          not_before, lease_until, last_error, created_at, completed_at
        ) VALUES (?, 'rtc.remove-participant', ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
      )
      .run(
        uuidv7(),
        `rtc-remove:${revocationId}`,
        JSON.stringify({ roomId, memberId }),
        now,
        now,
      );
  }

  public updateRoom(
    adminId: string,
    roomId: string,
    input: UpdateRoomRequest,
  ): { readonly id: string; readonly status: "active" | "closed" } {
    if (!input.close) {
      throw new AppError(400, "CLOSE_REQUIRED", "此接口仅用于关闭房间");
    }
    return this.closeRoom(adminId, roomId);
  }

  public closeActiveRoom(adminId: string): {
    readonly id: string;
    readonly status: "closed";
  } {
    const room = this.database
      .prepare(
        "SELECT id FROM rooms WHERE status = 'active' AND created_by = ? LIMIT 1",
      )
      .get(adminId) as { readonly id: string } | undefined;
    if (!room) throw notFound("当前没有活动房间");
    return this.closeRoom(adminId, room.id) as {
      readonly id: string;
      readonly status: "closed";
    };
  }

  public closeByHost(identity: RoomIdentity): {
    readonly id: string;
    readonly status: "closed";
  } {
    if (identity.role !== "host") throw forbidden("只有主持人可以关闭房间");
    return this.closeRoomInternal(identity.roomId) as {
      readonly id: string;
      readonly status: "closed";
    };
  }

  private closeRoom(
    adminId: string,
    roomId: string,
  ): { readonly id: string; readonly status: "active" | "closed" } {
    const room = this.database
      .prepare("SELECT id FROM rooms WHERE id = ? AND created_by = ?")
      .get(roomId, adminId);
    if (!room) throw notFound("房间不存在");
    return this.closeRoomInternal(roomId);
  }

  private closeRoomInternal(roomId: string): {
    readonly id: string;
    readonly status: "active" | "closed";
  } {
    const now = this.now();
    this.database.transaction(() => {
      const room = this.database
        .prepare("SELECT id, status FROM rooms WHERE id = ?")
        .get(roomId) as
        | { readonly id: string; readonly status: "active" | "closed" }
        | undefined;
      if (!room) throw notFound("房间不存在");
      if (room.status === "active") {
        const members = this.database
          .prepare(
            `SELECT member_id FROM room_members
             WHERE room_id = ? AND left_at IS NULL AND kicked_at IS NULL`,
          )
          .all(roomId) as Array<{ readonly member_id: string }>;
        const mediaSessionIds = this.database
          .prepare(
            `SELECT mediamtx_session_id FROM media_transport_sessions
             WHERE room_id = ? AND closed_at IS NULL
               AND mediamtx_session_id IS NOT NULL`,
          )
          .all(roomId)
          .map(
            (row) =>
              (row as { readonly mediamtx_session_id: string })
                .mediamtx_session_id,
          );
        this.database
          .prepare(
            "UPDATE rooms SET status = 'closed', closed_at = ? WHERE id = ?",
          )
          .run(now, roomId);
        this.database
          .prepare(
            `UPDATE room_members SET kicked_at = COALESCE(kicked_at, ?), last_seen_at = ?
             WHERE room_id = ? AND left_at IS NULL`,
          )
          .run(now, now, roomId);
        this.database
          .prepare(
            "UPDATE room_sessions SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL",
          )
          .run(now, roomId);
        this.database
          .prepare(
            `UPDATE token_jti SET revoked_at = ?
             WHERE revoked_at IS NULL AND (
               room_id = ? OR subject_id IN (
                 SELECT member_id FROM room_members WHERE room_id = ?
               )
             )`,
          )
          .run(now, roomId, roomId);
        this.database
          .prepare(
            `UPDATE room_state
             SET mode = 'idle', media_id = NULL, transport_json = NULL,
                 revision = revision + 1, updated_at = ?
             WHERE room_id = ?`,
          )
          .run(now, roomId);
        if (mediaSessionIds.length > 0) {
          const eventId = uuidv7();
          this.database
            .prepare(
              `INSERT INTO service_outbox(
                id, kind, dedupe_key, payload_json, state, attempts,
                not_before, lease_until, last_error, created_at, completed_at
              ) VALUES (?, 'mediamtx.kick-sessions', ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
            )
            .run(
              uuidv7(),
              `mediamtx-force-close:${eventId}`,
              JSON.stringify({
                roomId,
                memberId: "all",
                sessionIds: mediaSessionIds,
              }),
              now,
              now,
            );
        }
        for (const member of members) {
          const eventId = uuidv7();
          this.database
            .prepare(
              `INSERT INTO rtc_revocations(
                id, room_id, member_id, identity, reason, revoked_at, cleared_at
              ) VALUES (?, ?, ?, ?, 'room-force-closed', ?, NULL)`,
            )
            .run(eventId, roomId, member.member_id, member.member_id, now);
          this.database
            .prepare(
              `INSERT INTO service_outbox(
                id, kind, dedupe_key, payload_json, state, attempts,
                not_before, lease_until, last_error, created_at, completed_at
              ) VALUES (?, 'rtc.remove-participant', ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
            )
            .run(
              uuidv7(),
              `rtc-force-close:${eventId}`,
              JSON.stringify({ roomId, memberId: member.member_id }),
              now,
              now,
            );
        }
      }
    })();

    const updated = this.database
      .prepare("SELECT id, status FROM rooms WHERE id = ?")
      .get(roomId) as {
      readonly id: string;
      readonly status: "active" | "closed";
    };
    return updated;
  }

  public touch(identity: RoomIdentity): void {
    this.database
      .prepare("UPDATE room_members SET last_seen_at = ? WHERE member_id = ?")
      .run(this.now(), identity.memberId);
  }

  private getRoomState(roomId: string): RoomStateRow {
    const state = this.database
      .prepare("SELECT * FROM room_state WHERE room_id = ?")
      .get(roomId) as RoomStateRow | undefined;
    if (!state) throw notFound("房间状态不存在");
    return state;
  }

  private insertRoomSession(
    tokenHash: string,
    roomId: string,
    memberId: string,
    nickname: string,
    csrfHash: string,
    expiresAt: number,
    createdAt: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO room_sessions(
          id_hash, room_id, member_id, nickname, csrf_hash, expires_at, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        tokenHash,
        roomId,
        memberId,
        nickname,
        csrfHash,
        expiresAt,
        createdAt,
      );
  }
}

function normalizeNickname(value: string): string {
  const normalized = value.trim().normalize("NFC");
  const length = [...normalized].length;
  if (length < 1 || length > 24) {
    throw new AppError(
      400,
      "INVALID_NICKNAME",
      "昵称必须为 1–24 个 Unicode 字符",
    );
  }
  return normalized;
}

function foldNickname(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function parseTransport(value: string | null): TransportAnchor | null {
  return value ? (JSON.parse(value) as TransportAnchor) : null;
}

function applyRoomCommand(
  database: AppDatabase,
  state: RoomStateRow,
  request: RoomCommandRequest,
  effectiveAt: number,
): {
  readonly mode: "idle" | "vod" | "live";
  readonly mediaId: string | null;
  readonly transport: TransportAnchor | null;
} {
  const command = request.command;
  if (command.kind === "select-vod") {
    const media = database
      .prepare(
        "SELECT id FROM media WHERE id = ? AND state IN ('compatible', 'published') AND trashed_at IS NULL",
      )
      .get(command.mediaId);
    if (!media) throw notFound("影片不存在或尚未就绪");
    return {
      mode: "vod",
      mediaId: command.mediaId,
      transport: {
        state: "paused",
        positionSec: 0,
        rate: 1,
        anchoredAtServerMs: effectiveAt,
      },
    };
  }
  if (command.kind === "select-live") {
    const previous = parseTransport(state.transport_json);
    return {
      mode: "live",
      mediaId: state.media_id,
      transport: previous
        ? {
            ...previous,
            state: "paused",
            positionSec: projectPosition(previous, effectiveAt),
            anchoredAtServerMs: effectiveAt,
          }
        : null,
    };
  }
  if (command.kind === "restore-vod") {
    if (!state.media_id)
      throw conflict("NO_PREVIOUS_VOD", "没有可恢复的服务器影片");
    const media = database
      .prepare(
        "SELECT id FROM media WHERE id = ? AND state IN ('compatible', 'published') AND trashed_at IS NULL",
      )
      .get(state.media_id);
    if (!media) throw notFound("上一条影片已不可用");
    const previous = parseTransport(state.transport_json);
    return {
      mode: "vod",
      mediaId: state.media_id,
      transport: previous
        ? { ...previous, state: "paused", anchoredAtServerMs: effectiveAt }
        : {
            state: "paused",
            positionSec: 0,
            rate: 1,
            anchoredAtServerMs: effectiveAt,
          },
    };
  }
  if (state.mode !== "vod") {
    throw conflict("INVALID_ROOM_MODE", "当前不是点播模式");
  }

  const current = parseTransport(state.transport_json);
  if (!current) throw conflict("NO_TRANSPORT", "当前没有可控制的播放状态");
  const projected = projectPosition(current, effectiveAt);

  switch (command.kind) {
    case "play":
      return {
        mode: "vod",
        mediaId: state.media_id,
        transport: {
          ...current,
          state: "playing",
          positionSec: projected,
          anchoredAtServerMs: effectiveAt,
        },
      };
    case "pause":
      return {
        mode: "vod",
        mediaId: state.media_id,
        transport: {
          ...current,
          state: "paused",
          positionSec: projected,
          anchoredAtServerMs: effectiveAt,
        },
      };
    case "seek": {
      const mediaDuration = state.media_id
        ? (
            database
              .prepare("SELECT duration_ms FROM media WHERE id = ?")
              .get(state.media_id) as
              | { readonly duration_ms: number | null }
              | undefined
          )?.duration_ms
        : null;
      const maximumPosition = Math.max(0, (mediaDuration ?? 0) / 1000);
      return {
        mode: "vod",
        mediaId: state.media_id,
        transport: {
          ...current,
          positionSec:
            maximumPosition > 0
              ? Math.min(command.positionSec, maximumPosition)
              : command.positionSec,
          anchoredAtServerMs: effectiveAt,
        },
      };
    }
    case "set-rate":
      return {
        mode: "vod",
        mediaId: state.media_id,
        transport: {
          ...current,
          positionSec: projected,
          rate: command.rate,
          anchoredAtServerMs: effectiveAt,
        },
      };
  }
}

function projectPosition(anchor: TransportAnchor, atMs: number): number {
  if (anchor.state === "paused" || atMs <= anchor.anchoredAtServerMs)
    return anchor.positionSec;
  return (
    anchor.positionSec +
    ((atMs - anchor.anchoredAtServerMs) / 1000) * anchor.rate
  );
}
