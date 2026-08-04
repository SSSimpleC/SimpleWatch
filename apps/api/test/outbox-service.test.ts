import { resolve } from "node:path";

import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/database.js";
import { enqueueMediaSessionKicks } from "../src/services/media-session-outbox.js";
import {
  MAX_OUTBOX_ATTEMPTS,
  OutboxService,
} from "../src/services/outbox-service.js";

const fixedNow = 1_750_000_000_000;
let currentNow = fixedNow;
let database: AppDatabase;
let outbox: OutboxService;

beforeEach(() => {
  currentNow = fixedNow;
  database = openDatabase({
    databasePath: ":memory:",
    migrationsPath: resolve("migrations"),
    now: () => currentNow,
  });
  outbox = new OutboxService(database, () => currentNow);
});

afterEach(() => {
  database.close();
});

describe("OutboxService", () => {
  it("deduplicates MediaMTX sessions and emits no more than 32 per task", () => {
    // Arrange
    const uniqueIds = Array.from(
      { length: 65 },
      (_, index) => `session-${index}`,
    );

    // Act
    const inserted = enqueueMediaSessionKicks(database, {
      roomId: "room",
      memberId: "member",
      sessionIds: [...uniqueIds, "session-0", "session-32"],
      dedupeKey: "media-kick:test",
      timestamp: currentNow,
    });
    const rows = database
      .prepare(
        `SELECT dedupe_key, payload_json
         FROM service_outbox
         WHERE kind = 'mediamtx.kick-sessions'
         ORDER BY rowid`,
      )
      .all() as Array<{ dedupe_key: string; payload_json: string }>;
    const payloads = rows.map(
      (row) =>
        JSON.parse(row.payload_json) as {
          roomId: string;
          memberId: string;
          sessionIds: string[];
        },
    );

    // Assert
    expect(inserted).toBe(3);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      "media-kick:test",
      "media-kick:test:1",
      "media-kick:test:2",
    ]);
    expect(payloads.map((payload) => payload.sessionIds.length)).toEqual([
      32, 32, 1,
    ]);
    expect(payloads.flatMap((payload) => payload.sessionIds)).toEqual(
      uniqueIds,
    );
  });

  it("recovers a high-attempt legacy max-32 task once, then dead-letters after bounded retries", () => {
    // Arrange
    const id = uuidv7();
    const sessionIds = Array.from(
      { length: 44 },
      (_, index) => `legacy-session-${index}`,
    );
    database
      .prepare(
        `INSERT INTO service_outbox(
          id, kind, dedupe_key, payload_json, state, attempts,
          not_before, lease_until, last_error, created_at, completed_at,
          worker_id, lease_token_hash
        ) VALUES (?, 'mediamtx.kick-sessions', ?, ?, 'pending', 4959,
          ?, NULL, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        id,
        `legacy:${id}`,
        JSON.stringify({ roomId: "room", memberId: "all", sessionIds }),
        currentNow,
        JSON.stringify([
          {
            origin: "array",
            code: "too_big",
            maximum: 32,
            path: ["sessionIds"],
            message: "Too big: expected array to have <=32 items",
          },
        ]),
        currentNow,
      );

    // Act + Assert: the production legacy row is recovered before the generic
    // attempts cap can mark it failed.
    let claimed = outbox.claim("worker-1");
    expect(claimed).toMatchObject({
      id,
      kind: "mediamtx.kick-sessions",
      attempts: 1,
      payload: { sessionIds },
    });

    for (let attempt = 1; attempt <= MAX_OUTBOX_ATTEMPTS; attempt += 1) {
      expect(claimed).not.toBeNull();
      outbox.fail(id, claimed?.leaseToken ?? "", "downstream unavailable");
      const state = database
        .prepare(
          "SELECT state, attempts, last_error FROM service_outbox WHERE id = ?",
        )
        .get(id) as {
        state: string;
        attempts: number;
        last_error: string | null;
      };
      expect(state.attempts).toBe(attempt);
      expect(state.state).toBe(
        attempt === MAX_OUTBOX_ATTEMPTS ? "failed" : "pending",
      );
      expect(state.last_error).toBe("downstream unavailable");
      if (attempt < MAX_OUTBOX_ATTEMPTS) {
        currentNow += 10 * 60_000;
        claimed = outbox.claim(`worker-${attempt + 1}`);
        expect(claimed?.attempts).toBe(attempt + 1);
      }
    }

    expect(outbox.claim("worker-after-dead-letter")).toBeNull();
  });

  it("closes only payload-named MediaMTX sessions even when memberId is all", () => {
    // Arrange
    const seeded = seedRoom("active");
    for (const sessionId of ["target-a", "target-b", "untouched"]) {
      database
        .prepare(
          `INSERT INTO media_transport_sessions(
            id, room_id, member_id, jti_hash, mediamtx_session_id,
            action, path, connected_at, closed_at
          ) VALUES (?, ?, ?, ?, ?, 'read', 'program/test', ?, NULL)`,
        )
        .run(
          uuidv7(),
          seeded.roomId,
          seeded.memberId,
          `jti:${sessionId}`,
          sessionId,
          currentNow,
        );
    }
    enqueueMediaSessionKicks(database, {
      roomId: seeded.roomId,
      memberId: "all",
      sessionIds: ["target-a", "target-b", "target-a"],
      dedupeKey: "force-close:test",
      timestamp: currentNow,
    });

    // Act
    const claimed = outbox.claim("worker");
    expect(claimed?.kind).toBe("mediamtx.kick-sessions");
    outbox.complete(claimed?.id ?? "", claimed?.leaseToken ?? "");
    const rows = database
      .prepare(
        `SELECT mediamtx_session_id, closed_at
         FROM media_transport_sessions
         ORDER BY mediamtx_session_id`,
      )
      .all() as Array<{
      mediamtx_session_id: string;
      closed_at: number | null;
    }>;

    // Assert
    expect(rows).toEqual([
      { mediamtx_session_id: "target-a", closed_at: fixedNow },
      { mediamtx_session_id: "target-b", closed_at: fixedNow },
      { mediamtx_session_id: "untouched", closed_at: null },
    ]);
  });

  it("reconciles RTC membership for active rooms only", () => {
    // Arrange
    const active = seedRoom("active");
    seedRoom("closed");

    // Act
    const snapshot = outbox.getRtcReconciliationSnapshot();

    // Assert
    expect(snapshot).toEqual([
      { roomId: active.roomId, activeMemberIds: [active.memberId] },
    ]);
  });
});

function seedRoom(status: "active" | "closed"): {
  roomId: string;
  memberId: string;
} {
  const adminId = uuidv7();
  const roomId = uuidv7();
  const memberId = uuidv7();
  database
    .prepare(
      `INSERT INTO admin_users(
        id, username, password_hash, created_at, password_changed_at
      ) VALUES (?, ?, 'hash', ?, ?)`,
    )
    .run(adminId, `admin-${adminId}`, currentNow, currentNow);
  database
    .prepare(
      `INSERT INTO rooms(
        id, password_hash, status, max_members, created_by, created_at, closed_at
      ) VALUES (?, 'hash', ?, 5, ?, ?, ?)`,
    )
    .run(
      roomId,
      status,
      adminId,
      currentNow,
      status === "closed" ? currentNow : null,
    );
  database
    .prepare(
      `INSERT INTO room_members(
        member_id, room_id, nickname, nickname_folded, role,
        joined_at, last_seen_at, left_at, kicked_at, account_id
      ) VALUES (?, ?, ?, ?, 'host', ?, ?, NULL, NULL, NULL)`,
    )
    .run(
      memberId,
      roomId,
      `member-${memberId}`,
      `member-${memberId}`,
      currentNow,
      currentNow,
    );
  return { roomId, memberId };
}
