import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type BuiltApp } from "../src/app.js";
import { EdgeEvictionService } from "../src/services/edge-eviction-service.js";

const origin = "https://watch.example.test";
const fixedNow = 1_750_000_000_000;
const gibibyte = 1024 * 1024 * 1024;
let currentNow = fixedNow;
let built: BuiltApp;
let root: string;
let mediaRoot: string;
let trashRoot: string;

beforeEach(async () => {
  currentNow = fixedNow;
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/edge-auto-eviction-test-"));
  mediaRoot = join(root, "media");
  trashRoot = join(root, "trash");
  built = await buildApp({
    databasePath: join(root, "simplewatch.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    mediaRoot,
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    trashRoot,
    tusEndpoint: `${origin}/files/`,
    contentSigningSecret: "test-content-signing-secret-32-bytes",
    internalHookToken: "test-internal-service-token-32-bytes",
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

describe("Edge cloud storage recovery", () => {
  it("evicts only an eligible verified cache before retrying an active blocked prefetch", () => {
    const host = built.database
      .prepare("SELECT id FROM accounts WHERE username_folded = 'host'")
      .get() as { readonly id: string };
    const agent = built.edgeAuthService.enroll({
      displayName: "SimpleServer",
      softwareVersion: "0.1.0",
    });
    const candidate = seedCatalogVersion(agent.agentId, "cached", 2 * gibibyte);
    const blocked = seedCatalogVersion(agent.agentId, "next", 4 * gibibyte);
    const candidateTransferId = uuidv7();
    const blockedTransferId = uuidv7();
    const mediaId = uuidv7();
    const replicaId = uuidv7();
    const queueId = uuidv7();
    const storageKey = "edge-cache-candidate";

    mkdirSync(join(mediaRoot, storageKey), { recursive: true });
    writeFileSync(join(mediaRoot, storageKey, "content.mp4"), "cached");
    built.database
      .prepare(
        `INSERT INTO media(
           id, storage_key, display_name, state, bytes, sha256, mime,
           probe_json, duration_ms, created_at, trashed_at, playback_support
         ) VALUES (?, ?, 'Cached.mp4', 'published', ?, ?, 'video/mp4',
                   '{}', 1000, ?, NULL, 'direct')`,
      )
      .run(mediaId, storageKey, candidate.bytes, candidate.sha256, currentNow);
    insertTransfer(
      candidateTransferId,
      agent.agentId,
      candidate.versionId,
      host.id,
      "ready",
      candidate.bytes,
      candidate.sha256,
      mediaId,
    );
    built.database
      .prepare(
        `INSERT INTO edge_cache_replicas(
           id, agent_id, catalog_version_id, transfer_job_id, media_id,
           state, pinned, generation, row_version, source_sha256,
           source_verified_at, protected_reason, created_at, updated_at,
           evicted_at
         ) VALUES (?, ?, ?, ?, ?, 'eligible', 0, 1, 0, ?, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        replicaId,
        agent.agentId,
        candidate.versionId,
        candidateTransferId,
        mediaId,
        candidate.sha256,
        currentNow,
        currentNow,
        currentNow,
      );
    insertTransfer(
      blockedTransferId,
      agent.agentId,
      blocked.versionId,
      host.id,
      "blocked_storage",
      blocked.bytes,
      blocked.sha256,
      null,
    );
    built.database
      .prepare(
        `INSERT INTO program_queues(
           id, owner_account_id, display_name, state, revision,
           created_at, updated_at, completed_at, cleared_at
         ) VALUES (?, ?, 'Storage recovery', 'active', 1, ?, ?, NULL, NULL)`,
      )
      .run(queueId, host.id, currentNow, currentNow);
    built.database
      .prepare(
        `INSERT INTO program_queue_items(
           id, queue_id, catalog_version_id, transfer_job_id, media_id,
           display_name, position, preparation_state, playback_state,
           pinned, created_at, updated_at, activated_at, finished_at
         ) VALUES (?, ?, ?, ?, NULL, 'Next.mp4', 0, 'blocked', 'upcoming',
                   0, ?, ?, NULL, NULL)`,
      )
      .run(
        uuidv7(),
        queueId,
        blocked.versionId,
        blockedTransferId,
        currentNow,
        currentNow,
      );

    let availableBytes = 0;
    const service = new EdgeEvictionService(
      built.database,
      built.edgeTaskService,
      mediaRoot,
      trashRoot,
      () => currentNow,
      () => availableBytes,
    );

    service.reconcile();
    expect(
      built.database
        .prepare(
          "SELECT state FROM edge_eviction_jobs WHERE cache_replica_id = ?",
        )
        .get(replicaId),
    ).toEqual({ state: "queued" });
    service.reconcile();
    expect(
      built.database
        .prepare("SELECT state, media_id FROM edge_cache_replicas WHERE id = ?")
        .get(replicaId),
    ).toEqual({ state: "evicted", media_id: null });
    expect(
      built.database
        .prepare("SELECT state FROM edge_transfer_jobs WHERE id = ?")
        .get(blockedTransferId),
    ).toEqual({ state: "blocked_storage" });

    availableBytes = 24 * gibibyte;
    currentNow += 1000;
    service.reconcile();
    expect(
      built.database
        .prepare("SELECT state FROM edge_transfer_jobs WHERE id = ?")
        .get(blockedTransferId),
    ).toEqual({ state: "queued" });
    expect(
      built.database
        .prepare(
          `SELECT state, kind FROM edge_agent_tasks
           WHERE json_extract(payload_json, '$.edgeTransferId') = ?`,
        )
        .get(blockedTransferId),
    ).toEqual({ state: "queued", kind: "upload" });
  });
});

function seedCatalogVersion(agentId: string, name: string, bytes: number) {
  const itemId = uuidv7();
  const versionId = uuidv7();
  const sha256 = name
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^a-f0-9]/g, "a");
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
      `local-${name}`,
      `${name}.mp4`,
      `${name}.mp4`,
      currentNow,
      currentNow,
      currentNow,
      currentNow,
    );
  built.database
    .prepare(
      `INSERT INTO edge_catalog_versions(
         id, catalog_item_id, version_number, bytes, mtime_ms, sha256,
         source_state, first_seen_at, last_verified_at, missing_at, created_at
       ) VALUES (?, ?, 1, ?, ?, ?, 'present', ?, ?, NULL, ?)`,
    )
    .run(
      versionId,
      itemId,
      bytes,
      currentNow - 1000,
      sha256,
      currentNow,
      currentNow,
      currentNow,
    );
  built.database
    .prepare(
      "UPDATE edge_catalog_items SET current_version_id = ? WHERE id = ?",
    )
    .run(versionId, itemId);
  return { versionId, bytes, sha256 };
}

function insertTransfer(
  id: string,
  agentId: string,
  versionId: string,
  ownerId: string,
  state: "ready" | "blocked_storage",
  bytes: number,
  sha256: string,
  mediaId: string | null,
) {
  built.database
    .prepare(
      `INSERT INTO edge_transfer_jobs(
         id, agent_id, catalog_version_id, owner_account_id, state, priority,
         declared_bytes, transferred_bytes, expected_sha256, upload_id,
         media_id, attempts, max_attempts, error_code, error_message,
         speed_bytes_per_second, last_progress_at, created_at, updated_at,
         ready_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, 1000, ?, ?, ?, NULL, ?, 0, 5,
                 NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      agentId,
      versionId,
      ownerId,
      state,
      bytes,
      state === "ready" ? bytes : 0,
      sha256,
      mediaId,
      currentNow,
      currentNow,
      state === "ready" ? currentNow : null,
      state === "ready" ? currentNow : null,
    );
}
