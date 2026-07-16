import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { join, resolve } from "node:path";

import { v7 as uuidv7 } from "uuid";
import { AccessToken } from "livekit-server-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";

import { buildApp, type BuiltApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { clearLibraryData } from "../src/services/library-reset-service.js";
import { hashPassword } from "../src/security.js";

const origin = "https://watch.example.test";
const fixedNow = 1_750_000_000_000;
const internalToken = "test-internal-service-token-32-bytes";
const hostPassword = "host-test-password-24-characters";
const viewerPassword = "viewer-test-password-24-chars";
const temporaryRoots: string[] = [];
let built: BuiltApp;
let testRoot: string;
let currentNow: number;

beforeEach(async () => {
  currentNow = fixedNow;
  const tmpRoot = resolve("tmp");
  mkdirSync(tmpRoot, { recursive: true });
  testRoot = mkdtempSync(join(tmpRoot, "api-test-"));
  temporaryRoots.push(testRoot);
  built = await buildApp({
    databasePath: join(testRoot, "simplewatch.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    mediaRoot: join(testRoot, "media"),
    uploadRoot: join(testRoot, "uploads"),
    inboxRoot: join(testRoot, "inbox"),
    subtitleRoot: join(testRoot, "subtitles"),
    trashRoot: join(testRoot, "trash"),
    tusEndpoint: `${origin}/files/`,
    contentSigningSecret: "test-content-signing-secret-32-bytes",
    internalHookToken: internalToken,
    now: () => currentNow,
    authFailureDelay: () => Promise.resolve(),
  });
  await built.authService.bootstrapAdmin("Host", hostPassword);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await built.app.close();
  for (const path of temporaryRoots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("SimpleWatch API", () => {
  it("verifies LiveKit webhooks and re-enqueues an inactive participant idempotently", async () => {
    // Arrange
    const roomId = uuidv7();
    const memberId = uuidv7();
    const body = JSON.stringify({
      id: "EV_webhook_test",
      event: "participant_joined",
      room: { name: `voice:${roomId}` },
      participant: { identity: memberId },
      createdAt: fixedNow,
    });
    const webhookToken = new AccessToken(
      "test-api-key",
      "test-livekit-secret-at-least-32-bytes",
    );
    webhookToken.sha256 = createHash("sha256").update(body).digest("base64");
    const authorization = await webhookToken.toJwt();

    // Act
    const accepted = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/livekit/webhook",
      headers: {
        authorization,
        "content-type": "application/webhook+json",
      },
      payload: body,
    });
    const replayed = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/livekit/webhook",
      headers: {
        authorization,
        "content-type": "application/webhook+json",
      },
      payload: body,
    });
    const rejected = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/livekit/webhook",
      headers: {
        authorization: "invalid",
        "content-type": "application/webhook+json",
      },
      payload: body,
    });

    // Assert
    expect(accepted.statusCode).toBe(204);
    expect(replayed.statusCode).toBe(204);
    expect(rejected.statusCode).toBe(401);
    const queued = built.database
      .prepare(
        "SELECT kind, payload_json FROM service_outbox WHERE dedupe_key = ?",
      )
      .all("rtc-remove:webhook:EV_webhook_test") as Array<{
      kind: string;
      payload_json: string;
    }>;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "rtc.remove-participant" });
    expect(JSON.parse(queued[0]?.payload_json ?? "{}")).toEqual({
      roomId,
      memberId,
    });
  });

  it("issues scoped RTC credentials and validates the actual MediaMTX action/path", async () => {
    const room = await createRoom();
    const roomLivePath = (
      built.database
        .prepare("SELECT live_path FROM room_state WHERE room_id = ?")
        .get(room.roomId) as { live_path: string }
    ).live_path;
    expect(roomLivePath).toBe(built.transportService.getStablePublishPath());
    const bootstrap = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${room.roomId}/bootstrap`,
      headers: { cookie: room.roomCookie },
    });
    const csrfToken = bootstrap.json<{ csrfToken: string }>().csrfToken;
    const authHeaders = {
      cookie: room.roomCookie,
      origin,
      "x-csrf-token": csrfToken,
    };

    const voice = await built.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomId}/credentials`,
      headers: authHeaders,
      payload: { purpose: "voice" },
    });
    expect(voice.statusCode).toBe(200);
    expect(voice.json()).toMatchObject({
      purpose: "voice",
      url: "ws://127.0.0.1:7880",
    });

    const whep = await built.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomId}/credentials`,
      headers: authHeaders,
      payload: { purpose: "whep" },
    });
    expect(whep.statusCode).toBe(200);
    const mediaCredential = whep.json<{
      token: string;
      path: string;
    }>();
    const allowed = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/mediamtx/auth",
      headers: { origin },
      payload: {
        token: mediaCredential.token,
        action: "read",
        path: mediaCredential.path,
        id: "whep-session-1",
      },
    });
    expect(allowed.statusCode).toBe(204);

    const allowedWithoutSessionId = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/mediamtx/auth",
      headers: { origin },
      payload: {
        token: mediaCredential.token,
        action: "read",
        path: mediaCredential.path,
        id: null,
      },
    });
    expect(allowedWithoutSessionId.statusCode).toBe(204);

    const wrongPath = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/mediamtx/auth",
      headers: { origin },
      payload: {
        token: mediaCredential.token,
        action: "read",
        path: "another-path",
      },
    });
    expect(wrongPath.statusCode).toBe(403);

    const publish = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${room.roomId}/live/publish-config`,
      headers: authHeaders,
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json()).toMatchObject({ purpose: "whip" });
  });

  it("reports OBS live state from the MediaMTX control API and fails closed", async () => {
    const room = await createRoom();
    const livePath = (
      built.database
        .prepare("SELECT live_path FROM room_state WHERE room_id = ?")
        .get(room.roomId) as { live_path: string }
    ).live_path;
    const controlResponses = [
      new Response(
        JSON.stringify({
          items: [
            null,
            { name: "another-path", ready: true, source: {} },
            {
              name: livePath,
              ready: true,
              source: { type: "webRTCSession" },
              tracks: [{ codec: "H264" }, "Opus"],
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          items: [{ name: livePath, ready: false, tracks: ["H264"] }],
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ items: [{ name: livePath, ready: true }] }),
        { status: 200 },
      ),
      new Response(null, { status: 503 }),
    ];
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes(":9998/metrics"))
        return Promise.resolve(
          new Response("# no previous source sample\n", { status: 200 }),
        );
      const next = controlResponses.shift();
      if (next) return Promise.resolve(next);
      return Promise.reject(new Error("control API unavailable"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      built.transportService.getLiveStatus(room.roomId),
    ).resolves.toEqual({
      state: "online",
      hasVideo: true,
      hasAudio: true,
      videoTrackCount: 1,
      audioTrackCount: 1,
      sourceBitrateMbps: null,
      sourcePacketLossPercent: null,
      sourceHealth: "unknown",
      checkedAt: new Date(fixedNow).toISOString(),
    });
    await expect(
      built.transportService.getLiveStatus(room.roomId),
    ).resolves.toEqual({
      state: "offline",
      hasVideo: false,
      hasAudio: false,
      videoTrackCount: 0,
      audioTrackCount: 0,
      sourceBitrateMbps: null,
      sourcePacketLossPercent: null,
      sourceHealth: "unknown",
      checkedAt: new Date(fixedNow).toISOString(),
    });
    await expect(
      built.transportService.getLiveStatus(room.roomId),
    ).resolves.toEqual({
      state: "offline",
      hasVideo: false,
      hasAudio: false,
      videoTrackCount: 0,
      audioTrackCount: 0,
      sourceBitrateMbps: null,
      sourcePacketLossPercent: null,
      sourceHealth: "unknown",
      checkedAt: new Date(fixedNow).toISOString(),
    });
    await expect(
      built.transportService.getLiveStatus(room.roomId),
    ).resolves.toEqual({
      state: "unknown",
      hasVideo: false,
      hasAudio: false,
      videoTrackCount: 0,
      audioTrackCount: 0,
      sourceBitrateMbps: null,
      sourcePacketLossPercent: null,
      sourceHealth: "unknown",
      checkedAt: new Date(fixedNow).toISOString(),
    });
    await expect(
      built.transportService.getLiveStatus(room.roomId),
    ).resolves.toEqual({
      state: "unknown",
      hasVideo: false,
      hasAudio: false,
      videoTrackCount: 0,
      audioTrackCount: 0,
      sourceBitrateMbps: null,
      sourcePacketLossPercent: null,
      sourceHealth: "unknown",
      checkedAt: new Date(fixedNow).toISOString(),
    });
  });

  it("computes OBS source bitrate and interval packet loss from internal metrics", async () => {
    const room = await createRoom();
    const livePath = (
      built.database
        .prepare("SELECT live_path FROM room_state WHERE room_id = ?")
        .get(room.roomId) as { live_path: string }
    ).live_path;
    let metricsCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        if (!requestUrl(input).includes(":9998/metrics"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    name: livePath,
                    ready: true,
                    source: { type: "webRTCSession" },
                    tracks: ["H264", "Opus"],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        expect(new URL(requestUrl(input)).search).toBe("");
        metricsCall += 1;
        const suffix = `path="${livePath}",state="publish"`;
        return Promise.resolve(
          new Response(
            metricsCall === 1
              ? `webrtc_sessions_inbound_bytes{${suffix}} 0\nwebrtc_sessions_inbound_rtp_packets{${suffix}} 0\nwebrtc_sessions_inbound_rtp_packets_lost{${suffix}} 0\n`
              : `webrtc_sessions_inbound_bytes{${suffix}} 1000000\nwebrtc_sessions_inbound_rtp_packets{${suffix}} 1000\nwebrtc_sessions_inbound_rtp_packets_lost{${suffix}} 50\n`,
            { status: 200 },
          ),
        );
      }),
    );

    await expect(
      built.transportService.getLiveStatus(room.roomId),
    ).resolves.toMatchObject({ sourceHealth: "unknown" });
    currentNow += 2_000;
    await expect(
      built.transportService.getLiveStatus(room.roomId),
    ).resolves.toMatchObject({
      sourceBitrateMbps: 4,
      sourcePacketLossPercent: 50 / 10.5,
      sourceHealth: "poor",
    });
  });

  it("registers only SFTP files already moved into the inbox", async () => {
    const inboxPath = join(testRoot, "inbox", "stable-movie.mp4");
    writeFileSync(inboxPath, "test");
    const imported = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/imports/sftp",
      headers: { "x-internal-token": internalToken },
      payload: { filename: "stable-movie.mp4", filePath: inboxPath, bytes: 4 },
    });
    expect(imported.statusCode).toBe(201);
    const claimed = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/jobs/claim",
      headers: { "x-internal-token": internalToken },
      payload: { workerId: "sftp-test" },
    });
    expect(
      claimed.json<{ payload: { source: string; filePath: string } }>().payload,
    ).toMatchObject({ source: "sftp", filePath: inboxPath });

    const outsidePath = join(testRoot, "outside.mp4");
    writeFileSync(outsidePath, "test");
    const rejected = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/imports/sftp",
      headers: { "x-internal-token": internalToken },
      payload: { filename: "outside.mp4", filePath: outsidePath, bytes: 4 },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("validates tus hooks and enqueues a finished resumable upload idempotently", async () => {
    const admin = await loginAdmin();
    const authorize = await built.app.inject({
      method: "POST",
      url: "/api/v1/uploads/authorize",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: { filename: "resume.mp4", bytes: 4, mime: "video/mp4" },
    });
    const upload = authorize.json<{ uploadId: string; uploadToken: string }>();
    const hookHeaders = { "x-internal-token": internalToken };
    const hookEvent = (type: string, offset = 0) => ({
      Type: type,
      Event: {
        Upload: {
          ID: upload.uploadId,
          Size: 4,
          Offset: offset,
          MetaData: { filename: "resume.mp4", filetype: "video/mp4" },
        },
        HTTPRequest: { Header: { "Upload-Token": [upload.uploadToken] } },
      },
    });

    const preCreate = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/tus/hooks",
      headers: hookHeaders,
      payload: hookEvent("pre-create"),
    });
    expect(preCreate.statusCode).toBe(200);
    expect(preCreate.json()).toMatchObject({
      ChangeFileInfo: { ID: upload.uploadId },
    });

    const tusAllowed = await built.app.inject({
      method: "GET",
      url: "/api/v1/internal/tus/authorize",
      headers: {
        ...hookHeaders,
        "upload-token": upload.uploadToken,
        "x-forwarded-uri": `/files/${upload.uploadId}`,
      },
    });
    expect(tusAllowed.statusCode).toBe(204);

    writeFileSync(join(testRoot, "uploads", upload.uploadId), "test");
    const finish = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/tus/hooks",
      headers: hookHeaders,
      payload: hookEvent("post-finish", 4),
    });
    expect(finish.statusCode).toBe(200);
    const repeated = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/tus/hooks",
      headers: hookHeaders,
      payload: hookEvent("post-finish", 4),
    });
    expect(repeated.statusCode).toBe(200);

    const claimed = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/jobs/claim",
      headers: hookHeaders,
      payload: { workerId: "tus-test" },
    });
    expect(
      claimed.json<{ payload: { uploadId: string } }>().payload.uploadId,
    ).toBe(upload.uploadId);
  });

  it("cancels one active upload and removes its temporary bytes idempotently", async () => {
    const admin = await loginAdmin();
    const authorize = await built.app.inject({
      method: "POST",
      url: "/api/v1/uploads/authorize",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: { filename: "cancel.mp4", bytes: 8, mime: "video/mp4" },
    });
    const upload = authorize.json<{ uploadId: string; uploadToken: string }>();
    writeFileSync(join(testRoot, "uploads", upload.uploadId), "partial");
    writeFileSync(join(testRoot, "uploads", `${upload.uploadId}.info`), "{}");

    const cancelled = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/uploads/${upload.uploadId}`,
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
    });
    expect(cancelled.statusCode).toBe(204);
    expect(existsSync(join(testRoot, "uploads", upload.uploadId))).toBe(false);
    expect(
      existsSync(join(testRoot, "uploads", `${upload.uploadId}.info`)),
    ).toBe(false);
    const row = built.database
      .prepare("SELECT state, reserved_bytes FROM uploads WHERE id = ?")
      .get(upload.uploadId) as { state: string; reserved_bytes: number };
    expect(row).toEqual({ state: "cancelled", reserved_bytes: 0 });

    const repeated = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/uploads/${upload.uploadId}`,
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
    });
    expect(repeated.statusCode).toBe(204);
  });

  it("authorizes, probes, publishes, and protects uploaded media", async () => {
    const admin = await loginAdmin();
    const authorize = await built.app.inject({
      method: "POST",
      url: "/api/v1/uploads/authorize",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: { filename: "sample.mp4", bytes: 4, mime: "video/mp4" },
    });
    expect(authorize.statusCode).toBe(201);
    const upload = authorize.json<{ uploadId: string; uploadToken: string }>();
    const receivedPath = join(testRoot, "uploads", `${upload.uploadId}.part`);
    writeFileSync(receivedPath, "test");

    const completed = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/uploads/complete",
      headers: { "x-internal-token": internalToken },
      payload: {
        uploadId: upload.uploadId,
        uploadToken: upload.uploadToken,
        filePath: receivedPath,
        receivedBytes: 4,
      },
    });
    expect(completed.statusCode).toBe(201);
    const mediaId = completed.json<{ mediaId: string }>().mediaId;

    const claimed = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/jobs/claim",
      headers: { "x-internal-token": internalToken },
      payload: { workerId: "integration-worker" },
    });
    expect(claimed.statusCode).toBe(200);
    let job = claimed.json<{
      id: string;
      leaseToken: string;
      payload: { storageKey: string };
    }>();
    const expiredLeaseToken = job.leaseToken;
    built.database
      .prepare("UPDATE media_jobs SET lease_until = ? WHERE id = ?")
      .run(fixedNow - 1, job.id);
    const reclaimed = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/jobs/claim",
      headers: { "x-internal-token": internalToken },
      payload: { workerId: "restarted-integration-worker" },
    });
    expect(reclaimed.statusCode).toBe(200);
    job = reclaimed.json<typeof job>();
    expect(job.leaseToken).not.toBe(expiredLeaseToken);
    const reclaimedState = built.database
      .prepare("SELECT attempts FROM media_jobs WHERE id = ?")
      .get(job.id) as { attempts: number };
    expect(reclaimedState.attempts).toBe(2);
    const publishedDirectory = join(testRoot, "media", job.payload.storageKey);
    mkdirSync(publishedDirectory, { recursive: true });
    const finalPath = join(publishedDirectory, "content.mp4");
    writeFileSync(finalPath, "test");

    const result = await built.app.inject({
      method: "POST",
      url: `/api/v1/internal/jobs/${job.id}/result`,
      headers: { "x-internal-token": internalToken },
      payload: {
        leaseToken: job.leaseToken,
        compatible: true,
        probe: compatibleH264Probe(),
        reasons: [],
        sha256:
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        bytes: 4,
        durationMs: 1000,
        finalPath,
      },
    });
    expect(result.statusCode).toBe(204);

    const subtitleContent = "WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n";
    const subtitleJobResponse = await built.app.inject({
      method: "POST",
      url: `/api/v1/admin/media/${mediaId}/subtitles`,
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: { language: "zh-CN", label: "中文", content: subtitleContent },
    });
    expect(subtitleJobResponse.statusCode).toBe(202);
    const subtitleJobId = subtitleJobResponse.json<{ jobId: string }>().jobId;
    const subtitleClaim = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/jobs/claim",
      headers: { "x-internal-token": internalToken },
      payload: { workerId: "subtitle-worker" },
    });
    const subtitleJob = subtitleClaim.json<{
      id: string;
      leaseToken: string;
      payload: { storageKey: string; contentBase64: string };
    }>();
    expect(subtitleJob.id).toBe(subtitleJobId);
    const subtitleBytes = Buffer.from(
      subtitleJob.payload.contentBase64,
      "base64",
    );
    const subtitlePath = join(
      testRoot,
      "subtitles",
      `${subtitleJob.payload.storageKey}.vtt`,
    );
    writeFileSync(subtitlePath, subtitleBytes);
    const subtitleResult = await built.app.inject({
      method: "POST",
      url: `/api/v1/internal/jobs/${subtitleJob.id}/subtitle-result`,
      headers: { "x-internal-token": internalToken },
      payload: {
        leaseToken: subtitleJob.leaseToken,
        finalPath: subtitlePath,
        bytes: subtitleBytes.length,
        sha256: createHash("sha256").update(subtitleBytes).digest("hex"),
      },
    });
    expect(subtitleResult.statusCode).toBe(204);
    const mediaMetadata = await built.app.inject({
      method: "GET",
      url: `/api/v1/media/${mediaId}`,
      headers: { cookie: admin.cookie },
    });
    const subtitleId = mediaMetadata.json<{
      subtitles: Array<{ id: string }>;
    }>().subtitles[0]?.id;
    expect(subtitleId).toBeTruthy();
    const subtitle = await built.app.inject({
      method: "GET",
      url: `/api/v1/subtitles/${subtitleId}`,
      headers: { cookie: admin.cookie },
    });
    expect(subtitle.statusCode).toBe(200);
    expect(subtitle.headers["content-type"]).toContain("text/vtt");
    expect(subtitle.body).toBe(subtitleContent);

    const content = await built.app.inject({
      method: "GET",
      url: `/api/v1/media/${mediaId}/content`,
      headers: { cookie: admin.cookie },
    });
    expect(content.statusCode).toBe(307);
    const location = content.headers.location;
    expect(location).toMatch(/^\/media-files\//);

    const allowed = await built.app.inject({
      method: "GET",
      url: "/api/v1/internal/media/authorize",
      headers: {
        cookie: admin.cookie,
        "x-internal-token": internalToken,
        "x-forwarded-method": "GET",
        "x-forwarded-uri": location,
      },
    });
    expect(allowed.statusCode).toBe(204);

    const denied = await built.app.inject({
      method: "GET",
      url: "/api/v1/internal/media/authorize",
      headers: {
        cookie: admin.cookie,
        "x-internal-token": internalToken,
        "x-forwarded-method": "GET",
        "x-forwarded-uri": `${location}x`,
      },
    });
    expect(denied.statusCode).toBe(401);
  });

  it("creates an authenticated room and rotates CSRF during bootstrap", async () => {
    const admin = await loginAdmin();
    const created = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {},
    });

    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{
      room: { id: string };
      member: { role: string };
      csrfToken: string;
    }>();
    expect(createdBody).toMatchObject({ member: { role: "host" } });

    const roomCookie = admin.cookie;
    const bootstrap = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${createdBody.room.id}/bootstrap`,
      headers: { cookie: roomCookie },
    });
    expect(bootstrap.statusCode).toBe(200);
    const bootstrapBody = bootstrap.json<{
      csrfToken: string;
      snapshot: { revision: number; members: unknown[] };
    }>();
    expect(bootstrapBody.snapshot).toMatchObject({ revision: 0 });
    expect(bootstrapBody.snapshot.members).toHaveLength(1);
    expect(bootstrapBody.csrfToken).not.toBe(createdBody.csrfToken);

    const staleCsrfLeave = await built.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${createdBody.room.id}/leave`,
      headers: {
        cookie: roomCookie,
        origin,
        "x-csrf-token": createdBody.csrfToken,
      },
    });
    expect(staleCsrfLeave.statusCode).toBe(401);
  });

  it("enforces five account seats and lets a new device take over one account", async () => {
    await createRoom();
    const firstJoin = await joinRoom("Alice");
    expect(firstJoin.statusCode).toBe(200);
    const firstCookie = readCookie(firstJoin, "__Host-sw_session");
    const firstMember = firstJoin.json<{ member: { id: string } }>().member.id;

    const duplicate = await joinRoom("alice");
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      tookOver: true,
      member: { id: firstMember },
    });
    const oldDevice = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${firstJoin.json<{ room: { id: string } }>().room.id}/bootstrap`,
      headers: { cookie: firstCookie },
    });
    expect(oldDevice.statusCode).toBe(401);

    await joinRoom("Bob");
    await joinRoom("Carol");
    await joinRoom("Dave");
    const full = await joinRoom("Eve");
    expect(full.statusCode).toBe(429);
    expect(full.json()).toMatchObject({ error: { code: "ROOM_FULL" } });
  });

  it("persists idempotent host commands and rejects revision conflicts", async () => {
    const room = await createRoom();
    const identity = built.roomService.authenticate(
      cookieValue(room.roomCookie),
      room.roomId,
    );
    const commandId = uuidv7();
    const command = {
      commandId,
      expectedRevision: 0,
      effectiveAtServerMs: 0,
      command: { kind: "select-live" as const },
    };

    const accepted = built.roomService.applyCommand(identity, command);
    const replayed = built.roomService.applyCommand(identity, command);
    expect(replayed).toEqual(accepted);
    expect(accepted).toMatchObject({ mode: "live", revision: 1 });

    expect(() =>
      built.roomService.applyCommand(identity, {
        ...command,
        commandId: uuidv7(),
      }),
    ).toThrowError("房间状态版本已变化");
  });

  it("clamps host seeks to the selected media duration", async () => {
    const room = await createRoom();
    const identity = built.roomService.authenticate(
      cookieValue(room.roomCookie),
      room.roomId,
    );
    const mediaId = insertPublishedMedia("seek-clamp", 90_000);
    const selected = built.roomService.applyCommand(identity, {
      commandId: uuidv7(),
      expectedRevision: 0,
      effectiveAtServerMs: 0,
      command: { kind: "select-vod", mediaId },
    });
    const seeked = built.roomService.applyCommand(identity, {
      commandId: uuidv7(),
      expectedRevision: selected.revision,
      effectiveAtServerMs: 0,
      command: { kind: "seek", positionSec: 9_999 },
    });

    expect(seeked.transport?.positionSec).toBe(90);
  });

  it("moves media to one timestamped trash entry and compensates database failures", async () => {
    const admin = await loginAdmin();
    const mediaId = insertPublishedMedia("delete-success", 1_000);
    const deleted = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/media/${mediaId}`,
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      existsSync(join(testRoot, "trash", `delete-success-${fixedNow}`)),
    ).toBe(true);
    expect(existsSync(join(testRoot, "media", "delete-success"))).toBe(false);
    expect(
      (
        built.database
          .prepare("SELECT trashed_at FROM media WHERE id = ?")
          .get(mediaId) as { trashed_at: number }
      ).trashed_at,
    ).toBe(fixedNow);

    const compensatedId = insertPublishedMedia("delete-compensated", 1_000);
    built.database.exec(`
      CREATE TRIGGER reject_media_trash
      BEFORE UPDATE OF trashed_at ON media
      BEGIN SELECT RAISE(FAIL, 'forced trash failure'); END;
    `);
    expect(() => built.mediaService.trashMedia("admin", compensatedId)).toThrow(
      "forced trash failure",
    );
    expect(
      existsSync(join(testRoot, "media", "delete-compensated", "content.mp4")),
    ).toBe(true);
    expect(
      existsSync(join(testRoot, "trash", `delete-compensated-${fixedNow}`)),
    ).toBe(false);
  });

  it("blocks deleting media referenced by an active room", async () => {
    const room = await createRoom();
    const admin = await loginAdmin();
    const mediaId = insertPublishedMedia("active-media", 1_000);
    built.database
      .prepare(
        "UPDATE room_state SET mode = 'vod', media_id = ? WHERE room_id = ?",
      )
      .run(mediaId, room.roomId);

    const response = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/media/${mediaId}`,
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "MEDIA_IN_USE" } });
    expect(
      existsSync(join(testRoot, "media", "active-media", "content.mp4")),
    ).toBe(true);
  });

  it("purges expired trash artifacts and closed-room references after 24 hours", async () => {
    const room = await createRoom();
    const mediaId = insertPublishedMedia("expired-media", 1_000);
    const trashedAt = fixedNow - 24 * 60 * 60 * 1000;
    const subtitleId = uuidv7();
    const subtitleKey = "expired-subtitle";
    built.database
      .prepare(
        `INSERT INTO subtitles(id, media_id, storage_key, language, label, format, created_at)
         VALUES (?, ?, ?, 'zh-CN', '中文', 'webvtt', ?)`,
      )
      .run(subtitleId, mediaId, subtitleKey, fixedNow);
    built.database
      .prepare(
        `INSERT INTO media_jobs(
          id, media_id, kind, state, attempts, not_before,
          created_at, updated_at, payload_json
        ) VALUES (?, ?, 'probe', 'completed', 1, ?, ?, ?, '{}')`,
      )
      .run(uuidv7(), mediaId, fixedNow, fixedNow, fixedNow);
    built.database
      .prepare("UPDATE media SET trashed_at = ? WHERE id = ?")
      .run(trashedAt, mediaId);
    built.database
      .prepare("UPDATE rooms SET status = 'closed', closed_at = ? WHERE id = ?")
      .run(fixedNow, room.roomId);
    built.database
      .prepare("UPDATE room_state SET media_id = ? WHERE room_id = ?")
      .run(mediaId, room.roomId);
    rmSync(join(testRoot, "media", "expired-media"), {
      recursive: true,
      force: true,
    });
    const trashDirectory = join(
      testRoot,
      "trash",
      `expired-media-${trashedAt}`,
    );
    mkdirSync(trashDirectory, { recursive: true });
    writeFileSync(join(trashDirectory, "content.mp4"), "test");
    writeFileSync(
      join(testRoot, "subtitles", `${subtitleKey}.vtt`),
      "WEBVTT\n",
    );

    built.mediaService.listMedia();

    expect(
      built.database.prepare("SELECT id FROM media WHERE id = ?").get(mediaId),
    ).toBeUndefined();
    expect(
      (
        built.database
          .prepare("SELECT media_id FROM room_state WHERE room_id = ?")
          .get(room.roomId) as { media_id: string | null }
      ).media_id,
    ).toBeNull();
    expect(existsSync(trashDirectory)).toBe(false);
    expect(existsSync(join(testRoot, "subtitles", `${subtitleKey}.vtt`))).toBe(
      false,
    );
  });

  it("immediately revokes a member kicked by the host", async () => {
    const room = await createRoom();
    const hostBootstrap = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${room.roomId}/bootstrap`,
      headers: { cookie: room.roomCookie },
    });
    const hostCsrf = hostBootstrap.json<{ csrfToken: string }>().csrfToken;
    const joined = await joinRoom("Removed Member");
    const joinedBody = joined.json<{
      member: { id: string };
      csrfToken: string;
    }>();
    const joinedCookie = readCookie(joined, "__Host-sw_session");
    const mediaCredential = await built.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomId}/credentials`,
      headers: {
        cookie: joinedCookie,
        origin,
        "x-csrf-token": joinedBody.csrfToken,
      },
      payload: { purpose: "whep" },
    });
    const scopedMedia = mediaCredential.json<{ token: string; path: string }>();
    const mediaConnected = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/mediamtx/auth",
      payload: {
        token: scopedMedia.token,
        action: "read",
        path: scopedMedia.path,
        id: "member-media-session",
      },
    });
    expect(mediaConnected.statusCode).toBe(204);
    const kicked = await built.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomId}/members/${joinedBody.member.id}/kick`,
      headers: {
        cookie: room.roomCookie,
        origin,
        "x-csrf-token": hostCsrf,
      },
      payload: { reason: "removed" },
    });
    expect(kicked.statusCode).toBe(200);

    const revoked = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${room.roomId}/bootstrap`,
      headers: { cookie: joinedCookie },
    });
    expect(revoked.statusCode).toBe(401);
    const mediaRevoked = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/mediamtx/auth",
      payload: {
        token: scopedMedia.token,
        action: "read",
        path: scopedMedia.path,
      },
    });
    expect(mediaRevoked.statusCode).toBe(403);
    const outbox = built.database
      .prepare("SELECT kind, state FROM service_outbox ORDER BY kind")
      .all() as Array<{ kind: string; state: string }>;
    expect(outbox).toEqual([
      { kind: "mediamtx.kick-sessions", state: "pending" },
      { kind: "rtc.remove-participant", state: "pending" },
    ]);

    const claims = [] as Array<{
      id: string;
      kind: string;
      leaseToken: string;
      payload: { memberId: string; sessionIds?: string[] };
    }>;
    for (let index = 0; index < 2; index += 1) {
      const claimed = await built.app.inject({
        method: "POST",
        url: "/api/v1/internal/outbox/claim",
        headers: { "x-internal-token": internalToken },
        payload: { workerId: "integration-worker" },
      });
      expect(claimed.statusCode).toBe(200);
      claims.push(claimed.json<(typeof claims)[number]>());
    }
    expect(new Set(claims.map((item) => item.id)).size).toBe(2);
    const mediaClaim = claims.find(
      (item) => item.kind === "mediamtx.kick-sessions",
    );
    expect(mediaClaim?.payload).toEqual({
      roomId: room.roomId,
      memberId: joinedBody.member.id,
      sessionIds: ["member-media-session"],
    });

    const wrongLease = await built.app.inject({
      method: "POST",
      url: `/api/v1/internal/outbox/${claims[0]?.id}/complete`,
      headers: { "x-internal-token": internalToken },
      payload: { leaseToken: "wrong-lease" },
    });
    expect(wrongLease.statusCode).toBe(409);

    const rtcClaimIndex = claims.findIndex(
      (item) => item.kind === "rtc.remove-participant",
    );
    const rtcClaim = claims[rtcClaimIndex];
    expect(rtcClaim).toBeDefined();
    const failedAttempt = await built.app.inject({
      method: "POST",
      url: `/api/v1/internal/outbox/${rtcClaim?.id}/fail`,
      headers: { "x-internal-token": internalToken },
      payload: {
        leaseToken: rtcClaim?.leaseToken,
        error: "simulated downstream outage",
      },
    });
    expect(failedAttempt.statusCode).toBe(204);
    const retryState = built.database
      .prepare(
        "SELECT state, attempts, last_error FROM service_outbox WHERE id = ?",
      )
      .get(rtcClaim?.id) as {
      state: string;
      attempts: number;
      last_error: string | null;
    };
    expect(retryState).toEqual({
      state: "pending",
      attempts: 1,
      last_error: "simulated downstream outage",
    });
    built.database
      .prepare("UPDATE service_outbox SET not_before = ? WHERE id = ?")
      .run(fixedNow, rtcClaim?.id);
    const reclaimed = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/outbox/claim",
      headers: { "x-internal-token": internalToken },
      payload: { workerId: "restarted-worker" },
    });
    expect(reclaimed.statusCode).toBe(200);
    const retriedClaim = reclaimed.json<(typeof claims)[number]>();
    expect(retriedClaim.id).toBe(rtcClaim?.id);
    expect(retriedClaim.leaseToken).not.toBe(rtcClaim?.leaseToken);
    claims[rtcClaimIndex] = retriedClaim;

    for (const claim of claims) {
      const completed = await built.app.inject({
        method: "POST",
        url: `/api/v1/internal/outbox/${claim.id}/complete`,
        headers: { "x-internal-token": internalToken },
        payload: { leaseToken: claim.leaseToken },
      });
      expect(completed.statusCode).toBe(204);
    }
    const completedCount = built.database
      .prepare(
        "SELECT COUNT(*) AS count FROM service_outbox WHERE state = 'completed'",
      )
      .get() as { count: number };
    const closedMediaSession = built.database
      .prepare(
        "SELECT closed_at FROM media_transport_sessions WHERE mediamtx_session_id = ?",
      )
      .get("member-media-session") as { closed_at: number | null };
    expect(completedCount.count).toBe(2);
    expect(closedMediaSession.closed_at).toBe(fixedNow);
  });

  it("closes the room and revokes every room session", async () => {
    const admin = await loginAdmin();
    const created = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {},
    });
    const roomId = created.json<{ room: { id: string } }>().room.id;
    const roomCsrf = created.json<{ csrfToken: string }>().csrfToken;
    const roomCookie = admin.cookie;
    const closed = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${roomId}`,
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": roomCsrf,
      },
      payload: { close: true },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ id: roomId, status: "closed" });

    const bootstrap = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/bootstrap`,
      headers: { cookie: roomCookie },
    });
    expect(bootstrap.statusCode).toBe(401);
  });

  it("monitors the one active room, re-enters as host, and force-closes everyone", async () => {
    const admin = await loginAdmin();
    const created = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {},
    });
    const roomId = created.json<{ room: { id: string } }>().room.id;
    const roomCsrf = created.json<{ csrfToken: string }>().csrfToken;
    const member = await joinRoom("Friend");
    const memberCookie = readCookie(member, "__Host-sw_session");

    const summary = await built.app.inject({
      method: "GET",
      url: "/api/v1/admin/active-room",
      headers: { cookie: admin.cookie },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      id: roomId,
      memberCount: 2,
      maxMembers: 5,
      host: { nickname: "Host" },
      mode: "idle",
      content: null,
      live: { state: "offline" },
    });

    const hostSession = await built.app.inject({
      method: "POST",
      url: "/api/v1/room/takeover",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": roomCsrf,
      },
      payload: {},
    });
    expect(hostSession.statusCode).toBe(200);
    const reentryCookie = admin.cookie;

    const closed = await built.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/active-room",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": roomCsrf,
      },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ id: roomId, status: "closed" });
    for (const cookie of [memberCookie, reentryCookie]) {
      const rejected = await built.app.inject({
        method: "GET",
        url: `/api/v1/rooms/${roomId}/bootstrap`,
        headers: { cookie },
      });
      expect(rejected.statusCode).toBe(401);
    }
    const empty = await built.app.inject({
      method: "GET",
      url: "/api/v1/admin/active-room",
      headers: { cookie: admin.cookie },
    });
    expect(empty.json()).toBeNull();
  });

  it("authenticates WebSocket messages and returns clock/snapshot envelopes", async () => {
    const room = await createRoom();
    const socket = await built.app.injectWS(`/api/v1/rooms/${room.roomId}/ws`, {
      headers: {
        cookie: room.roomCookie,
        origin,
        "sec-websocket-protocol": "simplewatch.v1",
      },
    });

    const snapshotMessage = nextMessage(socket);
    socket.send(
      JSON.stringify({
        v: 1,
        type: "room.hello",
        id: uuidv7(),
        roomId: room.roomId,
        sentAtMs: fixedNow,
        payload: {},
      }),
    );
    expect(await snapshotMessage).toMatchObject({
      v: 1,
      type: "room.snapshot",
      roomId: room.roomId,
      payload: { revision: 0, mode: "idle" },
    });

    const pongMessage = nextMessage(socket);
    socket.send(
      JSON.stringify({
        v: 1,
        type: "clock.ping",
        id: uuidv7(),
        roomId: room.roomId,
        sentAtMs: fixedNow,
        payload: { clientSentAtMs: fixedNow - 50 },
      }),
    );
    expect(await pongMessage).toMatchObject({
      type: "clock.pong",
      payload: {
        clientSentAtMs: fixedNow - 50,
        serverReceivedAtMs: fixedNow,
        serverSentAtMs: fixedNow,
      },
    });
    socket.close();
  });

  it("does not transfer host authority when the host disconnects", async () => {
    const room = await createRoom();
    const joined = await joinRoom("Viewer");
    const snapshot = built.roomService.getSnapshot(room.roomId);
    expect(snapshot.hostMemberId).not.toBe(
      joined.json<{ member: { id: string } }>().member.id,
    );
  });

  it("retires the legacy friend-link endpoint and uses fixed accounts", async () => {
    const room = await createRoom();
    expect(room.roomId).toBeTruthy();
    const invalid = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms/active/join",
      headers: { origin },
      payload: {
        nickname: "Invalid Link",
        inviteToken: "invalid-friend-token-with-32-characters",
      },
    });
    expect(invalid.statusCode).toBe(410);

    const valid = await joinRoom("Valid Friend");
    expect(valid.statusCode).toBe(200);
  });

  it("atomically clears all rooms, uploads and library files while preserving the admin", async () => {
    await createRoom();
    const admin = await loginAdmin();
    const upload = await built.app.inject({
      method: "POST",
      url: "/api/v1/uploads/authorize",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: { filename: "partial.mp4", bytes: 4, mime: "video/mp4" },
    });
    const uploadId = upload.json<{ uploadId: string }>().uploadId;
    writeFileSync(join(testRoot, "uploads", uploadId), "part");
    writeFileSync(join(testRoot, "uploads", `${uploadId}.info`), "{}");
    writeFileSync(join(testRoot, "media", "old.mp4"), "media");
    writeFileSync(join(testRoot, "inbox", "waiting.mp4"), "inbox");
    writeFileSync(join(testRoot, "subtitles", "old.vtt"), "WEBVTT\n");
    const sftpRoot = join(testRoot, "sftp-incoming");
    const trashRoot = join(testRoot, "trash");
    mkdirSync(sftpRoot);
    mkdirSync(trashRoot, { recursive: true });
    writeFileSync(join(sftpRoot, "uploading.part"), "sftp");
    writeFileSync(join(trashRoot, "trashed.mp4"), "trash");

    const quarantine = join(testRoot, "quarantine", "reset-1");
    mkdirSync(join(testRoot, "quarantine"));
    const result = await clearLibraryData(built.database, {
      quarantine,
      roots: [
        join(testRoot, "media"),
        join(testRoot, "uploads"),
        join(testRoot, "inbox"),
        join(testRoot, "subtitles"),
        sftpRoot,
        trashRoot,
        join(testRoot, "optional-root-that-does-not-exist"),
      ],
      now: () => fixedNow,
    });

    expect(result.movedEntries).toBe(7);
    for (const table of [
      "rooms",
      "room_members",
      "room_sessions",
      "uploads",
      "media",
      "subtitles",
      "media_jobs",
      "token_jti",
      "service_outbox",
      "audit_events",
    ]) {
      const row = built.database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number };
      expect(row.count, table).toBe(0);
    }
    expect(
      (
        built.database
          .prepare("SELECT COUNT(*) AS count FROM admin_users")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        built.database
          .prepare(
            "SELECT COUNT(*) AS count FROM admin_sessions WHERE revoked_at IS NULL",
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(existsSync(join(quarantine, "simplewatch.sqlite3"))).toBe(true);
    expect(existsSync(join(quarantine, "CLEAR_COMPLETE.json"))).toBe(true);
    expect(existsSync(join(quarantine, "files", "uploads", uploadId))).toBe(
      true,
    );
    expect(existsSync(join(testRoot, "media", "old.mp4"))).toBe(false);
  });

  it("refuses to start when an applied migration checksum changes", async () => {
    await built.app.close();
    const testRoot = temporaryRoots.at(-1);
    if (!testRoot) throw new Error("missing test root");
    const migrationCopy = join(testRoot, "migrations");
    mkdirSync(migrationCopy);
    const migration = readFileSync(
      resolve("migrations/001_initial.sql"),
      "utf8",
    );
    writeFileSync(join(migrationCopy, "001_initial.sql"), migration);
    const databasePath = join(testRoot, "checksum.sqlite3");
    const database = openDatabase({
      databasePath,
      migrationsPath: migrationCopy,
    });
    database.close();
    writeFileSync(
      join(migrationCopy, "001_initial.sql"),
      `${migration}\n-- changed`,
    );

    expect(() =>
      openDatabase({ databasePath, migrationsPath: migrationCopy }),
    ).toThrow("checksum 已改变");
    built = await buildApp({
      databasePath: join(testRoot, "replacement.sqlite3"),
      migrationsPath: resolve("migrations"),
      publicOrigin: origin,
    });
  });
});

async function loginAdmin(): Promise<{ cookie: string; csrfToken: string }> {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin },
    payload: { username: "Host", password: hostPassword },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: readCookie(response, "__Host-sw_session"),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function createRoom(): Promise<{ roomId: string; roomCookie: string }> {
  const admin = await loginAdmin();
  const response = await built.app.inject({
    method: "POST",
    url: "/api/v1/rooms",
    headers: { cookie: admin.cookie, origin, "x-csrf-token": admin.csrfToken },
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return {
    roomId: response.json<{ room: { id: string } }>().room.id,
    roomCookie: admin.cookie,
  };
}

function insertPublishedMedia(storageKey: string, durationMs: number): string {
  const mediaId = uuidv7();
  const directory = join(testRoot, "media", storageKey);
  mkdirSync(directory, { recursive: true });
  const finalPath = join(directory, "content.mp4");
  writeFileSync(finalPath, "test");
  built.database
    .prepare(
      `INSERT INTO media(
        id, storage_key, display_name, state, bytes, sha256, mime,
        probe_json, duration_ms, created_at, trashed_at, video_codec,
        playback_support, video_width, video_height, video_fps,
        video_pixel_format
      ) VALUES (?, ?, ?, 'published', 4, ?, 'video/mp4', ?, ?, ?, NULL,
        'h264', 'broad', 1920, 1080, 30, 'yuv420p')`,
    )
    .run(
      mediaId,
      storageKey,
      `${storageKey}.mp4`,
      createHash("sha256").update("test").digest("hex"),
      JSON.stringify({
        probe: compatibleH264Probe(),
        reasons: [],
        finalPath,
      }),
      durationMs,
      fixedNow,
    );
  return mediaId;
}

async function joinRoom(nickname: string) {
  const folded = nickname.normalize("NFC").toLocaleLowerCase("en-US");
  let account = built.database
    .prepare("SELECT id FROM accounts WHERE username_folded = ?")
    .get(folded) as { id: string } | undefined;
  if (!account) {
    account = { id: uuidv7() };
    const passwordHash = await hashPassword(
      createHmac("sha256", "test-password-pepper-not-for-production")
        .update(viewerPassword)
        .digest("base64url"),
    );
    built.database
      .prepare(
        `INSERT INTO accounts(
          id, username, username_folded, role, password_hash, enabled,
          created_at, password_changed_at
        ) VALUES (?, ?, ?, 'viewer', ?, 1, ?, ?)`,
      )
      .run(account.id, nickname, folded, passwordHash, fixedNow, fixedNow);
  }
  const login = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin },
    payload: { username: nickname, password: viewerPassword },
  });
  const loginBody = login.json<{
    csrfToken: string;
    destination: {
      state: string;
      roomId?: string;
      memberId?: string;
      tookOver?: boolean;
      reason?: string;
    };
  }>();
  const csrfToken = loginBody.csrfToken;
  const entry = loginBody.destination as {
    state: string;
    roomId?: string;
    memberId?: string;
    tookOver?: boolean;
    reason?: string;
  };
  const full = entry.state === "waiting" && entry.reason === "room-full";
  return {
    statusCode: full ? 429 : login.statusCode,
    headers: login.headers,
    json<T = unknown>(): T {
      if (full) return { error: { code: "ROOM_FULL" } } as T;
      return {
        ...entry,
        room: { id: entry.roomId },
        member: { id: entry.memberId },
        csrfToken,
      } as T;
    },
  };
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

function readCookie(
  response: { headers: Record<string, string | string[] | number | undefined> },
  name: string,
): string {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header)
    ? header
    : typeof header === "string"
      ? [header]
      : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`missing cookie ${name}`);
  return cookie.split(";", 1)[0] ?? "";
}

function cookieValue(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1);
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    socket.once("error", rejectMessage);
    socket.once("message", (data: RawData) => {
      socket.off("error", rejectMessage);
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      resolveMessage(
        JSON.parse(bytes.toString("utf8")) as Record<string, unknown>,
      );
    });
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
