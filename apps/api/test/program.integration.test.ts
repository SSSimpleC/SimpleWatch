import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type BuiltApp } from "../src/app.js";

const origin = "https://watch.example.test";
let built: BuiltApp;
let root: string;
let currentNow = 1_750_000_000_000;

beforeEach(async () => {
  currentNow = 1_750_000_000_000;
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/program-test-"));
  built = await buildApp({
    databasePath: join(root, "simplewatch.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    mediaRoot: join(root, "media"),
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    trashRoot: join(root, "trash"),
    now: () => currentNow,
    authFailureDelay: () => Promise.resolve(),
  });
  await built.authService.bootstrapAdmin(
    "Host",
    "host-test-password-24-characters",
  );
});

afterEach(async () => {
  await built.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("program queue watch coverage", () => {
  it("excludes seeks, requires a decision below 90%, and auto-completes at 90%", async () => {
    const login = await built.authService.login(
      "Host",
      "host-test-password-24-characters",
      "127.0.0.1",
    );
    const account = built.authService.authenticate(login.sessionToken);
    const room = built.roomService.createAccountRoom(account);
    const identity = built.roomService.authenticate(
      login.sessionToken,
      room.roomId,
    );
    const queue = built.programService.getOrCreateActiveQueue(
      account.account_id,
    );
    const firstMedia = seedMedia("Episode 01", 100_000);
    const secondMedia = seedMedia("Episode 02", 100_000);
    const firstItem = seedQueueItem(queue.id, firstMedia, "Episode 01", 0);
    const secondItem = seedQueueItem(queue.id, secondMedia, "Episode 02", 1);

    let snapshot = built.roomService.applyCommand(identity, {
      commandId: uuidv7(),
      expectedRevision: 0,
      effectiveAtServerMs: currentNow + 750,
      command: {
        kind: "activate-queue-item",
        programQueueId: queue.id,
        programItemId: firstItem,
      },
    });
    record(
      room.roomId,
      snapshot.revision,
      queue.id,
      firstItem,
      firstMedia,
      1,
      0,
      true,
      0,
    );
    record(
      room.roomId,
      snapshot.revision,
      queue.id,
      firstItem,
      firstMedia,
      2,
      10,
      true,
      10_000,
    );
    record(
      room.roomId,
      snapshot.revision,
      queue.id,
      firstItem,
      firstMedia,
      3,
      80,
      true,
      15_000,
    );
    record(
      room.roomId,
      snapshot.revision,
      queue.id,
      firstItem,
      firstMedia,
      4,
      85,
      true,
      20_000,
    );
    expect(
      built.programService.getActiveQueue()?.items[0]?.watchCoverage,
    ).toMatchObject({
      coveredMs: 15_000,
      coveredRatio: 0.15,
    });

    expect(() =>
      built.roomService.applyCommand(identity, {
        commandId: uuidv7(),
        expectedRevision: snapshot.revision,
        effectiveAtServerMs: currentNow + 750,
        command: {
          kind: "activate-queue-item",
          programQueueId: queue.id,
          programItemId: secondItem,
        },
      }),
    ).toThrow("当前影片观看不足 90%");
    snapshot = built.roomService.applyCommand(identity, {
      commandId: uuidv7(),
      expectedRevision: snapshot.revision,
      effectiveAtServerMs: currentNow + 750,
      command: {
        kind: "activate-queue-item",
        programQueueId: queue.id,
        programItemId: secondItem,
        departureDecision: "continue-incomplete",
      },
    });
    expect(built.programService.getActiveQueue()?.items[0]).toMatchObject({
      playbackState: "incomplete",
      watchCoverage: { completionKind: "incomplete" },
    });

    record(
      room.roomId,
      snapshot.revision,
      queue.id,
      secondItem,
      secondMedia,
      1,
      0,
      true,
      0,
    );
    record(
      room.roomId,
      snapshot.revision,
      queue.id,
      secondItem,
      secondMedia,
      2,
      95,
      true,
      95_000,
    );
    snapshot = built.roomService.applyCommand(identity, {
      commandId: uuidv7(),
      expectedRevision: snapshot.revision,
      effectiveAtServerMs: currentNow + 750,
      command: {
        kind: "activate-queue-item",
        programQueueId: queue.id,
        programItemId: firstItem,
      },
    });
    expect(snapshot.media?.id).toBe(firstMedia);
    expect(built.programService.getActiveQueue()?.items[1]).toMatchObject({
      playbackState: "completed",
      watchCoverage: { coveredRatio: 0.95, completionKind: "automatic" },
    });
  });

  it("detaches a stale program binding left by a legacy room media switch", async () => {
    const login = await built.authService.login(
      "Host",
      "host-test-password-24-characters",
      "127.0.0.1",
    );
    const account = built.authService.authenticate(login.sessionToken);
    const room = built.roomService.createAccountRoom(account);
    const identity = built.roomService.authenticate(
      login.sessionToken,
      room.roomId,
    );
    const queue = built.programService.getOrCreateActiveQueue(
      account.account_id,
    );
    const firstMedia = seedMedia("Episode 01", 100_000);
    const legacyMedia = seedMedia("Legacy selection", 100_000);
    const firstItem = seedQueueItem(queue.id, firstMedia, "Episode 01", 0);
    built.roomService.applyCommand(identity, {
      commandId: uuidv7(),
      expectedRevision: 0,
      effectiveAtServerMs: currentNow + 750,
      command: {
        kind: "activate-queue-item",
        programQueueId: queue.id,
        programItemId: firstItem,
      },
    });

    built.database
      .prepare("UPDATE room_state SET media_id = ? WHERE room_id = ?")
      .run(legacyMedia, room.roomId);
    expect(built.programService.reconcileRoomBindings()).toBe(1);

    expect(
      built.database
        .prepare(
          `SELECT program_queue_id, current_program_item_id, media_id
           FROM room_state WHERE room_id = ?`,
        )
        .get(room.roomId),
    ).toEqual({
      program_queue_id: null,
      current_program_item_id: null,
      media_id: legacyMedia,
    });
    expect(built.programService.getActiveQueue()?.items[0]).toMatchObject({
      playbackState: "incomplete",
      watchCoverage: { completionKind: "incomplete" },
    });
  });
});

function seedMedia(displayName: string, durationMs: number): string {
  const id = uuidv7();
  built.database
    .prepare(
      `INSERT INTO media(
         id, storage_key, display_name, state, bytes, sha256, mime,
         probe_json, duration_ms, created_at, trashed_at
       ) VALUES (?, ?, ?, 'published', 4, ?, 'video/mp4', '{}', ?, ?, NULL)`,
    )
    .run(
      id,
      `storage-${id}`,
      displayName,
      "a".repeat(64),
      durationMs,
      currentNow,
    );
  return id;
}

function seedQueueItem(
  queueId: string,
  mediaId: string,
  displayName: string,
  position: number,
): string {
  const id = uuidv7();
  built.database
    .prepare(
      `INSERT INTO program_queue_items(
         id, queue_id, catalog_version_id, transfer_job_id, media_id,
         display_name, position, preparation_state, playback_state,
         pinned, created_at, updated_at, activated_at, finished_at
       ) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'ready', 'upcoming',
                 0, ?, ?, NULL, NULL)`,
    )
    .run(id, queueId, mediaId, displayName, position, currentNow, currentNow);
  return id;
}

function record(
  roomId: string,
  roomRevision: number,
  programQueueId: string,
  programItemId: string,
  mediaId: string,
  sequence: number,
  positionSec: number,
  playing: boolean,
  sampledAtClientMs: number,
): void {
  built.programService.recordProgress(roomId, {
    roomRevision,
    programQueueId,
    programItemId,
    mediaId,
    sequence,
    positionSec,
    playing,
    rate: 1,
    sampledAtClientMs,
  });
}
