import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type BuiltApp } from "../../apps/api/src/app.js";

const origin = "https://watch.example.test";
const internalToken = "security-internal-token-at-least-32-bytes";
const hostPassword = "host-security-password-24-chars";
const viewerPassword = "viewer-security-password-24";
let built: BuiltApp;
let root: string;
let currentNow: number;

beforeEach(async () => {
  currentNow = 1_750_000_000_000;
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/security-test-"));
  built = await buildApp({
    databasePath: join(root, "security.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    mediaRoot: join(root, "media"),
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    internalHookToken: internalToken,
    now: () => currentNow,
    authFailureDelay: () => Promise.resolve(),
  });
  await built.authService.provisionAccounts([
    { username: "Host", role: "host", password: hostPassword },
    { username: "Simple", role: "viewer", password: viewerPassword },
  ]);
});

afterEach(async () => {
  await built.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("OWASP security regression", () => {
  it("A07 uses strong fixed accounts, generic failures and revocable sessions", async () => {
    await expect(
      built.authService.provisionAccounts([
        { username: "Weak", role: "viewer", password: "short" },
      ]),
    ).rejects.toThrow("20–128");
    await expect(
      built.authService.login("missing", "wrong", "127.0.0.1"),
    ).rejects.toThrow("用户名或密码错误");
    await expect(
      built.authService.login("Host", "wrong", "127.0.0.2"),
    ).rejects.toThrow("用户名或密码错误");

    const login = await built.authService.login(
      "host",
      hostPassword,
      "127.0.0.3",
    );
    const session = built.authService.authenticate(login.sessionToken);
    expect(session.role).toBe("host");
    expect(() => built.authService.requireCsrf(session, "forged")).toThrow(
      "CSRF Token 无效",
    );
    built.authService.requireCsrf(session, login.csrfToken);
    built.authService.logout(login.sessionToken);
    expect(() => built.authService.authenticate(login.sessionToken)).toThrow();
  });

  it("expires after seven idle days and after thirty absolute days", async () => {
    const idle = await built.authService.login(
      "Simple",
      viewerPassword,
      "127.0.0.4",
    );
    currentNow += 7 * 24 * 60 * 60 * 1000 + 1;
    expect(() => built.authService.authenticate(idle.sessionToken)).toThrow();

    currentNow = 1_750_000_000_000;
    const active = await built.authService.login(
      "Simple",
      viewerPassword,
      "127.0.0.5",
    );
    for (let day = 6; day <= 24; day += 6) {
      currentNow = 1_750_000_000_000 + day * 24 * 60 * 60 * 1000;
      built.authService.authenticate(active.sessionToken);
    }
    currentNow = 1_750_000_000_000 + 30 * 24 * 60 * 60 * 1000 + 1;
    expect(() => built.authService.authenticate(active.sessionToken)).toThrow();
  });

  it("rotates the opaque session after twenty-four hours", async () => {
    const login = await built.authService.login(
      "Simple",
      viewerPassword,
      "127.0.0.6",
    );
    currentNow += 24 * 60 * 60 * 1000 + 1;
    const resumed = built.authService.resume(login.sessionToken);
    expect(resumed.sessionToken).toBeTruthy();
    expect(() => built.authService.authenticate(login.sessionToken)).toThrow();
    expect(
      built.authService.authenticate(resumed.sessionToken).account_id,
    ).toBe(login.account.id);
  });

  it("rotates one account password and revokes every existing device", async () => {
    const login = await built.authService.login(
      "Simple",
      viewerPassword,
      "127.0.0.7",
    );
    const nextPassword = "viewer-next-password-24-chars";
    await built.authService.manageAccount({
      username: "Simple",
      password: nextPassword,
    });
    expect(() => built.authService.authenticate(login.sessionToken)).toThrow();
    await expect(
      built.authService.login("Simple", viewerPassword, "127.0.0.8"),
    ).rejects.toThrow("用户名或密码错误");
    await expect(
      built.authService.login("Simple", nextPassword, "127.0.0.9"),
    ).resolves.toMatchObject({ account: { username: "Simple" } });
  });

  it("refreshes a young session without changing its opaque token", async () => {
    const login = await built.authService.login(
      "Simple",
      viewerPassword,
      "127.0.0.10",
    );
    currentNow += 60 * 60 * 1000;
    const resumed = built.authService.resume(login.sessionToken);
    expect(resumed.sessionToken).toBeUndefined();
    expect(resumed.csrfToken).not.toBe(login.csrfToken);
    expect(
      built.authService.authenticate(login.sessionToken).last_seen_at,
    ).toBe(currentNow);
  });

  it("disables and re-enables a fixed account while revoking its devices", async () => {
    const login = await built.authService.login(
      "Simple",
      viewerPassword,
      "127.0.0.11",
    );
    await built.authService.manageAccount({
      username: "Simple",
      enabled: false,
    });
    expect(() => built.authService.authenticate(login.sessionToken)).toThrow();
    await expect(
      built.authService.login("Simple", viewerPassword, "127.0.0.12"),
    ).rejects.toThrow("用户名或密码错误");

    await built.authService.manageAccount({
      username: "Simple",
      enabled: true,
    });
    await expect(
      built.authService.login("Simple", viewerPassword, "127.0.0.13"),
    ).resolves.toMatchObject({ account: { username: "Simple" } });
  });

  it("A04 persists login throttling and ignores forged forwarded IPs", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await built.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin, "x-forwarded-for": `203.0.113.${attempt}` },
        payload: { username: "Host", password: "wrong" },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual(Array(5).fill(401));
    expect(statuses[5]).toBe(429);
    expect(
      (
        built.database
          .prepare("SELECT SUM(attempts) AS attempts FROM auth_rate_limits")
          .get() as { attempts: number }
      ).attempts,
    ).toBeGreaterThanOrEqual(10);
  });

  it("A01/A03 enforces origin, CSRF and host role", async () => {
    const host = await login("Host", hostPassword);
    const crossOrigin = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: {
        cookie: host.cookie,
        origin: "https://evil.example",
        "x-csrf-token": host.csrfToken,
      },
      payload: {},
    });
    expect(crossOrigin.statusCode).toBe(403);
    const missingCsrf = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { cookie: host.cookie, origin },
      payload: {},
    });
    expect(missingCsrf.statusCode).toBe(401);

    const viewer = await login("Simple", viewerPassword);
    const viewerCreate = await built.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: {
        cookie: viewer.cookie,
        origin,
        "x-csrf-token": viewer.csrfToken,
      },
      payload: {},
    });
    expect(viewerCreate.statusCode).toBe(403);
  });

  it("retires legacy auth and emits a password-manager compatible cookie", async () => {
    const legacy = await built.app.inject({
      method: "POST",
      url: "/api/v1/admin/login",
      headers: { origin },
      payload: { code: "000000" },
    });
    expect(legacy.statusCode).toBe(410);
    const response = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin },
      payload: { username: "Host", password: hostPassword },
    });
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("__Host-sw_session=");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("A02/A05/A08/A10 rejects forged media and internal credentials", async () => {
    const noInternalToken = await built.app.inject({
      method: "POST",
      url: "/api/v1/internal/outbox/claim",
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
    expect(forgedMediaToken.statusCode).toBe(401);
    expect(metadataAddress.statusCode).toBe(400);
  });
});

async function login(username: string, password: string) {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: readCookie(response, "__Host-sw_session"),
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
