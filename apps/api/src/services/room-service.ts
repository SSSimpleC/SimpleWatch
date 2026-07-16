import { v7 as uuidv7 } from "uuid";

import type {
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
import { createOpaqueToken, hashToken, verifyTokenHash } from "../security.js";
import type { AccountSession } from "./auth-service.js";

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
  readonly accountId: string;
  readonly deviceId: string;
  readonly roomId: string;
  readonly memberId: string;
  readonly nickname: string;
  readonly role: "host" | "member";
  readonly csrfHash: string;
  readonly expiresAt: number;
}

export type AccountRoomEntry =
  | {
      readonly state: "room";
      readonly roomId: string;
      readonly memberId: string;
      readonly nickname: string;
      readonly role: "host" | "member";
      readonly tookOverSessionHash: string | null;
    }
  | {
      readonly state: "waiting";
      readonly reason: "no-room" | "room-full" | "left" | "removed";
      readonly roomId: string | null;
      readonly position: number | null;
    }
  | {
      readonly state: "taken-over";
      readonly roomId: string;
      readonly memberId: string;
    };

export class RoomService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  public createAccountRoom(
    session: AccountSession,
    livePath = createOpaqueToken(24),
  ): AccountRoomEntry & { readonly state: "room" } {
    if (session.role !== "host") throw forbidden("仅放映管理员可以创建房间");
    const roomId = uuidv7();
    const memberId = uuidv7();
    const timestamp = this.now();
    const passwordHash = "fixed-account-auth";
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO rooms(
              id, password_hash, status, max_members, created_by, created_at, closed_at
            ) VALUES (?, ?, 'active', 5, ?, ?, NULL)`,
          )
          .run(roomId, passwordHash, session.account_id, timestamp);
        this.database
          .prepare(
            `INSERT INTO room_members(
              member_id, room_id, nickname, nickname_folded, role,
              joined_at, last_seen_at, left_at, kicked_at, account_id
            ) VALUES (?, ?, ?, ?, 'host', ?, ?, NULL, NULL, ?)`,
          )
          .run(
            memberId,
            roomId,
            session.username,
            foldNickname(session.username),
            timestamp,
            timestamp,
            session.account_id,
          );
        this.database
          .prepare(
            `INSERT INTO room_state(
              room_id, revision, mode, media_id, live_path,
              transport_json, host_member_id, updated_at
            ) VALUES (?, 0, 'idle', NULL, ?, NULL, ?, ?)`,
          )
          .run(roomId, livePath, memberId, timestamp);
        this.database
          .prepare(
            `INSERT INTO room_device_leases(member_id, session_hash, device_id, acquired_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(memberId, session.id_hash, session.device_id, timestamp);
        this.database
          .prepare("DELETE FROM room_wait_queue WHERE account_id = ?")
          .run(session.account_id);
      })();
    } catch (error) {
      if (error instanceof Error && error.message.includes("rooms.status")) {
        throw conflict("ACTIVE_ROOM_EXISTS", "已有一个活动房间");
      }
      throw error;
    }
    return {
      state: "room",
      roomId,
      memberId,
      nickname: session.username,
      role: "host",
      tookOverSessionHash: null,
    };
  }

  public enterAccountRoom(
    session: AccountSession,
    options: { readonly forceTakeover?: boolean } = {},
  ): AccountRoomEntry {
    const room = this.database
      .prepare(
        "SELECT id, max_members FROM rooms WHERE status = 'active' LIMIT 1",
      )
      .get() as
      | { readonly id: string; readonly max_members: number }
      | undefined;
    if (!room) return this.enqueueWaiting(session, "no-room", null);

    let previous = this.database
      .prepare(
        `SELECT member_id, role, left_at, kicked_at
         FROM room_members WHERE room_id = ? AND account_id = ?
         ORDER BY joined_at DESC LIMIT 1`,
      )
      .get(room.id, session.account_id) as
      | {
          readonly member_id: string;
          readonly role: "host" | "member";
          readonly left_at: number | null;
          readonly kicked_at: number | null;
        }
      | undefined;
    const waiting = this.database
      .prepare(
        "SELECT suppressed_room_id FROM room_wait_queue WHERE account_id = ?",
      )
      .get(session.account_id) as
      | { readonly suppressed_room_id: string | null }
      | undefined;
    if (previous?.kicked_at) {
      return this.enqueueWaiting(session, "removed", room.id, room.id);
    }
    if (previous?.left_at) {
      if (waiting?.suppressed_room_id === room.id) {
        return this.enqueueWaiting(session, "left", room.id, room.id);
      }
      previous = undefined;
    }

    const timestamp = this.now();
    if (previous) {
      const lease = this.database
        .prepare(
          "SELECT session_hash FROM room_device_leases WHERE member_id = ?",
        )
        .get(previous.member_id) as
        | { readonly session_hash: string }
        | undefined;
      if (
        lease &&
        lease.session_hash !== session.id_hash &&
        !options.forceTakeover
      ) {
        return {
          state: "taken-over",
          roomId: room.id,
          memberId: previous.member_id,
        };
      }
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO room_device_leases(member_id, session_hash, device_id, acquired_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(member_id) DO UPDATE SET
               session_hash = excluded.session_hash,
               device_id = excluded.device_id,
               acquired_at = excluded.acquired_at`,
          )
          .run(
            previous.member_id,
            session.id_hash,
            session.device_id,
            timestamp,
          );
        this.database
          .prepare(
            "UPDATE room_members SET last_seen_at = ? WHERE member_id = ?",
          )
          .run(timestamp, previous.member_id);
        this.database
          .prepare("DELETE FROM room_wait_queue WHERE account_id = ?")
          .run(session.account_id);
        if (lease && lease.session_hash !== session.id_hash) {
          this.revokeMediaForTakeover(room.id, previous.member_id, timestamp);
        }
      })();
      return {
        state: "room",
        roomId: room.id,
        memberId: previous.member_id,
        nickname: session.username,
        role: previous.role,
        tookOverSessionHash:
          lease && lease.session_hash !== session.id_hash
            ? lease.session_hash
            : null,
      };
    }

    if (session.role === "host") {
      throw forbidden("Host 只能进入自己创建的活动房间");
    }
    const queueHead = this.database
      .prepare(
        `SELECT account_id FROM room_wait_queue
         WHERE suppressed_room_id IS NULL
         ORDER BY queued_at, account_id LIMIT 1`,
      )
      .get() as { readonly account_id: string } | undefined;
    if (queueHead && queueHead.account_id !== session.account_id) {
      return this.enqueueWaiting(session, "room-full", room.id);
    }
    const memberId = uuidv7();
    try {
      this.database.transaction(() => {
        const count = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM room_members
             WHERE room_id = ? AND left_at IS NULL AND kicked_at IS NULL`,
          )
          .get(room.id) as { readonly count: number };
        if (count.count >= room.max_members) {
          throw new AppError(429, "ROOM_FULL", "房间人数已满");
        }
        this.database
          .prepare(
            `INSERT INTO room_members(
              member_id, room_id, nickname, nickname_folded, role,
              joined_at, last_seen_at, left_at, kicked_at, account_id
            ) VALUES (?, ?, ?, ?, 'member', ?, ?, NULL, NULL, ?)`,
          )
          .run(
            memberId,
            room.id,
            session.username,
            foldNickname(session.username),
            timestamp,
            timestamp,
            session.account_id,
          );
        this.database
          .prepare(
            `INSERT INTO room_device_leases(member_id, session_hash, device_id, acquired_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(memberId, session.id_hash, session.device_id, timestamp);
        this.database
          .prepare("DELETE FROM room_wait_queue WHERE account_id = ?")
          .run(session.account_id);
      })();
    } catch (error) {
      if (error instanceof AppError && error.code === "ROOM_FULL") {
        return this.enqueueWaiting(session, "room-full", room.id);
      }
      throw error;
    }
    return {
      state: "room",
      roomId: room.id,
      memberId,
      nickname: session.username,
      role: "member",
      tookOverSessionHash: null,
    };
  }

  public getAccountRoomState(session: AccountSession): AccountRoomEntry {
    return this.enterAccountRoom(session, { forceTakeover: false });
  }

  public releaseAccountSession(session: AccountSession): void {
    const lease = this.database
      .prepare(
        `SELECT l.member_id, m.room_id, m.role
         FROM room_device_leases l
         JOIN room_members m ON m.member_id = l.member_id
         WHERE l.session_hash = ?`,
      )
      .get(session.id_hash) as
      | {
          readonly member_id: string;
          readonly room_id: string;
          readonly role: "host" | "member";
        }
      | undefined;
    if (!lease) return;
    const timestamp = this.now();
    this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM room_device_leases WHERE member_id = ?")
        .run(lease.member_id);
      if (lease.role === "member") {
        this.database
          .prepare(
            "UPDATE room_members SET left_at = ?, last_seen_at = ? WHERE member_id = ?",
          )
          .run(timestamp, timestamp, lease.member_id);
        this.revokeRealtimeAccess(
          lease.room_id,
          lease.member_id,
          "account-logout",
          timestamp,
        );
      }
    })();
  }

  public takeoverAccountRoom(session: AccountSession): AccountRoomEntry {
    return this.enterAccountRoom(session, { forceTakeover: true });
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
        `SELECT s.id_hash, s.account_id, s.device_id, s.csrf_hash,
                s.absolute_expires_at AS expires_at,
                m.room_id, m.member_id, m.nickname, m.role
         FROM account_sessions s
         JOIN room_device_leases l ON l.session_hash = s.id_hash
         JOIN room_members m ON m.member_id = l.member_id
         JOIN rooms r ON r.id = m.room_id
         JOIN accounts a ON a.id = s.account_id
         WHERE s.id_hash = ? AND m.account_id = s.account_id
           AND s.revoked_at IS NULL AND a.enabled = 1
           AND s.idle_expires_at > ? AND s.absolute_expires_at > ?
           AND m.left_at IS NULL
           AND m.kicked_at IS NULL
           AND r.status = 'active'`,
      )
      .get(hashToken(sessionToken), this.now(), this.now()) as
      | (RoomSessionRow & {
          readonly account_id: string;
          readonly device_id: string;
        })
      | undefined;
    if (!row) throw unauthorized();
    if (expectedRoomId && row.room_id !== expectedRoomId)
      throw forbidden("房间会话不匹配");

    return {
      sessionHash: row.id_hash,
      accountId: row.account_id,
      deviceId: row.device_id,
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
        "UPDATE account_sessions SET csrf_hash = ? WHERE id_hash = ? AND revoked_at IS NULL",
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
        .prepare(
          "UPDATE room_members SET left_at = ?, last_seen_at = ? WHERE member_id = ?",
        )
        .run(now, now, identity.memberId);
      this.database
        .prepare("DELETE FROM room_device_leases WHERE member_id = ?")
        .run(identity.memberId);
      this.database
        .prepare(
          `INSERT INTO room_wait_queue(account_id, session_hash, queued_at, suppressed_room_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             session_hash = excluded.session_hash,
             queued_at = excluded.queued_at,
             suppressed_room_id = excluded.suppressed_room_id`,
        )
        .run(identity.accountId, identity.sessionHash, now, identity.roomId);
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
        .prepare("DELETE FROM room_device_leases WHERE member_id = ?")
        .run(targetMemberId);
      const targetAccount = this.database
        .prepare("SELECT account_id FROM room_members WHERE member_id = ?")
        .get(targetMemberId) as
        | { readonly account_id: string | null }
        | undefined;
      if (targetAccount?.account_id) {
        const currentSession = this.database
          .prepare(
            `SELECT id_hash FROM account_sessions
             WHERE account_id = ? AND revoked_at IS NULL
             ORDER BY last_seen_at DESC LIMIT 1`,
          )
          .get(targetAccount.account_id) as
          | { readonly id_hash: string }
          | undefined;
        if (currentSession) {
          this.database
            .prepare(
              `INSERT INTO room_wait_queue(account_id, session_hash, queued_at, suppressed_room_id)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(account_id) DO UPDATE SET
                 session_hash = excluded.session_hash,
                 queued_at = excluded.queued_at,
                 suppressed_room_id = excluded.suppressed_room_id`,
            )
            .run(
              targetAccount.account_id,
              currentSession.id_hash,
              now,
              identity.roomId,
            );
        }
      }
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
            `DELETE FROM room_device_leases
             WHERE member_id IN (SELECT member_id FROM room_members WHERE room_id = ?)`,
          )
          .run(roomId);
        this.database.prepare("DELETE FROM room_wait_queue").run();
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

  private enqueueWaiting(
    session: AccountSession,
    reason: "no-room" | "room-full" | "left" | "removed",
    roomId: string | null,
    suppressedRoomId: string | null = null,
  ): AccountRoomEntry & { readonly state: "waiting" } {
    const timestamp = this.now();
    this.database
      .prepare(
        `INSERT INTO room_wait_queue(account_id, session_hash, queued_at, suppressed_room_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           session_hash = excluded.session_hash,
           queued_at = CASE
             WHEN room_wait_queue.suppressed_room_id IS excluded.suppressed_room_id
               THEN room_wait_queue.queued_at
             ELSE excluded.queued_at
           END,
           suppressed_room_id = excluded.suppressed_room_id`,
      )
      .run(session.account_id, session.id_hash, timestamp, suppressedRoomId);
    const queued = this.database
      .prepare(`SELECT queued_at FROM room_wait_queue WHERE account_id = ?`)
      .get(session.account_id) as { readonly queued_at: number };
    const rank = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM room_wait_queue
         WHERE suppressed_room_id IS NULL
           AND (queued_at < ? OR (queued_at = ? AND account_id <= ?))`,
      )
      .get(queued.queued_at, queued.queued_at, session.account_id) as {
      readonly count: number;
    };
    return {
      state: "waiting",
      reason,
      roomId,
      position: suppressedRoomId ? null : rank.count,
    };
  }

  private revokeMediaForTakeover(
    roomId: string,
    memberId: string,
    timestamp: number,
  ): void {
    this.database
      .prepare(
        "UPDATE token_jti SET revoked_at = ? WHERE subject_id = ? AND revoked_at IS NULL",
      )
      .run(timestamp, memberId);
    const sessionIds = this.database
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
    if (sessionIds.length === 0) return;
    this.database
      .prepare(
        `INSERT INTO service_outbox(
          id, kind, dedupe_key, payload_json, state, attempts,
          not_before, lease_until, last_error, created_at, completed_at
        ) VALUES (?, 'mediamtx.kick-sessions', ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
      )
      .run(
        uuidv7(),
        `mediamtx-takeover:${uuidv7()}`,
        JSON.stringify({ roomId, memberId, sessionIds }),
        timestamp,
        timestamp,
      );
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
}

function foldNickname(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
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
