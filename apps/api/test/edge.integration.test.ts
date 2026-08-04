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

const origin = "https://watch.example.test";
const internalToken = "test-internal-service-token-32-bytes";
const hostPassword = "host-test-password-24-characters";
const fixedNow = 1_750_000_000_000;
let currentNow = fixedNow;
let built: BuiltApp;
let root: string;

beforeEach(async () => {
  currentNow = fixedNow;
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/edge-api-test-"));
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
  await built.authService.bootstrapAdmin("Host", hostPassword);
});

afterEach(async () => {
  await built.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Edge Agent API and transfer pipeline", () => {
  it("lets Host idempotently queue an immediate catalog refresh for an offline Agent", async () => {
    const enrollment = built.edgeAuthService.enroll({
      displayName: "SimpleServer",
      softwareVersion: "0.1.0",
    });
    const readyTransferId = uuidv7();
    built.database
      .prepare(
        `INSERT INTO edge_transfer_jobs(
           id, agent_id, state, priority, declared_bytes, transferred_bytes,
           attempts, max_attempts, created_at, updated_at, ready_at
         ) VALUES (?, ?, 'ready', 0, 4, 4, 0, 1024, ?, ?, ?)`,
      )
      .run(readyTransferId, enrollment.agentId, fixedNow, fixedNow, fixedNow);
    const host = await loginHost();
    const send = () =>
      built.app.inject({
        method: "POST",
        url: `/api/v1/admin/edge/agents/${enrollment.agentId}/catalog/refresh`,
        headers: {
          cookie: host.cookie,
          origin,
          "x-csrf-token": host.csrfToken,
        },
        payload: {},
      });

    const first = await send();
    const replay = await send();
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      agent: { id: enrollment.agentId, state: "offline" },
      task: { state: "queued", deduplicated: false },
    });
    expect(replay.json()).toMatchObject({
      agent: { id: enrollment.agentId, state: "offline" },
      task: {
        id: first.json<{ task: { id: string } }>().task.id,
        state: "queued",
        deduplicated: true,
      },
    });
    expect(
      built.database
        .prepare(
          `SELECT kind, state, priority, COUNT(*) AS count
           FROM edge_agent_tasks WHERE agent_id = ? AND kind = 'catalog_scan'`,
        )
        .get(enrollment.agentId),
    ).toEqual({
      kind: "catalog_scan",
      state: "queued",
      priority: 10_000,
      count: 1,
    });
    expect(
      built.database
        .prepare("SELECT state FROM edge_transfer_jobs WHERE id = ?")
        .get(readyTransferId),
    ).toEqual({ state: "ready" });
  });

  it("publishes the Host catalog refresh contract in OpenAPI", () => {
    const document = built.app.swagger() as {
      readonly paths?: Record<
        string,
        { readonly post?: { readonly responses?: Record<string, unknown> } }
      >;
    };
    const operation =
      document.paths?.["/api/v1/admin/edge/agents/{agentId}/catalog/refresh"]
        ?.post;
    expect(operation).toBeDefined();
    expect(operation?.responses).toHaveProperty("202");
  });

  it("expires machine credentials after 90 days and keeps rotation overlap to five minutes", () => {
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    const enrollment = built.edgeAuthService.enroll({
      displayName: "SimpleServer",
      softwareVersion: "0.1.0",
    });
    const initial = built.database
      .prepare(
        "SELECT created_at, expires_at FROM edge_agent_tokens WHERE agent_id = ?",
      )
      .get(enrollment.agentId) as {
      readonly created_at: number;
      readonly expires_at: number;
    };
    expect(initial.expires_at).toBe(initial.created_at + ninetyDays);
    expect(built.edgeAdminService.listAgents()[0]).toMatchObject({
      credentialExpiresAt: new Date(fixedNow + ninetyDays).toISOString(),
      credentialExpiringSoon: false,
    });

    currentNow = fixedNow + 76 * 24 * 60 * 60 * 1000;
    expect(built.edgeAdminService.listAgents()[0]).toMatchObject({
      credentialExpiresAt: new Date(fixedNow + ninetyDays).toISOString(),
      credentialExpiringSoon: true,
    });

    const rotatedAt = currentNow;
    const rotated = built.edgeAuthService.rotate(enrollment.agentId);
    const tokens = built.database
      .prepare(
        `SELECT created_at, expires_at FROM edge_agent_tokens
         WHERE agent_id = ? ORDER BY created_at`,
      )
      .all(enrollment.agentId) as Array<{
      readonly created_at: number;
      readonly expires_at: number;
    }>;
    expect(tokens).toEqual([
      {
        created_at: fixedNow,
        expires_at: rotatedAt + 5 * 60 * 1000,
      },
      {
        created_at: rotatedAt,
        expires_at: rotatedAt + ninetyDays,
      },
    ]);
    expect(built.edgeAdminService.listAgents()[0]).toMatchObject({
      credentialExpiresAt: new Date(rotatedAt + ninetyDays).toISOString(),
      credentialExpiringSoon: false,
    });
    expect(built.edgeAdminService.listAgents()[0]).not.toHaveProperty("token");
    expect(
      built.edgeAuthService.authenticate(`Bearer ${enrollment.token}`).agentId,
    ).toBe(enrollment.agentId);

    currentNow = rotatedAt + 5 * 60 * 1000 + 1;
    expect(() =>
      built.edgeAuthService.authenticate(`Bearer ${enrollment.token}`),
    ).toThrow("Edge Agent 凭据无效或已过期");
    expect(
      built.edgeAuthService.authenticate(`Bearer ${rotated.token}`).agentId,
    ).toBe(enrollment.agentId);
  });

  it("treats a legacy unlimited machine credential as non-expiring", () => {
    const enrollment = built.edgeAuthService.enroll({
      displayName: "LegacyServer",
      softwareVersion: "0.1.0",
    });
    built.database
      .prepare(
        "UPDATE edge_agent_tokens SET expires_at = NULL WHERE agent_id = ?",
      )
      .run(enrollment.agentId);

    expect(built.edgeAdminService.listAgents()[0]).toMatchObject({
      credentialExpiresAt: null,
      credentialExpiringSoon: false,
    });
  });

  it("paginates and searches the committed catalog without dropping later titles", async () => {
    const enrollment = built.edgeAuthService.enroll({
      displayName: "SimpleServer",
      softwareVersion: "0.1.0",
    });
    const authorization = `Bearer ${enrollment.token}`;
    const scan = await beginScan(authorization, 1);
    await built.app.inject({
      method: "PUT",
      url: `/api/v1/edge/v1/catalog/scans/${scan}/pages`,
      headers: { authorization },
      payload: {
        generation: 1,
        pageIndex: 0,
        entries: [
          catalogEntry("episode-a", "Series/A.mp4"),
          catalogEntry("episode-b", "Series/B.mp4"),
          catalogEntry("special-c", "Special/C.mp4"),
        ],
      },
    });
    await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/catalog/scans/${scan}/commit`,
      headers: { authorization },
      payload: { generation: 1, pageCount: 1 },
    });

    const first = built.edgeCatalogService.listCatalog(undefined, 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = built.edgeCatalogService.listCatalog(
      undefined,
      1,
      first.nextCursor!,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const search = built.edgeCatalogService.listCatalog(
      enrollment.agentId,
      10,
      undefined,
      "Special",
    );
    expect(search.items.map((item) => item.relativePath)).toEqual([
      "Special/C.mp4",
    ]);
    expect(() =>
      built.edgeCatalogService.listCatalog(undefined, 10, "not-a-cursor"),
    ).toThrow("家庭片库游标无效");
  });

  it("isolates machine credentials and only publishes a committed complete scan", async () => {
    const enrollment = built.edgeAuthService.enroll({
      displayName: "SimpleServer",
      softwareVersion: "0.1.0",
    });
    const authorization = `Bearer ${enrollment.token}`;

    const heartbeat = await built.app.inject({
      method: "POST",
      url: "/api/v1/edge/v1/heartbeat",
      headers: { authorization },
      payload: {
        protocolVersion: 1,
        softwareVersion: "0.1.0",
        capabilities: { catalogScan: true },
      },
    });
    expect(heartbeat.statusCode).toBe(204);
    expect(
      (
        await built.app.inject({
          method: "POST",
          url: "/api/v1/edge/v1/catalog/scans",
          payload: { generation: 1 },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await built.app.inject({
          method: "GET",
          url: "/api/v1/admin/edge/summary",
          headers: { authorization },
        })
      ).statusCode,
    ).toBe(401);

    const scan = await beginScan(authorization, 1);
    const page = {
      generation: 1,
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
    };
    expect(
      (
        await built.app.inject({
          method: "PUT",
          url: `/api/v1/edge/v1/catalog/scans/${scan}/pages`,
          headers: { authorization },
          payload: page,
        })
      ).json(),
    ).toEqual({ accepted: true });
    expect(
      (
        await built.app.inject({
          method: "PUT",
          url: `/api/v1/edge/v1/catalog/scans/${scan}/pages`,
          headers: { authorization },
          payload: page,
        })
      ).json(),
    ).toEqual({ accepted: false });
    const committed = await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/catalog/scans/${scan}/commit`,
      headers: { authorization },
      payload: { generation: 1, pageCount: 1 },
    });
    expect(committed.json()).toEqual({ itemCount: 1, changedCount: 1 });

    const incomplete = await beginScan(authorization, 2);
    await built.app.inject({
      method: "PUT",
      url: `/api/v1/edge/v1/catalog/scans/${incomplete}/pages`,
      headers: { authorization },
      payload: { generation: 2, pageIndex: 0, entries: [] },
    });
    expect(
      built.edgeCatalogService.listCatalog(undefined, 20).items,
    ).toHaveLength(1);

    const guarded = await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/catalog/scans/${incomplete}/commit`,
      headers: { authorization },
      payload: { generation: 2, pageCount: 1 },
    });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json()).toMatchObject({
      error: { code: "EDGE_CATALOG_REDUCTION_REQUIRES_CONFIRMATION" },
    });
    expect(
      built.edgeCatalogService.listCatalog(undefined, 20).items[0]?.sourceState,
    ).toBe("present");

    const confirmedEmpty = await beginScan(authorization, 3);
    await built.app.inject({
      method: "PUT",
      url: `/api/v1/edge/v1/catalog/scans/${confirmedEmpty}/pages`,
      headers: { authorization },
      payload: { generation: 3, pageIndex: 0, entries: [] },
    });
    const confirmed = await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/catalog/scans/${confirmedEmpty}/commit`,
      headers: { authorization },
      payload: { generation: 3, pageCount: 1 },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(
      built.edgeCatalogService.listCatalog(undefined, 20).items[0]?.sourceState,
    ).toBe("missing");

    const stale = await beginScan(authorization, 4);
    currentNow += 2 * 60 * 60 * 1000;
    const reconciled = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/edge/reconcile",
      headers: { "x-internal-token": internalToken },
      payload: {},
    });
    expect(reconciled.statusCode).toBe(204);
    expect(
      built.database
        .prepare("SELECT state FROM edge_catalog_scans WHERE id = ?")
        .get(stale),
    ).toEqual({ state: "aborted" });
  });

  it("requires two cloud-observed generations before applying a large catalog reduction", () => {
    const enrollment = built.edgeAuthService.enroll({
      displayName: "SimpleServer",
      softwareVersion: "0.1.0",
    });
    const initialEntries = Array.from({ length: 12 }, (_value, index) =>
      catalogEntry(
        `episode-${String(index).padStart(2, "0")}`,
        `Series/${String(index).padStart(2, "0")}.mp4`,
      ),
    );
    const first = built.edgeCatalogService.startScan(enrollment.agentId, 1);
    built.edgeCatalogService.addPage(enrollment.agentId, first.scanId, {
      generation: 1,
      pageIndex: 0,
      entries: initialEntries,
    });
    built.edgeCatalogService.commitScan(enrollment.agentId, first.scanId, 1, 1);

    const reducedEntries = initialEntries.slice(0, 1);
    const guarded = built.edgeCatalogService.startScan(enrollment.agentId, 2);
    built.edgeCatalogService.addPage(enrollment.agentId, guarded.scanId, {
      generation: 2,
      pageIndex: 0,
      entries: reducedEntries,
    });
    expect(() =>
      built.edgeCatalogService.commitScan(
        enrollment.agentId,
        guarded.scanId,
        2,
        1,
      ),
    ).toThrow("必须由下一代扫描提交相同快照");
    expect(
      built.database
        .prepare(
          `SELECT COUNT(*) AS count FROM edge_catalog_items
           WHERE agent_id = ? AND source_state = 'present'`,
        )
        .get(enrollment.agentId),
    ).toEqual({ count: 12 });

    const confirmed = built.edgeCatalogService.startScan(enrollment.agentId, 3);
    built.edgeCatalogService.addPage(enrollment.agentId, confirmed.scanId, {
      generation: 3,
      pageIndex: 0,
      entries: reducedEntries,
    });
    built.edgeCatalogService.commitScan(
      enrollment.agentId,
      confirmed.scanId,
      3,
      1,
    );
    expect(
      built.database
        .prepare(
          `SELECT source_state, COUNT(*) AS count FROM edge_catalog_items
           WHERE agent_id = ? GROUP BY source_state ORDER BY source_state`,
        )
        .all(enrollment.agentId),
    ).toEqual([
      { source_state: "missing", count: 11 },
      { source_state: "present", count: 1 },
    ]);
  });

  it("fences tus credentials by lease attempt and closes source SHA, reservation, cache and queue state", async () => {
    const enrollment = built.edgeAuthService.enroll({
      displayName: "SimpleServer",
      softwareVersion: "0.1.0",
    });
    const authorization = `Bearer ${enrollment.token}`;
    const scan = await beginScan(authorization, 1);
    await built.app.inject({
      method: "PUT",
      url: `/api/v1/edge/v1/catalog/scans/${scan}/pages`,
      headers: { authorization },
      payload: {
        generation: 1,
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
      },
    });
    await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/catalog/scans/${scan}/commit`,
      headers: { authorization },
      payload: { generation: 1, pageCount: 1 },
    });
    const versionId = built.edgeCatalogService.listCatalog(undefined, 20)
      .items[0]!.versionId;
    const owner = built.database
      .prepare("SELECT id FROM accounts WHERE username_folded = 'host'")
      .get() as { readonly id: string };
    const queue = built.programService.getOrCreateActiveQueue(owner.id);
    built.programService.addItems(owner.id, queue.revision, [versionId]);

    const firstClaim = await claim(authorization);
    const source = {
      bytes: 4,
      mtimeMs: fixedNow - 1000,
      sha256: createHash("sha256").update("test").digest("hex"),
    };
    const firstCredential = await credential(
      authorization,
      firstClaim.id,
      firstClaim.leaseToken,
      source,
    );
    expect(reservedBytes()).toBe(8);

    currentNow += 60_001;
    const expiredCredential = await authorizeTus(
      firstCredential.token,
      firstCredential.uploadId,
    );
    expect(expiredCredential.statusCode).toBe(401);
    const secondClaim = await claim(authorization);
    expect(secondClaim.id).toBe(firstClaim.id);
    expect(secondClaim.attempts).toBe(2);
    const secondCredential = await credential(
      authorization,
      secondClaim.id,
      secondClaim.leaseToken,
      source,
    );
    expect(secondCredential.uploadId).toBe(firstCredential.uploadId);
    expect(
      (await authorizeTus(secondCredential.token, secondCredential.uploadId))
        .statusCode,
    ).toBe(204);

    built.mediaService.handleTusHook({
      type: "pre-create",
      uploadToken: secondCredential.token,
      size: 4,
      metadata: {
        filename: "Episode 01.mp4",
        filetype: "application/octet-stream",
      },
    });
    built.mediaService.handleTusHook({
      type: "post-create",
      uploadId: secondCredential.uploadId,
      uploadToken: secondCredential.token,
    });
    built.mediaService.handleTusHook({
      type: "post-receive",
      uploadId: secondCredential.uploadId,
      uploadToken: secondCredential.token,
      offset: 2,
    });
    expect(reservedBytes()).toBe(6);
    writeFileSync(join(root, "uploads", secondCredential.uploadId), "test");
    built.mediaService.handleTusHook({
      type: "post-finish",
      uploadId: secondCredential.uploadId,
      uploadToken: secondCredential.token,
      offset: 4,
    });
    expect(reservedBytes()).toBe(4);

    const completed = await built.app.inject({
      method: "POST",
      url: `/api/v1/edge/v1/jobs/${secondClaim.id}/complete`,
      headers: { authorization },
      payload: { leaseToken: secondClaim.leaseToken, source },
    });
    expect(completed.statusCode).toBe(204);
    const mediaJob = built.mediaService.claimJob("edge-worker")!;
    const media = built.database
      .prepare("SELECT storage_key FROM media WHERE id = ?")
      .get(mediaJob.mediaId) as { readonly storage_key: string };
    const finalPath = join(root, "media", media.storage_key, "content.mp4");
    mkdirSync(join(root, "media", media.storage_key), { recursive: true });
    writeFileSync(finalPath, "test");
    const wrong = built.mediaService.completeJob.bind(built.mediaService);
    expect(() =>
      wrong(mediaJob.id, mediaJob.leaseToken, {
        compatible: true,
        probe: compatibleH264Probe(),
        reasons: [],
        sha256: "b".repeat(64),
        sourceSha256: "c".repeat(64),
        bytes: 4,
        durationMs: 1000,
        finalPath,
      }),
    ).toThrow("云端收到的文件与家庭目录版本不一致");
    built.mediaService.completeJob(mediaJob.id, mediaJob.leaseToken, {
      compatible: true,
      probe: compatibleH264Probe(),
      reasons: [],
      sha256: source.sha256,
      sourceSha256: source.sha256,
      bytes: 4,
      durationMs: 1000,
      finalPath,
    });
    expect(reservedBytes()).toBe(0);
    expect(
      built.database
        .prepare("SELECT state FROM edge_transfer_jobs LIMIT 1")
        .get(),
    ).toEqual({ state: "ready" });
    expect(
      built.database
        .prepare("SELECT state FROM edge_cache_replicas LIMIT 1")
        .get(),
    ).toEqual({ state: "ready" });
    expect(built.programService.getActiveQueue()?.items[0]).toMatchObject({
      preparationState: "ready",
      mediaId: mediaJob.mediaId,
    });

    built.database
      .prepare("UPDATE program_queue_items SET position = 10")
      .run();
    built.programService.recomputeActiveProtection();
    let replica = built.database
      .prepare(
        `SELECT id, state, generation, row_version
         FROM edge_cache_replicas LIMIT 1`,
      )
      .get() as {
      readonly id: string;
      readonly state: string;
      readonly generation: number;
      readonly row_version: number;
    };
    expect(replica.state).toBe("protected");
    built.edgeEvictionService.setPinned(
      replica.id,
      replica.generation,
      replica.row_version,
      true,
    );
    replica = built.database
      .prepare(
        `SELECT id, state, generation, row_version
         FROM edge_cache_replicas WHERE id = ?`,
      )
      .get(replica.id) as typeof replica;
    expect(() =>
      built.edgeEvictionService.requestEviction(
        replica.id,
        replica.generation,
        replica.row_version,
      ),
    ).toThrow("仍受节目单或固定保护");
    built.edgeEvictionService.setPinned(
      replica.id,
      replica.generation,
      replica.row_version,
      false,
    );
    built.database
      .prepare(
        "UPDATE program_queue_items SET playback_state = 'removed' WHERE transfer_job_id = (SELECT transfer_job_id FROM edge_cache_replicas WHERE id = ?)",
      )
      .run(replica.id);
    built.programService.recomputeActiveProtection();
    replica = built.database
      .prepare(
        `SELECT id, state, generation, row_version
         FROM edge_cache_replicas WHERE id = ?`,
      )
      .get(replica.id) as typeof replica;
    const eviction = built.edgeEvictionService.requestEviction(
      replica.id,
      replica.generation,
      replica.row_version,
    );
    expect(eviction.state).toBe("queued");
    built.edgeEvictionService.reconcile();
    expect(existsSync(finalPath)).toBe(false);
    expect(
      built.database
        .prepare("SELECT state, media_id FROM edge_cache_replicas WHERE id = ?")
        .get(replica.id),
    ).toEqual({ state: "evicted", media_id: null });
    expect(
      built.database
        .prepare("SELECT trashed_at FROM media WHERE id = ?")
        .get(mediaJob.mediaId),
    ).toEqual({ trashed_at: currentNow });
  });
});

function catalogEntry(localId: string, relativePath: string) {
  return {
    localId,
    relativePath,
    displayName: relativePath.split("/").at(-1)!,
    bytes: 4,
    mtimeMs: fixedNow - 1000,
  };
}

async function loginHost(): Promise<{ cookie: string; csrfToken: string }> {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin },
    payload: { username: "Host", password: hostPassword },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  const cookie = values
    .find((value) => value.startsWith("__Host-sw_session="))
    ?.split(";", 1)[0];
  if (!cookie) throw new Error("Host 会话 Cookie 缺失");
  return {
    cookie,
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function beginScan(authorization: string, generation: number) {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/v1/edge/v1/catalog/scans",
    headers: { authorization },
    payload: { generation },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ scanId: string }>().scanId;
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

async function credential(
  authorization: string,
  jobId: string,
  leaseToken: string,
  source: { bytes: number; mtimeMs: number; sha256: string },
) {
  const response = await built.app.inject({
    method: "POST",
    url: `/api/v1/edge/v1/jobs/${jobId}/upload-credential`,
    headers: { authorization },
    payload: { leaseToken, source },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    uploadId: string;
    token: string;
  }>();
}

function authorizeTus(token: string, uploadId: string) {
  return built.app.inject({
    method: "GET",
    url: "/api/v1/internal/tus/authorize",
    headers: {
      "x-internal-token": internalToken,
      "upload-token": token,
      "x-forwarded-uri": `/files/${uploadId}`,
      "x-forwarded-method": "PATCH",
    },
  });
}

function reservedBytes(): number {
  return (
    built.database
      .prepare("SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM uploads")
      .get() as { readonly bytes: number }
  ).bytes;
}

function compatibleH264Probe() {
  return {
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        codec_tag_string: "avc1",
        pix_fmt: "yuv420p",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30/1",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
        channel_layout: "stereo",
      },
    ],
    format: {
      duration: "1.000",
      size: "4",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
  };
}
