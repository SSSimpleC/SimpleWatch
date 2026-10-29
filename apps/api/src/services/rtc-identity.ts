import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

import type { AppDatabase } from "../database.js";

const uuid = z.string().uuid();

export interface RtcLease {
  readonly member_id: string;
  readonly session_hash: string;
  readonly device_id: string;
  readonly acquired_at: number;
}

export function rtcIdentity(
  lease: Pick<RtcLease, "member_id" | "device_id" | "acquired_at">,
): string {
  return `v2:${lease.member_id}:${lease.device_id}:${lease.acquired_at}`;
}

export function parseRtcIdentity(value: string): {
  memberId: string;
  deviceId: string;
  leaseEpoch: number;
} | null {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "v2") return null;
  const [, memberId, deviceId, epoch] = parts;
  if (
    !uuid.safeParse(memberId).success ||
    !uuid.safeParse(deviceId).success ||
    !epoch ||
    !/^[1-9]\d{0,15}$/.test(epoch)
  )
    return null;
  const leaseEpoch = Number(epoch);
  if (!Number.isSafeInteger(leaseEpoch)) return null;
  return { memberId: memberId!, deviceId: deviceId!, leaseEpoch };
}

/** Capture before replacing/deleting a lease. Never resolve an old task to a new owner. */
export function getRtcLease(
  database: AppDatabase,
  memberId: string,
): RtcLease | undefined {
  return database
    .prepare(
      "SELECT member_id, session_hash, device_id, acquired_at FROM room_device_leases WHERE member_id = ?",
    )
    .get(memberId) as RtcLease | undefined;
}

export function isRtcIdentityActive(
  database: AppDatabase,
  roomId: string,
  identity: string,
  now: number,
): boolean {
  const parsed = parseRtcIdentity(identity);
  if (!parsed) return false;
  return !!database
    .prepare(
      `SELECT 1 FROM room_device_leases l
     JOIN room_members m ON m.member_id = l.member_id
     JOIN rooms r ON r.id = m.room_id
     JOIN account_sessions s ON s.id_hash = l.session_hash
     JOIN accounts a ON a.id = s.account_id
     WHERE r.id = ? AND r.status = 'active' AND m.member_id = ?
       AND m.left_at IS NULL AND m.kicked_at IS NULL
       AND m.account_id = s.account_id AND a.enabled = 1
       AND l.device_id = ? AND s.device_id = l.device_id AND l.acquired_at = ?
       AND s.revoked_at IS NULL AND s.idle_expires_at > ? AND s.absolute_expires_at > ?`,
    )
    .get(roomId, parsed.memberId, parsed.deviceId, parsed.leaseEpoch, now, now);
}

export function enqueueRtcRevocation(
  database: AppDatabase,
  input: {
    roomId: string;
    memberId: string;
    identity: string;
    reason: string;
    timestamp: number;
  },
): void {
  const id = uuidv7();
  database
    .prepare(
      `INSERT INTO rtc_revocations(id, room_id, member_id, identity, reason, revoked_at, cleared_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      input.roomId,
      input.memberId,
      input.identity,
      input.reason,
      input.timestamp,
    );
  database
    .prepare(
      `INSERT INTO service_outbox(
      id, kind, dedupe_key, payload_json, state, attempts,
      not_before, lease_until, last_error, created_at, completed_at
    ) VALUES (?, 'rtc.remove-participant', ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
    )
    .run(
      uuidv7(),
      `rtc-remove:${id}`,
      JSON.stringify({
        roomId: input.roomId,
        memberId: input.memberId,
        rtcIdentity: input.identity,
      }),
      input.timestamp,
      input.timestamp,
    );
}
