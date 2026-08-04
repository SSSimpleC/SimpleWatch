import { v7 as uuidv7 } from "uuid";

import type { AppDatabase } from "../database.js";

export const MEDIA_SESSION_KICK_BATCH_SIZE = 32;
export const LEGACY_MEDIA_SESSION_KICK_LIMIT = 512;

interface EnqueueMediaSessionKicksInput {
  readonly roomId: string;
  readonly memberId: string;
  readonly sessionIds: readonly string[];
  readonly dedupeKey: string;
  readonly timestamp: number;
}

export function uniqueMediaSessionIds(sessionIds: readonly string[]): string[] {
  return [...new Set(sessionIds)];
}

export function chunkMediaSessionIds(
  sessionIds: readonly string[],
  size = MEDIA_SESSION_KICK_BATCH_SIZE,
): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("MediaMTX sessionIds 分块大小必须为正整数");
  }
  const chunks: string[][] = [];
  for (let index = 0; index < sessionIds.length; index += size) {
    chunks.push(sessionIds.slice(index, index + size));
  }
  return chunks;
}

export function enqueueMediaSessionKicks(
  database: AppDatabase,
  input: EnqueueMediaSessionKicksInput,
): number {
  const chunks = chunkMediaSessionIds(uniqueMediaSessionIds(input.sessionIds));
  const insert = database.prepare(
    `INSERT OR IGNORE INTO service_outbox(
      id, kind, dedupe_key, payload_json, state, attempts,
      not_before, lease_until, last_error, created_at, completed_at
    ) VALUES (?, 'mediamtx.kick-sessions', ?, ?, 'pending', 0,
      ?, NULL, NULL, ?, NULL)`,
  );
  let inserted = 0;
  for (const [index, sessionIds] of chunks.entries()) {
    const dedupeKey =
      index === 0 ? input.dedupeKey : `${input.dedupeKey}:${index}`;
    inserted += insert.run(
      uuidv7(),
      dedupeKey,
      JSON.stringify({
        roomId: input.roomId,
        memberId: input.memberId,
        sessionIds,
      }),
      input.timestamp,
      input.timestamp,
    ).changes;
  }
  return inserted;
}
