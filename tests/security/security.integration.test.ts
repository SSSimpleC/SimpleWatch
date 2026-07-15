import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type BuiltApp } from "../../apps/api/src/app.js";

const origin = "https://watch.example.test";
const internalToken = "security-internal-token-at-least-32-bytes";
const friendInviteToken = "security-friend-invite-token-at-least-32-bytes";
let built: BuiltApp;
let root: string;

beforeEach(async () => {
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/security-test-"));
  built = await buildApp({
    databasePath: join(root, "security.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    friendInviteToken,
    mediaRoot: join(root, "media"),
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    internalHookToken: internalToken,
    now: () => 1_750_000_000_000,
  });
  await built.authService.bootstrapAdmin("admin", "260713");
});

afterEach(async () => {
  await built.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("OWASP security regression", () => {
  it("A07 validates credentials, sessions and CSRF fail-closed", async () => {
    await expect(
      built.authService.bootstrapAdmin("", "123456"),
    ).rejects.toThrow("用户名长度");
    await expect(
      built.authService.bootstrapAdmin("other", "short"),
    ).rejects.toThrow("6 位数字");
    await expect(
      built.authService.bootstrapAdmin("other", "123456"),
    ).rejects.toThrow("已经初始化");
    await expect(built.authService.login("000000")).rejects.toThrow(
      "放映口令错误",
    );
    expect(() => built.authService.authenticate(undefined)).toThrow();
    expect(() => built.authService.authenticate("forged-session")).toThrow();

    const login = await built.authService.login("260713");
    const session = built.authService.authenticate(login.sessionToken);
    expect(() => built.authService.requireCsrf(session, undefined)).toThrow(
      "CSRF Token 无效",
    );
    expect(() => built.authService.requireCsrf(session, "forged-csrf")).toThrow(
      "CSRF Token 无效",
    );
    built.authService.requireCsrf(session, login.csrfToken);
    built.authService.logout(login.sessionToken);
    expect(() => built.authService.authenticate(login.sessionToken)).toThrow();
  });

  it("A04 rate-limits public authentication without trusting forwarded IPs", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await built.app.inject({
        method: "POST",
        url: "/api/v1/admin/login",
        headers: { origin, "x-forwarded-for": `203.0.113.${attempt}` },
        payload: { code: "000000" },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual(Array(5).fill(401));
    expect(statuses[5]).toBe(429);
  });

  it("A01/A03 rejects cross-origin, missing CSRF, IDOR and path traversal", async () => {
    const admin = await loginAdmin();
    const crossOrigin = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: {
        cookie: admin.cookie,
        origin: "https://evil.example",
        "x-csrf-token": admin.csrfToken,
      },
      payload: roomPayload,
    });
    expect(crossOrigin.statusCode).toBe(403);
    const missingCsrf = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { cookie: admin.cookie, origin },
      payload: roomPayload,
    });
    expect(missingCsrf.statusCode).toBe(401);

    const created = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: {
        cookie: admin.cookie,
        origin,
        "x-csrf-token": admin.csrfToken,
      },
      payload: roomPayload,
    });
    const room = created.json<{
      room: { id: string };
      member: { id: string };
      csrfToken: string;
    }>();
    const hostCookie = readCookie(created, "sw_room");
    const joined = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms/active/join",
      headers: { origin },
      payload: { nickname: "Member", inviteToken: friendInviteToken },
    });
    const member = joined.json<{ member: { id: string }; csrfToken: string }>();
    const memberCookie = readCookie(joined, "sw_room");
    const memberKick = await built.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.room.id}/members/${room.member.id}/kick`,
      headers: {
        cookie: memberCookie,
        origin,
        "x-csrf-token": member.csrfToken,
      },
      payload: { reason: "idor" },
    });
    expect(memberKick.statusCode).toBe(403);
    const selfKick = await built.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.room.id}/members/${room.member.id}/kick`,
      headers: {
        cookie: hostCookie,
        origin,
        "x-csrf-token": room.csrfToken,
      },
      payload: { reason: "self" },
    });
    expect(selfKick.statusCode).toBe(409);

    const traversal = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/imports/sftp",
      headers: { "x-internal-token": internalToken },
      payload: {
        filename: "movie.mp4",
        filePath: join(root, "inbox", "..", "secret.mp4"),
        bytes: 1,
      },
    });
    expect(traversal.statusCode).toBe(400);
  });

  it("A02/A05/A08/A10 rejects forged tokens and internal access", async () => {
    const noInternalToken = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/outbox/claim",
      payload: { workerId: "attacker" },
    });
    const wrongInternalToken = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/outbox/claim",
      headers: { "x-internal-token": "wrong" },
      payload: { workerId: "attacker" },
    });
    const forgedMediaToken = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/mediamtx/auth",
      payload: { token: "forged", action: "read", path: "program" },
    });
    const metadataAddress = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/imports/sftp",
      headers: { "x-internal-token": internalToken },
      payload: {
        filename: "metadata.mp4",
        filePath: "http://169.254.169.254/latest/meta-data",
        bytes: 1,
      },
    });

    expect(noInternalToken.statusCode).toBe(401);
    expect(wrongInternalToken.statusCode).toBe(401);
    expect(forgedMediaToken.statusCode).toBe(401);
    expect(metadataAddress.statusCode).toBe(400);
    for (const response of [
      noInternalToken,
      wrongInternalToken,
      forgedMediaToken,
      metadataAddress,
    ]) {
      expect(response.body).not.toMatch(/password_hash|SELECT |stack|sqlite/i);
    }
  });
});

const roomPayload = {
  hostNickname: "Host",
};

async function loginAdmin(): Promise<{ cookie: string; csrfToken: string }> {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/v1/admin/login",
    headers: { origin },
    payload: { code: "260713" },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: readCookie(response, "sw_admin"),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
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
