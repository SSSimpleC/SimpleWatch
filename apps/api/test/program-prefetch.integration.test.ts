import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type BuiltApp } from "../src/app.js";
import { EdgeEvictionService } from "../src/services/edge-eviction-service.js";

const origin = "https://watch.example.test";
const fixedNow = 1_750_000_000_000;
let built: BuiltApp;
let root: string;

beforeEach(async () => {
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/program-prefetch-test-"));
  built = await buildApp({
    databasePath: join(root, "simplewatch.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    mediaRoot: join(root, "media"),
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    trashRoot: join(root, "trash"),
    now: () => fixedNow,
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

describe("Program two-slot prefetch and cache protection", () => {
  it("prefetches exactly the first two items and repeated reconciliation does not spill into later episodes", () => {
    const fixture = seedProgram(4);

    expect(itemPreparation(fixture.queueId)).toEqual([
      "queued",
      "queued",
      "pending",
      "pending",
    ]);
    expect(count("edge_transfer_jobs")).toBe(2);
    expect(count("edge_agent_tasks")).toBe(2);

    built.programService.reconcilePrefetch(fixture.queueId, fixture.ownerId);
    expect(itemPreparation(fixture.queueId)).toEqual([
      "queued",
      "queued",
      "pending",
      "pending",
    ]);
    expect(count("edge_transfer_jobs")).toBe(2);
    expect(count("edge_agent_tasks")).toBe(2);
  });

  it("uses current plus next, then current plus retained-incomplete, without a third automatic slot", async () => {
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
    const fixture = seedProgram(4, account.account_id);
    const first = promoteReady(fixture.itemIds[0]!);
    const second = promoteReady(fixture.itemIds[1]!);
    built.programService.recomputeActiveProtection();

    expect(automaticProtectedItemIds()).toEqual(
      new Set([fixture.itemIds[0], fixture.itemIds[1]]),
    );
    let snapshot = built.roomService.applyCommand(identity, {
      commandId: uuidv7(),
      expectedRevision: 0,
      effectiveAtServerMs: fixedNow + 750,
      command: {
        kind: "activate-queue-item",
        programQueueId: fixture.queueId,
        programItemId: fixture.itemIds[0]!,
      },
    });
    expect(snapshot.media?.id).toBe(first.mediaId);
    expect(itemPreparation(fixture.queueId)).toEqual([
      "ready",
      "ready",
      "pending",
      "pending",
    ]);
    expect(automaticProtectedItemIds()).toEqual(
      new Set([fixture.itemIds[0], fixture.itemIds[1]]),
    );

    snapshot = built.roomService.applyCommand(identity, {
      commandId: uuidv7(),
      expectedRevision: snapshot.revision,
      effectiveAtServerMs: fixedNow + 750,
      command: {
        kind: "activate-queue-item",
        programQueueId: fixture.queueId,
        programItemId: fixture.itemIds[1]!,
        departureDecision: "continue-incomplete",
      },
    });
    expect(snapshot.media?.id).toBe(second.mediaId);
    expect(itemPlayback(fixture.queueId)).toEqual([
      "incomplete",
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(itemPreparation(fixture.queueId)).toEqual([
      "ready",
      "ready",
      "pending",
      "pending",
    ]);
    expect(automaticProtectedItemIds()).toEqual(
      new Set([fixture.itemIds[0], fixture.itemIds[1]]),
    );
    expect(count("edge_transfer_jobs")).toBe(2);
    expect(count("edge_agent_tasks")).toBe(2);
  });

  it("automatic recovery selects only an eligible cache, never window-protected, playing or pinned replicas", async () => {
    const login = await built.authService.login(
      "Host",
      "host-test-password-24-characters",
      "127.0.0.1",
    );
    const account = built.authService.authenticate(login.sessionToken);
    const room = built.roomService.createAccountRoom(account);
    const fixture = seedProgram(5, account.account_id);
    const ready = fixture.itemIds
      .slice(0, 4)
      .map((itemId) => promoteReady(itemId));
    built.database
      .prepare(
        `UPDATE program_queue_items SET playback_state = 'incomplete'
         WHERE id = ?`,
      )
      .run(fixture.itemIds[0]);
    built.database
      .prepare(
        `UPDATE program_queue_items SET playback_state = 'current'
         WHERE id = ?`,
      )
      .run(fixture.itemIds[1]);
    built.database
      .prepare(
        `UPDATE room_state
         SET mode = 'vod', media_id = ?, program_queue_id = ?,
             current_program_item_id = ? WHERE room_id = ?`,
      )
      .run(ready[1]!.mediaId, fixture.queueId, fixture.itemIds[1], room.roomId);
    built.database
      .prepare("UPDATE program_queue_items SET pinned = 1 WHERE id = ?")
      .run(fixture.itemIds[2]);
    built.database
      .prepare("UPDATE edge_cache_replicas SET pinned = 1 WHERE id = ?")
      .run(ready[2]!.replicaId);
    built.programService.recomputeActiveProtection();

    expect(automaticProtectedItemIds()).toEqual(
      new Set([fixture.itemIds[0], fixture.itemIds[1]]),
    );
    expect(replicaState(ready[2]!.replicaId)).toMatchObject({
      state: "protected",
      pinned: 1,
      protected_reason: "program-pin",
    });
    expect(replicaState(ready[3]!.replicaId)).toMatchObject({
      state: "eligible",
      pinned: 0,
      protected_reason: null,
    });
    // 即使状态账本异常把播放中副本降成 eligible，活动 room_state 仍必须
    // 作为最后一道删除护栏；放大它的体积，确保没有护栏时它会优先中选。
    built.database
      .prepare(
        `UPDATE edge_cache_replicas SET state = 'eligible', protected_reason = NULL
         WHERE id = ?`,
      )
      .run(ready[1]!.replicaId);
    built.database
      .prepare("UPDATE media SET bytes = 100 WHERE id = ?")
      .run(ready[1]!.mediaId);

    const blockedTransferId = createBlockedTransferForItem(
      fixture.itemIds[4]!,
      fixture.agentId,
      fixture.ownerId,
    );
    const eviction = new EdgeEvictionService(
      built.database,
      built.edgeTaskService,
      join(root, "media"),
      join(root, "trash"),
      () => fixedNow,
      () => 0,
    );
    eviction.reconcile();

    expect(
      built.database
        .prepare(
          `SELECT cache_replica_id FROM edge_eviction_jobs
           WHERE state IN ('queued', 'verifying_source', 'evicting')`,
        )
        .all(),
    ).toEqual([{ cache_replica_id: ready[3]!.replicaId }]);
    expect(
      built.database
        .prepare("SELECT state FROM edge_transfer_jobs WHERE id = ?")
        .get(blockedTransferId),
    ).toEqual({ state: "blocked_storage" });
  });
});

function seedProgram(count: number, ownerId = hostId()) {
  const agent = built.edgeAuthService.enroll({
    displayName: "SimpleServer",
    softwareVersion: "0.1.0",
  });
  const versions = Array.from({ length: count }, (_, index) =>
    seedCatalogVersion(agent.agentId, index + 1),
  );
  const queue = built.programService.getOrCreateActiveQueue(ownerId);
  const updated = built.programService.addItems(
    ownerId,
    queue.revision,
    versions.map((version) => version.versionId),
  );
  return {
    agentId: agent.agentId,
    ownerId,
    queueId: updated.id,
    itemIds: updated.items.map((item) => item.id),
  };
}

function seedCatalogVersion(agentId: string, episode: number) {
  const itemId = uuidv7();
  const versionId = uuidv7();
  const sha256 = episode.toString(16).padStart(64, "0");
  built.database
    .prepare(
      `INSERT INTO edge_catalog_items(
         id, agent_id, local_id, relative_path, display_name, source_state,
         first_seen_at, last_seen_at, missing_at, created_at, updated_at,
         current_version_id
       ) VALUES (?, ?, ?, ?, ?, 'present', ?, ?, NULL, ?, ?, NULL)`,
    )
    .run(
      itemId,
      agentId,
      `episode-${episode}`,
      `Series/Episode ${episode}.mp4`,
      `Episode ${episode}.mp4`,
      fixedNow,
      fixedNow,
      fixedNow,
      fixedNow,
    );
  built.database
    .prepare(
      `INSERT INTO edge_catalog_versions(
         id, catalog_item_id, version_number, bytes, mtime_ms, sha256,
         source_state, first_seen_at, last_verified_at, missing_at, created_at
       ) VALUES (?, ?, 1, 4, ?, ?, 'present', ?, ?, NULL, ?)`,
    )
    .run(
      versionId,
      itemId,
      fixedNow - 1000,
      sha256,
      fixedNow,
      fixedNow,
      fixedNow,
    );
  built.database
    .prepare(
      "UPDATE edge_catalog_items SET current_version_id = ? WHERE id = ?",
    )
    .run(versionId, itemId);
  return { versionId, sha256 };
}

function promoteReady(itemId: string) {
  const item = built.database
    .prepare(
      `SELECT i.catalog_version_id, i.transfer_job_id, i.position,
              v.sha256, c.agent_id
       FROM program_queue_items i
       JOIN edge_catalog_versions v ON v.id = i.catalog_version_id
       JOIN edge_catalog_items c ON c.id = v.catalog_item_id
       WHERE i.id = ?`,
    )
    .get(itemId) as {
    readonly catalog_version_id: string;
    readonly transfer_job_id: string | null;
    readonly position: number;
    readonly sha256: string;
    readonly agent_id: string;
  };
  const transferId = item.transfer_job_id ?? uuidv7();
  const mediaId = uuidv7();
  const replicaId = uuidv7();
  built.database
    .prepare(
      `INSERT INTO media(
         id, storage_key, display_name, state, bytes, sha256, mime,
         probe_json, duration_ms, created_at, trashed_at, playback_support
       ) VALUES (?, ?, ?, 'published', 4, ?, 'video/mp4', '{}', 100000,
                 ?, NULL, 'direct')`,
    )
    .run(
      mediaId,
      `storage-${mediaId}`,
      `Episode ${item.position + 1}`,
      item.sha256,
      fixedNow,
    );
  if (!item.transfer_job_id) {
    insertTransfer(
      transferId,
      item.agent_id,
      item.catalog_version_id,
      hostId(),
      "ready",
      item.sha256,
      mediaId,
    );
  } else {
    built.database
      .prepare(
        `UPDATE edge_transfer_jobs
         SET state = 'ready', media_id = ?, transferred_bytes = declared_bytes,
             ready_at = ?, finished_at = ? WHERE id = ?`,
      )
      .run(mediaId, fixedNow, fixedNow, transferId);
  }
  built.database
    .prepare(
      `UPDATE program_queue_items
       SET transfer_job_id = ?, media_id = ?, preparation_state = 'ready'
       WHERE id = ?`,
    )
    .run(transferId, mediaId, itemId);
  built.database
    .prepare(
      `INSERT INTO edge_cache_replicas(
         id, agent_id, catalog_version_id, transfer_job_id, media_id,
         state, pinned, generation, row_version, source_sha256,
         source_verified_at, protected_reason, created_at, updated_at, evicted_at
       ) VALUES (?, ?, ?, ?, ?, 'ready', 0, 1, 0, ?, ?, NULL, ?, ?, NULL)`,
    )
    .run(
      replicaId,
      item.agent_id,
      item.catalog_version_id,
      transferId,
      mediaId,
      item.sha256,
      fixedNow,
      fixedNow,
      fixedNow,
    );
  return { transferId, mediaId, replicaId };
}

function createBlockedTransferForItem(
  itemId: string,
  agentId: string,
  ownerId: string,
): string {
  const item = built.database
    .prepare(`SELECT catalog_version_id FROM program_queue_items WHERE id = ?`)
    .get(itemId) as { readonly catalog_version_id: string };
  const sha256 = (
    built.database
      .prepare("SELECT sha256 FROM edge_catalog_versions WHERE id = ?")
      .get(item.catalog_version_id) as { readonly sha256: string }
  ).sha256;
  const transferId = uuidv7();
  insertTransfer(
    transferId,
    agentId,
    item.catalog_version_id,
    ownerId,
    "blocked_storage",
    sha256,
    null,
  );
  built.database
    .prepare(
      `UPDATE program_queue_items
       SET transfer_job_id = ?, media_id = NULL, preparation_state = 'blocked'
       WHERE id = ?`,
    )
    .run(transferId, itemId);
  return transferId;
}

function insertTransfer(
  id: string,
  agentId: string,
  versionId: string,
  ownerId: string,
  state: "ready" | "blocked_storage",
  sha256: string,
  mediaId: string | null,
): void {
  built.database
    .prepare(
      `INSERT INTO edge_transfer_jobs(
         id, agent_id, catalog_version_id, owner_account_id, state, priority,
         declared_bytes, transferred_bytes, expected_sha256, upload_id,
         media_id, attempts, max_attempts, error_code, error_message,
         speed_bytes_per_second, last_progress_at, created_at, updated_at,
         ready_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, 1000, 4, ?, ?, NULL, ?, 0, 5,
                 NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      agentId,
      versionId,
      ownerId,
      state,
      state === "ready" ? 4 : 0,
      sha256,
      mediaId,
      fixedNow,
      fixedNow,
      state === "ready" ? fixedNow : null,
      state === "ready" ? fixedNow : null,
    );
}

function automaticProtectedItemIds(): Set<string> {
  return new Set(
    (
      built.database
        .prepare(
          `SELECT i.id FROM edge_cache_replicas r
           JOIN program_queue_items i ON i.transfer_job_id = r.transfer_job_id
           WHERE r.state = 'protected' AND r.protected_reason = 'program-window'`,
        )
        .all() as Array<{ readonly id: string }>
    ).map((row) => row.id),
  );
}

function replicaState(replicaId: string) {
  return built.database
    .prepare(
      `SELECT state, pinned, protected_reason
       FROM edge_cache_replicas WHERE id = ?`,
    )
    .get(replicaId);
}

function itemPreparation(queueId: string): string[] {
  return (
    built.database
      .prepare(
        `SELECT preparation_state FROM program_queue_items
         WHERE queue_id = ? ORDER BY position`,
      )
      .all(queueId) as Array<{ readonly preparation_state: string }>
  ).map((row) => row.preparation_state);
}

function itemPlayback(queueId: string): string[] {
  return (
    built.database
      .prepare(
        `SELECT playback_state FROM program_queue_items
         WHERE queue_id = ? ORDER BY position`,
      )
      .all(queueId) as Array<{ readonly playback_state: string }>
  ).map((row) => row.playback_state);
}

function count(table: "edge_transfer_jobs" | "edge_agent_tasks"): number {
  return (
    built.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      readonly count: number;
    }
  ).count;
}

function hostId(): string {
  return (
    built.database
      .prepare("SELECT id FROM accounts WHERE username_folded = 'host'")
      .get() as { readonly id: string }
  ).id;
}
