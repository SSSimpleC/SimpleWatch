import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "../src/app.js";

let root: string;
let built: BuiltApp;
beforeEach(async () => {
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(join(resolve("tmp"), "player-static-"));
  const webRoot = join(root, "web");
  mkdirSync(webRoot);
  writeFileSync(
    join(webRoot, "index.html"),
    "<!doctype html><title>player</title>",
  );
  writeFileSync(join(webRoot, "sw.js"), "// no offline shell");
  writeFileSync(
    join(webRoot, "player-version.json"),
    JSON.stringify({ schemaVersion: 1, buildId: "a".repeat(64) }),
  );
  built = await buildApp({
    databasePath: join(root, "state.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: "https://static.example.test",
    webRoot,
    mediaRoot: join(root, "media"),
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    trashRoot: join(root, "trash"),
  });
});
afterEach(async () => {
  await built.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("player entry and build cache boundaries", () => {
  it.each([
    "/",
    "/index.html",
    "/room/example",
    "/sw.js",
    "/player-version.json",
  ])("marks %s no-store", async (url) => {
    const response = await built.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("keeps media authorization in place", async () => {
    const response = await built.app.inject({
      method: "GET",
      url: "/api/v1/media/019fbbb0-1e60-73b8-8a30-1f027aedbe39/content",
    });
    expect(response.statusCode).toBe(401);
  });
});
