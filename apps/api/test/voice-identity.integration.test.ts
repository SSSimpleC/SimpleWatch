import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { decodeJwt } from "jose";
import { AccessToken } from "livekit-server-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import { buildApp, type BuiltApp } from "../src/app.js";
import {
  getRtcLease,
  parseRtcIdentity,
  rtcIdentity,
} from "../src/services/rtc-identity.js";

const origin = "https://watch.example.test";
const internalToken = "voice-regression-internal-token-32-bytes";
const password = "voice-test-password-24-characters";
let built: BuiltApp;
let root: string;
let now: number;
let roomId: string;
let hostToken: string;

beforeEach(async () => {
  now = 1_750_000_000_000;
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/voice-api-"));
  built = await buildApp({
    databasePath: join(root, "test.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    internalHookToken: internalToken,
    mediaRoot: join(root, "media"),
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    now: () => now,
    authFailureDelay: () => Promise.resolve(),
  });
  await built.authService.provisionAccounts([
    { username: "Host", role: "host", password },
    { username: "Viewer", role: "viewer", password },
  ]);
  const host = await login("Host");
  hostToken = host.sessionToken;
  roomId = built.roomService.createAccountRoom(host.session).roomId;
});

afterEach(async () => {
  await built.app.close();
  rmSync(root, { recursive: true, force: true });
});

async function login(username = "Viewer") {
  const logged = await built.authService.login(username, password, "127.0.0.1");
  return {
    ...logged,
    session: built.authService.authenticate(logged.sessionToken),
  };
}

async function joinViewer() {
  const logged = await login();
  const entry = built.roomService.enterAccountRoom(logged.session);
  if (entry.state !== "room")
    throw new Error(`Unexpected entry ${entry.state}`);
  return { ...logged, memberId: entry.memberId };
}

async function credential(token: string) {
  return built.transportService.issueCredential(
    built.roomService.authenticate(token, roomId),
    "voice",
  );
}

function tokenIdentity(token: string): string {
  const value = decodeJwt(token).sub;
  if (!value) throw new Error("Missing RTC identity");
  return value;
}

function queuedRtcIdentities(): string[] {
  return (
    built.database
      .prepare(
        "SELECT payload_json FROM service_outbox WHERE kind = 'rtc.remove-participant' ORDER BY created_at, id",
      )
      .all() as Array<{ payload_json: string }>
  ).map(
    (row) =>
      (JSON.parse(row.payload_json) as { rtcIdentity: string }).rtcIdentity,
  );
}

async function webhook(identity: string, eventId = `EV_${uuidv7()}`) {
  const body = JSON.stringify({
    id: eventId,
    event: "participant_joined",
    createdAt: Math.floor(now / 1000),
    room: { name: `voice:${roomId}` },
    participant: { identity },
  });
  const token = new AccessToken(
    "test-api-key",
    "test-livekit-secret-at-least-32-bytes",
  );
  token.sha256 = createHash("sha256").update(body).digest("base64");
  return built.app.inject({
    method: "POST",
    url: "/api/v1/internal/livekit/webhook",
    headers: {
      authorization: await token.toJwt(),
      "content-type": "application/webhook+json",
    },
    payload: body,
  });
}

describe("voice identity and lifecycle authorization", () => {
  it("prevents a legacy Worker snapshot from kicking every v2 connection during rollout", async () => {
    const url = "/api/v1/internal/rtc/reconciliation-snapshot";
    expect((await built.app.inject({ method: "GET", url })).statusCode).toBe(
      401,
    );
    const response = await built.app.inject({
      method: "GET",
      url,
      headers: { "x-internal-token": internalToken },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      error: { code: "RTC_SNAPSHOT_OBSOLETE" },
    });
  });
  it("binds voice JWTs to the current lease and exposes stable account mapping", async () => {
    const viewer = await joinViewer();
    const voice = await credential(viewer.sessionToken);
    const identity = tokenIdentity(voice.token);
    expect(parseRtcIdentity(identity)).toEqual({
      memberId: viewer.memberId,
      deviceId: viewer.session.device_id,
      leaseEpoch: now,
    });
    const jwt = decodeJwt(voice.token);
    expect(jwt.video).toMatchObject({
      room: `voice:${roomId}`,
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
    });
    expect(JSON.parse(jwt.metadata as string)).toEqual({
      version: 2,
      roomId,
      memberId: viewer.memberId,
      accountId: viewer.account.id,
    });
    const bootstrap = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/bootstrap`,
      headers: { cookie: `__Host-sw_session=${viewer.sessionToken}` },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      account: { id: viewer.account.id, username: "Viewer", role: "viewer" },
      memberId: viewer.memberId,
    });
    expect(built.roomService.getSnapshot(roomId).members).toContainEqual(
      expect.objectContaining({
        id: viewer.memberId,
        accountId: viewer.account.id,
      }),
    );
    expect(
      built.outboxService.invalidRtcIdentities(roomId, [identity]),
    ).toEqual([]);
    expect((await webhook(identity)).statusCode).toBe(204);
    expect(queuedRtcIdentities()).toEqual([]);
  });

  it("preserves the lease epoch on status reads and 24 hour session rotation", async () => {
    const viewer = await joinViewer();
    const original = tokenIdentity(
      (await credential(viewer.sessionToken)).token,
    );
    now += 20;
    built.roomService.getAccountRoomState(viewer.session);
    expect(tokenIdentity((await credential(viewer.sessionToken)).token)).toBe(
      original,
    );
    now += 24 * 60 * 60 * 1000 + 1;
    const resumed = built.authService.resume(viewer.sessionToken);
    expect(resumed.sessionToken).toBeTruthy();
    built.roomService.getAccountRoomState(resumed.session);
    expect(tokenIdentity((await credential(resumed.sessionToken!)).token)).toBe(
      original,
    );
    expect(
      built.outboxService.invalidRtcIdentities(roomId, [original]),
    ).toEqual([]);
    expect(queuedRtcIdentities()).toEqual([]);
  });

  it("uses monotonic epochs for same-millisecond A to B to A takeover and exact late removals", async () => {
    const a = await joinViewer();
    const aRoomIdentity = built.roomService.authenticate(a.sessionToken);
    const first = tokenIdentity((await credential(a.sessionToken)).token);
    const b = await login();
    expect(built.roomService.enterAccountRoom(b.session).state).toBe(
      "taken-over",
    );
    built.roomService.takeoverAccountRoom(b.session);
    const second = tokenIdentity((await credential(b.sessionToken)).token);
    await expect(
      built.transportService.issueCredential(aRoomIdentity, "voice"),
    ).rejects.toThrow();
    built.roomService.takeoverAccountRoom(a.session);
    const third = tokenIdentity((await credential(a.sessionToken)).token);
    expect(
      [first, second, third].map(
        (value) => parseRtcIdentity(value)?.leaseEpoch,
      ),
    ).toEqual([now, now + 1, now + 2]);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(queuedRtcIdentities()).toEqual([first, second]);
    expect(
      built.outboxService.invalidRtcIdentities(roomId, [first, second, third]),
    ).toEqual([first, second]);
    expect((await webhook(first, "EV_late_old_A")).statusCode).toBe(204);
    expect((await webhook(first, "EV_late_old_A")).statusCode).toBe(204);
    expect(queuedRtcIdentities()).toEqual([first, second, first]);
    expect(queuedRtcIdentities()).not.toContain(third);
  });

  it.each(["Host", "Viewer"])(
    "revokes %s voice on logout while preserving noncredential browser storage",
    async (username) => {
      const joined = username === "Host" ? null : await joinViewer();
      const token = joined?.sessionToken ?? hostToken;
      const identity = tokenIdentity((await credential(token)).token);
      const session = built.authService.authenticate(token);
      const csrfToken = built.authService.rotateCsrf(session);
      const response = await built.app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          cookie: `__Host-sw_session=${token}`,
          origin,
          "x-csrf-token": csrfToken,
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers["clear-site-data"]).toBe('"cache", "cookies"');
      expect(response.headers["set-cookie"]).toContain("__Host-sw_session=");
      expect(queuedRtcIdentities()).toContain(identity);
      expect(
        built.outboxService.invalidRtcIdentities(roomId, [identity]),
      ).toEqual([identity]);
    },
  );

  it("also revokes direct AuthService logout and account password changes", async () => {
    const viewer = await joinViewer();
    const voice = tokenIdentity((await credential(viewer.sessionToken)).token);
    const hostVoice = tokenIdentity((await credential(hostToken)).token);
    built.authService.logout(hostToken);
    await built.authService.manageAccount({
      username: "Viewer",
      password: "replacement-voice-password-24-chars",
    });
    expect(queuedRtcIdentities()).toEqual(
      expect.arrayContaining([voice, hostVoice]),
    );
    expect(
      built.outboxService.invalidRtcIdentities(roomId, [voice, hostVoice]),
    ).toEqual([voice, hostVoice]);
  });

  it.each(["leave", "kick", "close", "disable"])(
    "captures the old identity before %s deletes its lease",
    async (operation) => {
      const viewer = await joinViewer();
      const voice = tokenIdentity(
        (await credential(viewer.sessionToken)).token,
      );
      if (operation === "leave")
        built.roomService.leave(
          built.roomService.authenticate(viewer.sessionToken),
        );
      if (operation === "kick")
        built.roomService.kickMember(
          built.roomService.authenticate(hostToken),
          viewer.memberId,
        );
      if (operation === "close")
        built.roomService.closeByHost(
          built.roomService.authenticate(hostToken),
        );
      if (operation === "disable")
        await built.authService.manageAccount({
          username: "Viewer",
          enabled: false,
        });
      expect(queuedRtcIdentities()).toContain(voice);
      expect(built.outboxService.invalidRtcIdentities(roomId, [voice])).toEqual(
        [voice],
      );
      expect(getRtcLease(built.database, viewer.memberId)).toBeUndefined();
    },
  );

  it("invalidates expired sessions even when the room and member are still active", async () => {
    const viewer = await joinViewer();
    const voice = tokenIdentity((await credential(viewer.sessionToken)).token);
    now += 7 * 24 * 60 * 60 * 1000 + 1;
    expect(
      built.roomService
        .getSnapshot(roomId)
        .members.some((member) => member.id === viewer.memberId),
    ).toBe(true);
    expect(built.outboxService.invalidRtcIdentities(roomId, [voice])).toEqual([
      voice,
    ]);
    expect((await webhook(voice)).statusCode).toBe(204);
    expect(queuedRtcIdentities()).toContain(voice);
  });

  it("validates only the requested live identities behind internal authentication", async () => {
    const viewer = await joinViewer();
    const voice = tokenIdentity((await credential(viewer.sessionToken)).token);
    const old = viewer.memberId;
    const payload = { roomId, identities: [voice, old, "malformed", old] };
    const denied = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/rtc/validate-participants",
      payload,
    });
    expect(denied.statusCode).toBe(401);
    const response = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/rtc/validate-participants",
      headers: { "x-internal-token": internalToken },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ invalidIdentities: [old, "malformed"] });
    expect(built.outboxService.invalidRtcIdentities(uuidv7(), [voice])).toEqual(
      [voice],
    );
    expect(
      parseRtcIdentity(`v2:${viewer.memberId}:${viewer.session.device_id}:01`),
    ).toBeNull();
    expect(
      parseRtcIdentity(
        `v2:${viewer.memberId}:${viewer.session.device_id}:9007199254740992`,
      ),
    ).toBeNull();
    expect(rtcIdentity(getRtcLease(built.database, viewer.memberId)!)).toBe(
      voice,
    );
  });

  it("distinguishes CSRF failure from an invalid session without weakening authentication", async () => {
    const viewer = await joinViewer();
    const request = {
      method: "POST" as const,
      url: `/api/v1/rooms/${roomId}/credentials`,
      headers: {
        cookie: `__Host-sw_session=${viewer.sessionToken}`,
        origin,
        "x-csrf-token": "stale",
      },
      payload: { purpose: "voice" },
    };
    const badCsrf = await built.app.inject(request);
    expect(badCsrf.statusCode).toBe(401);
    expect(badCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });
    const badSession = await built.app.inject({
      ...request,
      headers: { ...request.headers, cookie: "__Host-sw_session=invalid" },
    });
    expect(badSession.statusCode).toBe(401);
    expect(badSession.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("keeps account identifiers stable across different rooms and reprovision revokes old voice", async () => {
    const viewer = await joinViewer();
    const oldVoice = tokenIdentity(
      (await credential(viewer.sessionToken)).token,
    );
    await built.authService.provisionAccounts([
      { username: "Host", role: "host", password },
      { username: "Viewer", role: "viewer", password },
    ]);
    expect(queuedRtcIdentities()).toContain(oldVoice);
    const host = await login("Host");
    roomId = built.roomService.createAccountRoom(host.session).roomId;
    const again = await joinViewer();
    expect(again.account.id).toBe(viewer.account.id);
    expect(again.memberId).not.toBe(viewer.memberId);
    expect(built.roomService.getSnapshot(roomId).members).toContainEqual(
      expect.objectContaining({
        id: again.memberId,
        accountId: viewer.account.id,
      }),
    );
  });
});
