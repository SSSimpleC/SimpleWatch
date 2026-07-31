import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type BuiltApp } from "../src/app.js";
import {
  EDGE_RETRY_BACKOFF_MAX_MILLISECONDS,
  edgeRetryBackoff,
} from "../src/services/edge-task-service.js";

const origin = "https://watch.example.test";
const internalToken = "test-internal-service-token-32-bytes";
const fixedNow = 1_750_000_000_000;
let currentNow = fixedNow;
let built: BuiltApp;
let root: string;

beforeEach(async () => {
  currentNow = fixedNow;
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/edge-failure-test-"));
  built = await buildApp({
    databasePath: join(root, "simplewatch.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    mediaRoot: join(root, "media"),
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    trashRoot: join(root, "trash"),
    tusEndpoint: `${origin}/files/`,
    contentSigningSecret: "test-content-signing-secret-32-bytes",
    internalHookToken: internalToken,
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

describe("Edge failure fencing and lifecycle", () => {
  it("caps cloud retry full-jitter at fifteen minutes", () => {
    expect(edgeRetryBackoff(1, () => 0)).toBe(0);
    expect(edgeRetryBackoff(30, () => 1)).toBe(
      EDGE_RETRY_BACKOFF_MAX_MILLISECONDS,
    );
  });

  it("keeps media work locked until an idempotent Agent completion and rejects its old tus credential", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);
    const source = sourceProof("test");
    const upload = await credential(
      fixture.authorization,
      claimed.id,
      claimed.leaseToken,
      source,
    );
    const prematureCompletion = await complete(
      fixture.authorization,
      claimed,
      source,
    );
    expect(prematureCompletion.statusCode).toBe(409);
    expect(prematureCompletion.json()).toMatchObject({
      error: { code: "EDGE_UPLOAD_NOT_RECEIVED" },
    });
    finishUpload(upload, "test");

    expect(built.mediaService.claimJob("premature-worker")).toBeNull();
    const first = await complete(fixture.authorization, claimed, source);
    expect(first.statusCode).toBe(204);
    const replay = await complete(fixture.authorization, claimed, source);
    expect(replay.statusCode).toBe(204);
    expect((await authorizeTus(upload.token, upload.uploadId)).statusCode).toBe(
      401,
    );
    expect(built.mediaService.claimJob("edge-worker")).not.toBeNull();
    expect(
      built.database
        .prepare("SELECT state FROM edge_agent_tasks WHERE id = ?")
        .get(claimed.id),
    ).toEqual({ state: "completed" });
  });

  it("recovers a lost final PATCH response through a new lease HEAD without duplicating media work", async () => {
    const fixture = provisionTransfer();
    const firstClaim = await claim(fixture.authorization);
    const source = sourceProof("test");
    const firstUpload = await credential(
      fixture.authorization,
      firstClaim.id,
      firstClaim.leaseToken,
      source,
    );
    finishUpload(firstUpload, "test");
    // tusd hooks can be retried after its final PATCH response was lost.
    built.mediaService.handleTusHook({
      type: "post-finish",
      uploadId: firstUpload.uploadId,
      uploadToken: firstUpload.token,
      offset: 4,
    });
    built.mediaService.handleTusHook({
      type: "post-create",
      uploadId: firstUpload.uploadId,
      uploadToken: firstUpload.token,
    });
    expect(mediaWorkCounts()).toEqual({ media: 1, jobs: 1 });

    const reported = await fail(fixture.authorization, firstClaim, {
      code: "NETWORK_ERROR",
      message: "最终 PATCH 响应丢失",
      retryable: true,
    });
    expect(reported.json()).toEqual({ state: "queued" });
    expect(transferState(fixture.transferId)).toBe("received");
    currentNow += 2_001;
    const secondClaim = await claim(fixture.authorization);
    expect(secondClaim.id).toBe(firstClaim.id);
    expect(secondClaim.attempts).toBe(2);
    const secondUpload = await credential(
      fixture.authorization,
      secondClaim.id,
      secondClaim.leaseToken,
      source,
    );
    expect(secondUpload.uploadId).toBe(firstUpload.uploadId);

    expect(
      (await authorizeTus(firstUpload.token, firstUpload.uploadId, "HEAD"))
        .statusCode,
    ).toBe(401);
    expect(
      (await authorizeTus(secondUpload.token, secondUpload.uploadId, "HEAD"))
        .statusCode,
    ).toBe(204);
    expect(
      (await authorizeTus(secondUpload.token, secondUpload.uploadId, "PATCH"))
        .statusCode,
    ).toBe(401);
    expect(
      (await authorizeTus(secondUpload.token, secondUpload.uploadId, "POST"))
        .statusCode,
    ).toBe(401);

    // 真实 Agent 在 tus 完整 offset 恢复后会先发送最后一次心跳，再确认任务完成。
    // 该心跳只能刷新进度和租约，不能把 received 回退为 uploading。
    await heartbeat(fixture.authorization, secondClaim, source.bytes);
    expect(transferState(fixture.transferId)).toBe("received");
    const completed = await complete(
      fixture.authorization,
      secondClaim,
      source,
    );
    expect(completed.statusCode).toBe(204);
    expect(mediaWorkCounts()).toEqual({ media: 1, jobs: 1 });
    expect(built.mediaService.claimJob("recovery-worker")).not.toBeNull();
  });

  it("acknowledges cancellation twice and atomically releases upload resources and queue state", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);
    const upload = await credential(
      fixture.authorization,
      claimed.id,
      claimed.leaseToken,
      sourceProof("test"),
    );
    createTusTemporaryFiles(upload.uploadId);
    built.edgeTaskService.requestTransferCancellation(fixture.transferId);

    const first = await cancelled(fixture.authorization, claimed);
    const replay = await cancelled(fixture.authorization, claimed);
    expect(first.statusCode).toBe(204);
    expect(replay.statusCode).toBe(204);
    assertTerminalResources(fixture, upload, "cancelled", "failed");
  });

  it("cancels a queued transfer without ever granting a lease or reserving bytes", async () => {
    const fixture = provisionTransfer();
    built.edgeTaskService.requestTransferCancellation(fixture.transferId);

    expect(await claimOrNull(fixture.authorization)).toBeNull();
    expect(transferState(fixture.transferId)).toBe("cancelled");
    expect(programPreparation(fixture.programItemId)).toBe("failed");
    expect(reservedBytes()).toBe(0);
    expect(
      built.database
        .prepare("SELECT state FROM edge_agent_tasks WHERE agent_id = ?")
        .get(fixture.agentId),
    ).toEqual({ state: "cancelled" });
  });

  it("acknowledges a terminal failure twice and maps insufficient storage to a blocked terminal", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);
    const upload = await credential(
      fixture.authorization,
      claimed.id,
      claimed.leaseToken,
      sourceProof("test"),
    );
    createTusTemporaryFiles(upload.uploadId);

    const first = await fail(fixture.authorization, claimed, {
      code: "INSUFFICIENT_STORAGE",
      message: "云端容量不足",
      retryable: false,
    });
    const replay = await fail(fixture.authorization, claimed, {
      code: "INSUFFICIENT_STORAGE",
      message: "云端容量不足",
      retryable: false,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ state: "failed" });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ state: "failed" });
    assertTerminalResources(fixture, upload, "blocked_storage", "blocked");
  });

  it("retries a terminal transfer with a fresh upload instead of reusing the failed tus resource", async () => {
    const fixture = provisionTransfer();
    const firstClaim = await claim(fixture.authorization);
    const source = sourceProof("test");
    const failedUpload = await credential(
      fixture.authorization,
      firstClaim.id,
      firstClaim.leaseToken,
      source,
    );
    createTusTemporaryFiles(failedUpload.uploadId);
    await fail(fixture.authorization, firstClaim, {
      code: "NETWORK_ERROR",
      message: "上传连接已终止",
      retryable: false,
    });
    expect(reservedBytes()).toBe(0);

    built.edgeTaskService.retryTransfer(fixture.transferId);
    expect(
      built.database
        .prepare(
          `SELECT upload_id, media_id, transferred_bytes, expected_sha256
           FROM edge_transfer_jobs WHERE id = ?`,
        )
        .get(fixture.transferId),
    ).toEqual({
      upload_id: null,
      media_id: null,
      transferred_bytes: 0,
      expected_sha256: source.sha256,
    });
    expect(
      built.database
        .prepare("SELECT edge_job_id FROM uploads WHERE id = ?")
        .get(failedUpload.uploadId),
    ).toEqual({ edge_job_id: null });

    const retryClaim = await claim(fixture.authorization);
    const replacement = await credential(
      fixture.authorization,
      retryClaim.id,
      retryClaim.leaseToken,
      source,
    );
    expect(replacement.uploadId).not.toBe(failedUpload.uploadId);
    expect(
      (await authorizeTus(replacement.token, replacement.uploadId)).statusCode,
    ).toBe(204);
    expect(reservedBytes()).toBe(8);
    expect(programPreparation(fixture.programItemId)).toBe("queued");
  });

  it("keeps retrying beyond five short lease losses but terminalizes after the 48-hour window", async () => {
    const fixture = provisionTransfer();
    let claimed = await claim(fixture.authorization);
    const upload = await credential(
      fixture.authorization,
      claimed.id,
      claimed.leaseToken,
      sourceProof("test"),
    );
    expect(
      built.database
        .prepare(
          `SELECT retry_expires_at - created_at AS retention
           FROM edge_agent_tasks WHERE id = ?`,
        )
        .get(claimed.id),
    ).toEqual({ retention: 48 * 60 * 60 * 1000 });
    createTusTemporaryFiles(upload.uploadId);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      currentNow += 60_001;
      claimed = await claim(fixture.authorization);
      expect(claimed.attempts).toBe(attempt);
    }
    currentNow += 60_001;
    claimed = await claim(fixture.authorization);
    expect(claimed.attempts).toBe(6);

    currentNow = fixedNow + 48 * 60 * 60 * 1000;
    expect(await claimOrNull(fixture.authorization)).toBeNull();

    assertTerminalResources(fixture, upload, "failed", "failed");
    expect(
      built.database
        .prepare("SELECT state, error_code FROM edge_agent_tasks WHERE id = ?")
        .get(claimed.id),
    ).toEqual({ state: "failed", error_code: "RETRY_WINDOW_EXPIRED" });
  });

  it("requeues an upload only after ten continuous minutes without byte growth", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);

    await heartbeat(fixture.authorization, claimed, 0);
    for (let index = 0; index < 10; index += 1) {
      currentNow += 59_000;
      await heartbeat(fixture.authorization, claimed, 0);
    }
    currentNow += 9_999;
    await heartbeat(fixture.authorization, claimed, 0);
    currentNow += 1;
    const stalled = await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/jobs/${claimed.id}/heartbeat`,
      headers: { authorization: fixture.authorization },
      payload: { leaseToken: claimed.leaseToken, bytesTransferred: 0 },
    });

    expect(stalled.statusCode).toBe(409);
    expect(stalled.json()).toMatchObject({
      error: { code: "EDGE_TRANSFER_STALLED" },
    });
    expect(transferState(fixture.transferId)).toBe("queued");
    const requeued = built.database
      .prepare(
        `SELECT state, error_code, not_before FROM edge_agent_tasks WHERE id = ?`,
      )
      .get(claimed.id) as {
      readonly state: string;
      readonly error_code: string;
      readonly not_before: number;
    };
    expect(requeued).toMatchObject({
      state: "queued",
      error_code: "TRANSFER_STALLED",
    });
    expect(requeued.not_before).toBeGreaterThanOrEqual(currentNow);
    expect(requeued.not_before).toBeLessThanOrEqual(
      currentNow + EDGE_RETRY_BACKOFF_MAX_MILLISECONDS,
    );

    currentNow += 15 * 60 * 1000 + 1;
    const retry = await claim(fixture.authorization);
    expect(retry.id).toBe(claimed.id);
    expect(retry.attempts).toBe(2);
  });

  it("allows at most one unexpired media lease per Agent", async () => {
    const fixture = provisionTransfer();
    const verificationTaskId = built.edgeTaskService.enqueue(
      fixture.agentId,
      {
        kind: "verify_source",
        edgeTransferId: null,
        cacheReplicaId: uuidv7(),
        catalogItemId: uuidv7(),
        catalogVersionId: uuidv7(),
        localId: "second-media",
        expectedBytes: 1,
        expectedMtimeMs: fixedNow,
        expectedSha256: null,
      },
      `one-media-lease:${uuidv7()}`,
      2_000,
    );
    const first = await claim(fixture.authorization);
    expect(first.id).toBe(verificationTaskId);
    expect(await claimOrNull(fixture.authorization)).toBeNull();

    await fail(fixture.authorization, first, {
      code: "SOURCE_MISSING",
      message: "测试释放媒体租约",
      retryable: false,
    });
    const second = await claim(fixture.authorization);
    expect(second.id).not.toBe(first.id);
  });

  it("revoking an Agent terminalizes all of its active resources", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);
    const upload = await credential(
      fixture.authorization,
      claimed.id,
      claimed.leaseToken,
      sourceProof("test"),
    );
    createTusTemporaryFiles(upload.uploadId);

    built.edgeAuthService.revoke(fixture.agentId);

    assertTerminalResources(fixture, upload, "cancelled", "failed");
    expect(
      (
        await built.app.inject({
          method: "POST",
          url: "/api/v1/edge/v1/heartbeat",
          headers: { authorization: fixture.authorization },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });

  it("treats SHA as write-once even when size and mtime stay unchanged", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);
    const firstSource = sourceProof("test");
    await credential(
      fixture.authorization,
      claimed.id,
      claimed.leaseToken,
      firstSource,
    );
    const changedSource = sourceProof("evil");

    const refreshed = await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/jobs/${claimed.id}/upload-credential`,
      headers: { authorization: fixture.authorization },
      payload: { leaseToken: claimed.leaseToken, source: changedSource },
    });
    expect(refreshed.statusCode).toBe(409);
    expect(refreshed.json()).toMatchObject({
      error: { code: "EDGE_SOURCE_CHANGED" },
    });
    const completed = await complete(
      fixture.authorization,
      claimed,
      changedSource,
    );
    expect(completed.statusCode).toBe(409);
    expect(completed.json()).toMatchObject({
      error: { code: "EDGE_SOURCE_CHANGED" },
    });
    expect(
      built.database
        .prepare(
          `SELECT v.sha256 AS version_sha256, t.expected_sha256 AS transfer_sha256
           FROM edge_transfer_jobs t
           JOIN edge_catalog_versions v ON v.id = t.catalog_version_id
           WHERE t.id = ?`,
        )
        .get(fixture.transferId),
    ).toEqual({
      version_sha256: firstSource.sha256,
      transfer_sha256: firstSource.sha256,
    });
  });

  it("returns changed for the current catalog version until a later scan confirms it", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);
    const failed = await fail(fixture.authorization, claimed, {
      code: "SOURCE_CHANGED",
      message: "家庭源版本已变化",
      retryable: false,
    });
    expect(failed.json()).toEqual({ state: "failed" });
    expect(
      built.edgeCatalogService.listCatalog(fixture.agentId, 20).items[0]
        ?.sourceState,
    ).toBe("changed");

    const scan = built.edgeCatalogService.startScan(fixture.agentId, 2);
    built.edgeCatalogService.addPage(fixture.agentId, scan.scanId, {
      generation: 2,
      pageIndex: 0,
      entries: [
        {
          localId: "episode-01",
          relativePath: "Series/Episode 01.mp4",
          displayName: "Episode 01.mp4",
          bytes: 4,
          mtimeMs: fixedNow - 1000,
        },
      ],
    });
    built.edgeCatalogService.commitScan(fixture.agentId, scan.scanId, 2, 1);
    expect(
      built.edgeCatalogService.listCatalog(fixture.agentId, 20).items[0]
        ?.sourceState,
    ).toBe("present");
  });

  it("returns the machine-readable 507 capacity error without issuing a credential", async () => {
    const fixture = provisionTransfer(Number.MAX_SAFE_INTEGER);
    const claimed = await claim(fixture.authorization);
    const source = {
      bytes: Number.MAX_SAFE_INTEGER,
      mtimeMs: fixedNow - 1000,
      sha256: createHash("sha256").update("huge").digest("hex"),
    };
    const response = await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/jobs/${claimed.id}/upload-credential`,
      headers: { authorization: fixture.authorization },
      payload: { leaseToken: claimed.leaseToken, source },
    });
    expect(response.statusCode).toBe(507);
    expect(response.json()).toMatchObject({
      error: { code: "INSUFFICIENT_STORAGE" },
    });
    expect(
      built.database
        .prepare("SELECT COUNT(*) AS count FROM edge_upload_credentials")
        .get(),
    ).toEqual({ count: 0 });
    expect(reservedBytes()).toBe(0);
  });

  it("serializes competing first source proofs so exactly one SHA becomes immutable", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);
    const first = sourceProof("test");
    const second = sourceProof("evil");
    const responses = await Promise.all(
      [first, second].map((source) =>
        built.app.inject({
          method: "POST",
          url: `/api/v1/edge/v1/jobs/${claimed.id}/upload-credential`,
          headers: { authorization: fixture.authorization },
          payload: { leaseToken: claimed.leaseToken, source },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const accepted = responses.find((response) => response.statusCode === 200)!;
    const acceptedToken = accepted.json<{ token: string; uploadId: string }>();
    const acceptedSource = responses[0]?.statusCode === 200 ? first : second;
    expect(
      built.database
        .prepare(
          `SELECT v.sha256 AS version_sha256, t.expected_sha256 AS transfer_sha256
           FROM edge_transfer_jobs t
           JOIN edge_catalog_versions v ON v.id = t.catalog_version_id
           WHERE t.id = ?`,
        )
        .get(fixture.transferId),
    ).toEqual({
      version_sha256: acceptedSource.sha256,
      transfer_sha256: acceptedSource.sha256,
    });
    expect(
      (await authorizeTus(acceptedToken.token, acceptedToken.uploadId))
        .statusCode,
    ).toBe(204);
  });

  it("publishes measured transfer speed and remaining-time ETA after the second heartbeat", async () => {
    const fixture = provisionTransfer();
    const claimed = await claim(fixture.authorization);
    await heartbeat(fixture.authorization, claimed, 1);
    expect(built.edgeAdminService.listTransfers()[0]).toMatchObject({
      speedBytesPerSecond: null,
      etaSeconds: null,
    });
    currentNow += 2_000;
    await heartbeat(fixture.authorization, claimed, 3);
    expect(built.edgeAdminService.listTransfers()[0]).toMatchObject({
      transferredBytes: 3,
      speedBytesPerSecond: 1,
      etaSeconds: 1,
    });
  });

  it("terminalizes a non-retryable source verification instead of stranding eviction", async () => {
    const fixture = provisionVerifyingEviction();
    const claimed = await claim(fixture.authorization);
    const first = await fail(fixture.authorization, claimed, {
      code: "SOURCE_MISSING",
      message: "家庭源文件不存在",
      retryable: false,
    });
    const replay = await fail(fixture.authorization, claimed, {
      code: "SOURCE_MISSING",
      message: "家庭源文件不存在",
      retryable: false,
    });
    expect(first.json()).toEqual({ state: "failed" });
    expect(replay.json()).toEqual({ state: "failed" });
    assertVerificationBlocked(
      fixture.evictionId,
      fixture.replicaId,
      "SOURCE_MISSING",
    );
  });

  it("terminalizes an exhausted source-verification lease instead of stranding eviction", async () => {
    const fixture = provisionVerifyingEviction();
    built.database
      .prepare(
        `UPDATE edge_agent_tasks SET attempts = 4, max_attempts = 5
         WHERE kind = 'verify_source' AND state = 'queued'`,
      )
      .run();
    const claimed = await claim(fixture.authorization);
    expect(claimed.attempts).toBe(5);
    currentNow += 60_001;
    expect(await claimOrNull(fixture.authorization)).toBeNull();
    assertVerificationBlocked(
      fixture.evictionId,
      fixture.replicaId,
      "LEASE_EXHAUSTED",
    );
  });

  it("terminalizes source verification when its Agent is revoked", () => {
    const fixture = provisionVerifyingEviction();
    built.edgeAuthService.revoke(fixture.agentId);
    assertVerificationBlocked(
      fixture.evictionId,
      fixture.replicaId,
      "AGENT_REVOKED",
    );
  });
});

function provisionTransfer(bytes = 4) {
  const enrollment = built.edgeAuthService.enroll({
    displayName: "SimpleServer",
    softwareVersion: "0.1.0",
  });
  const authorization = `Bearer ${enrollment.token}`;
  const scan = built.edgeCatalogService.startScan(enrollment.agentId, 1);
  built.edgeCatalogService.addPage(enrollment.agentId, scan.scanId, {
    generation: 1,
    pageIndex: 0,
    entries: [
      {
        localId: "episode-01",
        relativePath: "Series/Episode 01.mp4",
        displayName: "Episode 01.mp4",
        bytes,
        mtimeMs: fixedNow - 1000,
      },
    ],
  });
  built.edgeCatalogService.commitScan(enrollment.agentId, scan.scanId, 1, 1);
  const versionId = built.edgeCatalogService.listCatalog(undefined, 20)
    .items[0]!.versionId;
  const owner = built.database
    .prepare("SELECT id FROM accounts WHERE username_folded = 'host'")
    .get() as { readonly id: string };
  const queue = built.programService.getOrCreateActiveQueue(owner.id);
  built.programService.addItems(owner.id, queue.revision, [versionId]);
  const row = built.database
    .prepare(
      `SELECT id, transfer_job_id FROM program_queue_items
       WHERE catalog_version_id = ?`,
    )
    .get(versionId) as {
    readonly id: string;
    readonly transfer_job_id: string;
  };
  return {
    agentId: enrollment.agentId,
    authorization,
    versionId,
    programItemId: row.id,
    transferId: row.transfer_job_id,
  };
}

function provisionVerifyingEviction() {
  const fixture = provisionTransfer();
  const mediaId = uuidv7();
  const replicaId = uuidv7();
  const sourceSha256 = sourceProof("test").sha256;
  built.database.transaction(() => {
    built.database
      .prepare(
        `UPDATE edge_agent_tasks SET state = 'cancelled', completed_at = ?, updated_at = ?
         WHERE agent_id = ? AND kind = 'upload' AND state = 'queued'`,
      )
      .run(currentNow, currentNow, fixture.agentId);
    built.database
      .prepare(
        `UPDATE edge_catalog_versions SET sha256 = ?, last_verified_at = NULL
         WHERE id = ?`,
      )
      .run(sourceSha256, fixture.versionId);
    built.database
      .prepare(
        `INSERT INTO media(
           id, storage_key, display_name, state, bytes, sha256, mime,
           probe_json, duration_ms, created_at, trashed_at
         ) VALUES (?, ?, 'Episode 01.mp4', 'published', 4, ?,
                   'video/mp4', NULL, 1000, ?, NULL)`,
      )
      .run(mediaId, `storage-${mediaId}`, sourceSha256, currentNow);
    built.database
      .prepare(
        `UPDATE edge_transfer_jobs
         SET state = 'ready', expected_sha256 = ?, media_id = ?, ready_at = ?
         WHERE id = ?`,
      )
      .run(sourceSha256, mediaId, currentNow, fixture.transferId);
    built.database
      .prepare(
        `INSERT INTO edge_cache_replicas(
           id, agent_id, catalog_version_id, transfer_job_id, media_id,
           state, pinned, generation, row_version, source_sha256,
           source_verified_at, protected_reason, created_at, updated_at, evicted_at
         ) VALUES (?, ?, ?, ?, ?, 'eligible', 0, 1, 0, NULL,
                   NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        replicaId,
        fixture.agentId,
        fixture.versionId,
        fixture.transferId,
        mediaId,
        currentNow,
        currentNow,
      );
  })();
  const eviction = built.edgeEvictionService.requestEviction(replicaId, 1, 0);
  expect(eviction.state).toBe("verifying_source");
  return { ...fixture, replicaId, evictionId: eviction.evictionId };
}

async function claim(authorization: string) {
  const response = await built.app.inject({
    method: "GET",
    url: "/api/v1/edge/v1/jobs/claim?waitSeconds=0",
    headers: { authorization },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    id: string;
    leaseToken: string;
    attempts: number;
  }>();
}

async function claimOrNull(authorization: string) {
  const response = await built.app.inject({
    method: "GET",
    url: "/api/v1/edge/v1/jobs/claim?waitSeconds=0",
    headers: { authorization },
  });
  expect([200, 204]).toContain(response.statusCode);
  return response.statusCode === 204
    ? null
    : response.json<{ id: string; leaseToken: string; attempts: number }>();
}

async function credential(
  authorization: string,
  jobId: string,
  leaseToken: string,
  source: {
    readonly bytes: number;
    readonly mtimeMs: number;
    readonly sha256: string;
  },
) {
  const response = await built.app.inject({
    method: "POST",
    url: `/api/v1/edge/v1/jobs/${jobId}/upload-credential`,
    headers: { authorization },
    payload: { leaseToken, source },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ uploadId: string; token: string }>();
}

function finishUpload(
  upload: { readonly uploadId: string; readonly token: string },
  contents: string,
): void {
  built.mediaService.handleTusHook({
    type: "pre-create",
    uploadToken: upload.token,
    size: Buffer.byteLength(contents),
    metadata: {
      filename: "Episode 01.mp4",
      filetype: "application/octet-stream",
    },
  });
  built.mediaService.handleTusHook({
    type: "post-create",
    uploadId: upload.uploadId,
    uploadToken: upload.token,
  });
  writeFileSync(join(root, "uploads", upload.uploadId), contents);
  built.mediaService.handleTusHook({
    type: "post-finish",
    uploadId: upload.uploadId,
    uploadToken: upload.token,
    offset: Buffer.byteLength(contents),
  });
}

function createTusTemporaryFiles(uploadId: string): void {
  writeFileSync(join(root, "uploads", uploadId), "partial");
  writeFileSync(join(root, "uploads", `${uploadId}.info`), "metadata");
}

function complete(
  authorization: string,
  claimed: { readonly id: string; readonly leaseToken: string },
  source: {
    readonly bytes: number;
    readonly mtimeMs: number;
    readonly sha256: string;
  },
) {
  return built.app.inject({
    method: "POST",
    url: `/api/v1/edge/v1/jobs/${claimed.id}/complete`,
    headers: { authorization },
    payload: { leaseToken: claimed.leaseToken, source },
  });
}

function cancelled(
  authorization: string,
  claimed: { readonly id: string; readonly leaseToken: string },
) {
  return built.app.inject({
    method: "POST",
    url: `/api/v1/edge/v1/jobs/${claimed.id}/cancelled`,
    headers: { authorization },
    payload: { leaseToken: claimed.leaseToken },
  });
}

function fail(
  authorization: string,
  claimed: { readonly id: string; readonly leaseToken: string },
  failure: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  },
) {
  return built.app.inject({
    method: "POST",
    url: `/api/v1/edge/v1/jobs/${claimed.id}/fail`,
    headers: { authorization },
    payload: { leaseToken: claimed.leaseToken, ...failure },
  });
}

async function heartbeat(
  authorization: string,
  claimed: { readonly id: string; readonly leaseToken: string },
  bytesTransferred: number,
): Promise<void> {
  const response = await built.app.inject({
    method: "POST",
    url: `/api/v1/edge/v1/jobs/${claimed.id}/heartbeat`,
    headers: { authorization },
    payload: { leaseToken: claimed.leaseToken, bytesTransferred },
  });
  expect(response.statusCode).toBe(200);
}

function authorizeTus(token: string, uploadId: string, method = "PATCH") {
  return built.app.inject({
    method: "GET",
    url: "/api/v1/internal/tus/authorize",
    headers: {
      "x-internal-token": internalToken,
      "upload-token": token,
      "x-forwarded-uri": `/files/${uploadId}`,
      "x-forwarded-method": method,
    },
  });
}

function assertTerminalResources(
  fixture: { readonly transferId: string; readonly programItemId: string },
  upload: { readonly uploadId: string; readonly token: string },
  transfer: string,
  preparation: string,
): void {
  expect(transferState(fixture.transferId)).toBe(transfer);
  expect(programPreparation(fixture.programItemId)).toBe(preparation);
  expect(reservedBytes()).toBe(0);
  expect(existsSync(join(root, "uploads", upload.uploadId))).toBe(false);
  expect(existsSync(join(root, "uploads", `${upload.uploadId}.info`))).toBe(
    false,
  );
  expect(
    built.database
      .prepare(
        `SELECT COUNT(*) AS count FROM edge_upload_credentials
         WHERE edge_job_id = ? AND revoked_at IS NULL`,
      )
      .get(fixture.transferId),
  ).toEqual({ count: 0 });
}

function transferState(transferId: string): string {
  return (
    built.database
      .prepare("SELECT state FROM edge_transfer_jobs WHERE id = ?")
      .get(transferId) as { readonly state: string }
  ).state;
}

function programPreparation(programItemId: string): string {
  return (
    built.database
      .prepare("SELECT preparation_state FROM program_queue_items WHERE id = ?")
      .get(programItemId) as { readonly preparation_state: string }
  ).preparation_state;
}

function reservedBytes(): number {
  return (
    built.database
      .prepare("SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM uploads")
      .get() as { readonly bytes: number }
  ).bytes;
}

function sourceProof(contents: string) {
  return {
    bytes: 4,
    mtimeMs: fixedNow - 1000,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function mediaWorkCounts() {
  const media = built.database
    .prepare("SELECT COUNT(*) AS count FROM media")
    .get() as {
    readonly count: number;
  };
  const jobs = built.database
    .prepare("SELECT COUNT(*) AS count FROM media_jobs")
    .get() as { readonly count: number };
  return { media: media.count, jobs: jobs.count };
}

function assertVerificationBlocked(
  evictionId: string,
  replicaId: string,
  errorCode: string,
): void {
  expect(
    built.database
      .prepare("SELECT state, error_code FROM edge_eviction_jobs WHERE id = ?")
      .get(evictionId),
  ).toEqual({ state: "failed", error_code: errorCode });
  expect(
    built.database
      .prepare(
        "SELECT state, protected_reason FROM edge_cache_replicas WHERE id = ?",
      )
      .get(replicaId),
  ).toEqual({ state: "recovery_blocked", protected_reason: errorCode });
}
