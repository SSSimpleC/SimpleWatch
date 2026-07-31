import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type BuiltApp } from "../../apps/api/src/app.js";
import { EdgeApiClient } from "../../apps/edge-agent/src/api-client.js";

const fixedNow = 1_750_000_000_000;
let built: BuiltApp;
let root: string;
let origin: string;

beforeEach(async () => {
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(resolve("tmp/edge-client-integration-"));
  built = await buildApp({
    databasePath: join(root, "simplewatch.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: "https://watch.example.test",
    mediaRoot: join(root, "media"),
    uploadRoot: join(root, "uploads"),
    inboxRoot: join(root, "inbox"),
    subtitleRoot: join(root, "subtitles"),
    trashRoot: join(root, "trash"),
    tusEndpoint: "https://watch.example.test/files/",
    internalHookToken: "test-internal-service-token-32-bytes",
    contentSigningSecret: "test-content-signing-secret-32-bytes",
    now: () => fixedNow,
    authFailureDelay: () => Promise.resolve(),
  });
  await built.authService.bootstrapAdmin(
    "Host",
    "host-test-password-24-characters",
  );
  origin = await built.app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await built.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("real Edge Agent client to Fastify control plane", () => {
  it("heartbeats, commits a catalog, leases a task and is fenced after revoke", async () => {
    const enrollment = built.edgeAuthService.enroll({
      displayName: "SimpleServer",
      softwareVersion: "0.1.0",
    });
    const client = new EdgeApiClient(origin, enrollment.token, fetch, true);

    await client.heartbeat();
    const scanId = await client.beginCatalogScan(1);
    await client.putCatalogPage({
      scanId,
      generation: 1,
      pageIndex: 0,
      entries: [
        {
          localId: "opaque-episode-id",
          relativePath: "Series/Episode 01.mp4",
          displayName: "Episode 01.mp4",
          bytes: 4,
          mtimeMs: fixedNow - 1000,
        },
      ],
    });
    await client.commitCatalogScan(scanId, 1, 1);
    const catalog = built.edgeCatalogService.listCatalog(
      enrollment.agentId,
      20,
    );
    expect(catalog.items).toHaveLength(1);

    const host = built.database
      .prepare("SELECT id FROM accounts WHERE username_folded = 'host'")
      .get() as { readonly id: string };
    const queue = built.programService.getOrCreateActiveQueue(host.id);
    built.programService.addItems(host.id, queue.revision, [
      catalog.items[0]!.versionId,
    ]);
    const task = await client.claimJob(1);
    expect(task).toMatchObject({ payload: { kind: "upload" }, attempts: 1 });
    const heartbeat = await client.heartbeatJob(task!.id, task!.leaseToken, {
      offset: 0,
      totalBytes: 4,
    });
    expect(heartbeat?.cancelRequested).toBe(false);

    built.edgeAuthService.revoke(enrollment.agentId);
    await expect(client.heartbeat()).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });
  });
});
