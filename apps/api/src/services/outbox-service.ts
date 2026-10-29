import { v7 as uuidv7 } from "uuid";

import type { AppDatabase } from "../database.js";
import { conflict, notFound } from "../errors.js";
import { createOpaqueToken, hashToken, verifyTokenHash } from "../security.js";
import {
  chunkMediaSessionIds,
  LEGACY_MEDIA_SESSION_KICK_LIMIT,
  uniqueMediaSessionIds,
} from "./media-session-outbox.js";
import { isRtcIdentityActive, parseRtcIdentity } from "./rtc-identity.js";

export type OutboxKind = "rtc.remove-participant" | "mediamtx.kick-sessions";
export const MAX_OUTBOX_ATTEMPTS = 5;

interface OutboxRow {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly payload_json: string;
  readonly attempts: number;
  readonly lease_token_hash: string | null;
}

interface LegacyOutboxRow {
  readonly id: string;
  readonly payload_json: string;
  readonly last_error: string | null;
}

export class OutboxService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  public claim(workerId: string) {
    const timestamp = this.now();
    return this.database
      .transaction(() => {
        this.recoverLegacyMediaKickTasks(timestamp);
        this.database
          .prepare(
            `UPDATE service_outbox
             SET state = 'failed', lease_until = NULL,
                 lease_token_hash = NULL, worker_id = NULL,
                 last_error = COALESCE(last_error, 'Outbox 已达到最大尝试次数')
             WHERE attempts >= ? AND (
               state = 'pending'
               OR (state = 'leased' AND lease_until <= ?)
             )`,
          )
          .run(MAX_OUTBOX_ATTEMPTS, timestamp);
        const row = this.database
          .prepare(
            `SELECT id, kind, payload_json, attempts, lease_token_hash
           FROM service_outbox
           WHERE attempts < ? AND (
             (state = 'pending' AND not_before <= ?)
             OR (state = 'leased' AND lease_until <= ?)
           )
           ORDER BY created_at, id
           LIMIT 1`,
          )
          .get(MAX_OUTBOX_ATTEMPTS, timestamp, timestamp) as
          | OutboxRow
          | undefined;
        if (!row) return null;
        const leaseToken = createOpaqueToken();
        const changed = this.database
          .prepare(
            `UPDATE service_outbox
           SET state = 'leased', attempts = attempts + 1, worker_id = ?,
               lease_token_hash = ?, lease_until = ?, last_error = NULL
           WHERE id = ? AND (
             (state = 'pending' AND not_before <= ?)
             OR (state = 'leased' AND lease_until <= ?)
           )`,
          )
          .run(
            workerId,
            hashToken(leaseToken),
            timestamp + 30_000,
            row.id,
            timestamp,
            timestamp,
          );
        if (changed.changes !== 1) return null;
        return {
          id: row.id,
          kind: row.kind,
          payload: JSON.parse(row.payload_json) as unknown,
          attempts: row.attempts + 1,
          leaseToken,
        };
      })
      .immediate();
  }

  public complete(id: string, leaseToken: string): void {
    const timestamp = this.now();
    this.database.transaction(() => {
      const row = this.requireLease(id, leaseToken);
      if (row.kind === "mediamtx.kick-sessions") {
        const payload = JSON.parse(row.payload_json) as {
          sessionIds?: unknown;
        };
        if (
          !Array.isArray(payload.sessionIds) ||
          payload.sessionIds.length > LEGACY_MEDIA_SESSION_KICK_LIMIT ||
          payload.sessionIds.some(
            (sessionId) =>
              typeof sessionId !== "string" || sessionId.length === 0,
          )
        ) {
          throw conflict(
            "INVALID_OUTBOX_PAYLOAD",
            "MediaMTX Outbox payload 无效",
          );
        }
        const sessionIds = uniqueMediaSessionIds(
          payload.sessionIds as string[],
        );
        for (const chunk of chunkMediaSessionIds(sessionIds)) {
          const placeholders = chunk.map(() => "?").join(", ");
          this.database
            .prepare(
              `UPDATE media_transport_sessions
               SET closed_at = ?
               WHERE mediamtx_session_id IN (${placeholders})
                 AND closed_at IS NULL`,
            )
            .run(timestamp, ...chunk);
        }
      }
      this.database
        .prepare(
          `UPDATE service_outbox
           SET state = 'completed', lease_until = NULL,
               lease_token_hash = NULL, worker_id = NULL, completed_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, id);
    })();
  }

  public fail(id: string, leaseToken: string, error: string): void {
    const row = this.requireLease(id, leaseToken);
    const delay = Math.min(5 * 60_000, 1000 * 2 ** Math.min(row.attempts, 8));
    const terminal = row.attempts >= MAX_OUTBOX_ATTEMPTS;
    this.database
      .prepare(
        `UPDATE service_outbox
         SET state = ?, not_before = ?, lease_until = NULL,
             lease_token_hash = NULL, worker_id = NULL, last_error = ?
         WHERE id = ?`,
      )
      .run(
        terminal ? "failed" : "pending",
        terminal ? this.now() : this.now() + delay,
        error.slice(0, 1000),
        id,
      );
  }

  public enqueueRemoveParticipant(
    roomId: string,
    memberId: string,
    dedupeKey = uuidv7(),
    rtcIdentity?: string,
  ): void {
    const timestamp = this.now();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO service_outbox(
          id, kind, dedupe_key, payload_json, state, attempts,
          not_before, lease_until, last_error, created_at, completed_at,
          worker_id, lease_token_hash
        ) VALUES (?, 'rtc.remove-participant', ?, ?, 'pending', 0,
          ?, NULL, NULL, ?, NULL, NULL, NULL)`,
      )
      .run(
        uuidv7(),
        `rtc-remove:${dedupeKey}`,
        JSON.stringify({
          roomId,
          memberId,
          ...(rtcIdentity ? { rtcIdentity } : {}),
        }),
        timestamp,
        timestamp,
      );
  }

  public enqueueIfRtcMemberInactive(
    roomId: string,
    identity: string,
    dedupeKey: string,
  ): boolean {
    if (isRtcIdentityActive(this.database, roomId, identity, this.now()))
      return false;
    const memberId = parseRtcIdentity(identity)?.memberId ?? identity;
    this.enqueueRemoveParticipant(roomId, memberId, dedupeKey, identity);
    return true;
  }

  public invalidRtcIdentities(
    roomId: string,
    identities: readonly string[],
  ): string[] {
    const now = this.now();
    return [...new Set(identities)].filter(
      (identity) => !isRtcIdentityActive(this.database, roomId, identity, now),
    );
  }

  public getRtcReconciliationSnapshot(): Array<{
    roomId: string;
    activeMemberIds: string[];
  }> {
    const rows = this.database
      .prepare(
        `SELECT r.id AS room_id, m.member_id
         FROM rooms r
         LEFT JOIN room_members m ON m.room_id = r.id
           AND m.left_at IS NULL AND m.kicked_at IS NULL
         WHERE r.status = 'active'
         ORDER BY r.id, m.member_id`,
      )
      .all() as Array<{ room_id: string; member_id: string | null }>;
    const rooms = new Map<string, string[]>();
    for (const row of rows) {
      const members = rooms.get(row.room_id) ?? [];
      if (row.member_id) members.push(row.member_id);
      rooms.set(row.room_id, members);
    }
    return [...rooms].map(([roomId, activeMemberIds]) => ({
      roomId,
      activeMemberIds,
    }));
  }

  private requireLease(id: string, leaseToken: string): OutboxRow {
    const row = this.database
      .prepare(
        `SELECT id, kind, payload_json, attempts, lease_token_hash
         FROM service_outbox WHERE id = ? AND state = 'leased'`,
      )
      .get(id) as OutboxRow | undefined;
    if (!row) throw notFound("Outbox 任务不存在或未租用");
    if (
      !row.lease_token_hash ||
      !verifyTokenHash(leaseToken, row.lease_token_hash)
    ) {
      throw conflict("LEASE_MISMATCH", "Outbox lease token 不匹配");
    }
    return row;
  }

  private recoverLegacyMediaKickTasks(timestamp: number): void {
    const rows = this.database
      .prepare(
        `SELECT id, payload_json, last_error
         FROM service_outbox
         WHERE kind = 'mediamtx.kick-sessions'
           AND attempts >= ?
           AND (
             state = 'pending'
             OR (state = 'leased' AND lease_until <= ?)
           )
         ORDER BY created_at, id
         LIMIT 100`,
      )
      .all(MAX_OUTBOX_ATTEMPTS, timestamp) as LegacyOutboxRow[];
    const recover = this.database.prepare(
      `UPDATE service_outbox
       SET state = 'pending', attempts = 0, not_before = ?,
           lease_until = NULL, lease_token_hash = NULL, worker_id = NULL,
           last_error = '已兼容旧版 MediaMTX sessionIds 上限并恢复任务'
       WHERE id = ?`,
    );
    for (const row of rows) {
      if (!isLegacyMax32ValidationError(row.last_error)) continue;
      let payload: { sessionIds?: unknown };
      try {
        payload = JSON.parse(row.payload_json) as { sessionIds?: unknown };
      } catch {
        continue;
      }
      if (
        !Array.isArray(payload.sessionIds) ||
        payload.sessionIds.length <= 32 ||
        payload.sessionIds.length > LEGACY_MEDIA_SESSION_KICK_LIMIT ||
        payload.sessionIds.some(
          (sessionId) =>
            typeof sessionId !== "string" || sessionId.length === 0,
        )
      ) {
        continue;
      }
      recover.run(timestamp, row.id);
    }
  }
}

function isLegacyMax32ValidationError(error: string | null): boolean {
  if (!error) return false;
  return (
    /"maximum"\s*:\s*32/.test(error) ||
    /expected array to have <=?32 items/i.test(error) ||
    /too_big[^]*32/i.test(error)
  );
}
