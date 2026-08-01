import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  EdgeAgent,
  type AgentLogger,
  type EdgeControlPlane,
  type EdgeTusUploader,
} from "../src/agent.js";
import type { EdgeAgentConfig } from "../src/config.js";
import { AgentState } from "../src/state.js";
import { scanLibrary } from "../src/catalog.js";
import { EdgeApiError } from "../src/api-client.js";

const logger: AgentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("Edge Agent 编排", () => {
  it("等待异步 tus 完成钩子确认后再提交上传任务", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-agent-upload-"));
    const stateRoot = await mkdtemp(
      join(tmpdir(), "simplewatch-agent-upload-state-"),
    );
    const contents = "complete-video";
    await writeFile(join(root, "Episode 01.mkv"), contents);
    const entry = (await scanLibrary(root)).entries[0];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("测试媒体未被扫描到");
    using state = new AgentState(join(stateRoot, "agent.sqlite3"));
    state.replaceCatalog(1, [entry]);
    const expectedSha256 = createHash("sha256").update(contents).digest("hex");
    const completeJob = vi
      .fn<EdgeControlPlane["completeJob"]>()
      .mockRejectedValueOnce(
        new EdgeApiError(
          "云端尚未完整接收该上传",
          409,
          false,
          "EDGE_UPLOAD_NOT_RECEIVED",
        ),
      )
      .mockResolvedValue(undefined);
    const api = createControlPlane({
      requestUpload: vi.fn(() =>
        Promise.resolve({
          edgeTransferId: "019fbba2-e1e0-7748-8103-b7aa6751c08d",
          uploadId: "019fbba3-b437-7339-90bb-dfe74756e2b3",
          tusUrl:
            "https://example.test/files/019fbba3-b437-7339-90bb-dfe74756e2b3",
          token: "x".repeat(32),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshAfter: new Date(Date.now() + 30_000).toISOString(),
          chunkBytes: 16,
        }),
      ),
      completeJob,
    });
    const upload = vi.fn<EdgeTusUploader["upload"]>((options) => {
      options.onProgress?.({ offset: entry.bytes, totalBytes: entry.bytes });
      return Promise.resolve({
        offset: entry.bytes,
        totalBytes: entry.bytes,
        mtimeMs: entry.mtimeMs,
        sha256: expectedSha256,
      });
    });
    const agent = new EdgeAgent(
      createConfig(root, join(stateRoot, "agent.sqlite3")),
      state,
      api,
      { upload },
      logger,
    );
    const task = {
      id: "019fbba2-e1e0-7748-8103-b7aa6751c08d",
      leaseToken: "y".repeat(32),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempts: 1,
      maxAttempts: 3,
      payload: {
        kind: "upload" as const,
        edgeTransferId: "019fbba2-e1e0-7748-8103-b7aa6751c08d",
        catalogItemId: "019fbba2-e1e1-7521-96a1-99b913deaaa1",
        catalogVersionId: "019fbba2-e1e2-76bd-b35d-34430d4fbeef",
        localId: entry.localId,
        expectedBytes: entry.bytes,
        expectedMtimeMs: entry.mtimeMs,
        expectedSha256,
      },
    };

    await agent.processTask(task);

    expect(completeJob).toHaveBeenCalledTimes(2);
    expect(api.failJob).not.toHaveBeenCalled();
    expect(state.getUpload(task.id)).toBeUndefined();
  });

  it("第一次发现的新文件不提交云端，第二次size+mtime相同时才原子发布", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-agent-library-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "simplewatch-agent-state-"));
    await mkdir(join(root, "Series"));
    await writeFile(join(root, "Series", "Episode 01.mkv"), "complete-video");
    using state = new AgentState(join(stateRoot, "agent.sqlite3"));
    const beginCatalogScan = vi.fn<EdgeControlPlane["beginCatalogScan"]>(() =>
      Promise.resolve("scan-id"),
    );
    const putCatalogPage = vi.fn<EdgeControlPlane["putCatalogPage"]>(() =>
      Promise.resolve(),
    );
    const commitCatalogScan = vi.fn<EdgeControlPlane["commitCatalogScan"]>(() =>
      Promise.resolve(),
    );
    const api = createControlPlane({
      beginCatalogScan,
      putCatalogPage,
      commitCatalogScan,
    });
    const agent = new EdgeAgent(
      createConfig(root, join(stateRoot, "agent.sqlite3")),
      state,
      api,
      { upload: vi.fn() } as unknown as EdgeTusUploader,
      logger,
      () => 100,
    );

    await expect(agent.synchronizeCatalog()).resolves.toBe(0);
    expect(beginCatalogScan).not.toHaveBeenCalled();

    await expect(agent.synchronizeCatalog()).resolves.toBe(1);
    expect(beginCatalogScan).toHaveBeenCalledWith(101, undefined);
    expect(putCatalogPage).toHaveBeenCalledOnce();
    const page = putCatalogPage.mock.calls[0]?.[0];
    expect(page?.entries).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("revision");
    expect(commitCatalogScan).toHaveBeenCalledWith(
      "scan-id",
      101,
      1,
      undefined,
    );
    expect(state.listCatalog()).toHaveLength(1);
  });

  it("目录突然清空时必须连续两次得到同一快照才发布缺失状态", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "simplewatch-agent-empty-library-"),
    );
    const stateRoot = await mkdtemp(
      join(tmpdir(), "simplewatch-agent-empty-state-"),
    );
    using state = new AgentState(join(stateRoot, "agent.sqlite3"));
    state.replaceCatalog(1, [
      {
        localId: "existing-media",
        relativePath: "Series/Episode 01.mkv",
        displayName: "Episode 01.mkv",
        bytes: 1024,
        mtimeMs: 100,
        revision: "existing-revision",
      },
    ]);
    const beginCatalogScan = vi.fn<EdgeControlPlane["beginCatalogScan"]>(() =>
      Promise.resolve("empty-scan-id"),
    );
    const putCatalogPage = vi.fn<EdgeControlPlane["putCatalogPage"]>(() =>
      Promise.resolve(),
    );
    const commitCatalogScan = vi.fn<EdgeControlPlane["commitCatalogScan"]>(() =>
      Promise.resolve(),
    );
    const agent = new EdgeAgent(
      createConfig(root, join(stateRoot, "agent.sqlite3")),
      state,
      createControlPlane({
        beginCatalogScan,
        putCatalogPage,
        commitCatalogScan,
      }),
      { upload: vi.fn() } as unknown as EdgeTusUploader,
      logger,
      () => 200,
    );

    await expect(agent.synchronizeCatalog()).resolves.toBe(0);
    expect(beginCatalogScan).not.toHaveBeenCalled();
    expect(state.listCatalog()).toHaveLength(1);

    await expect(agent.synchronizeCatalog()).resolves.toBe(0);
    expect(beginCatalogScan).toHaveBeenCalledOnce();
    expect(putCatalogPage).toHaveBeenCalledOnce();
    expect(commitCatalogScan).toHaveBeenCalledWith(
      "empty-scan-id",
      201,
      1,
      undefined,
    );
    expect(state.listCatalog()).toHaveLength(0);
  });

  it("本地状态丢失时先完成两次稳定观察和catalog commit再领取云端任务", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-agent-cold-start-"));
    const stateRoot = await mkdtemp(
      join(tmpdir(), "simplewatch-agent-cold-state-"),
    );
    await writeFile(join(root, "Episode 01.mkv"), "complete-video");
    using state = new AgentState(join(stateRoot, "agent.sqlite3"));
    const events: string[] = [];
    const info = vi.fn<AgentLogger["info"]>();
    const controller = new AbortController();
    const api = createControlPlane({
      beginCatalogScan: vi.fn(() => {
        events.push("begin");
        return Promise.resolve("cold-scan-id");
      }),
      putCatalogPage: vi.fn(() => {
        events.push("page");
        return Promise.resolve();
      }),
      commitCatalogScan: vi.fn(() => {
        events.push("commit");
        return Promise.resolve();
      }),
      claimJob: vi.fn(() => {
        events.push("claim");
        controller.abort(new DOMException("测试完成", "AbortError"));
        return Promise.resolve(undefined);
      }),
    });
    const agent = new EdgeAgent(
      {
        ...createConfig(root, join(stateRoot, "agent.sqlite3")),
        stabilityObservationMs: 1,
      },
      state,
      api,
      { upload: vi.fn() } as unknown as EdgeTusUploader,
      { ...logger, info },
      () => 300,
    );

    await agent.run(controller.signal);

    expect(events).toContain("commit");
    expect(events).toContain("claim");
    expect(events.indexOf("claim")).toBeGreaterThan(events.indexOf("commit"));
    expect(state.getMeta("catalog_generation")).toBeDefined();
    expect(info).toHaveBeenCalledWith("Agent 已连接控制面");
    expect(info).toHaveBeenCalledWith("家庭媒体目录已同步", {
      discovered: 1,
      stable: 1,
      pages: 1,
    });
  });
});

function createConfig(libraryRoot: string, statePath: string): EdgeAgentConfig {
  return {
    apiOrigin: "https://example.test/",
    agentToken: "machine-token-machine-token-machine-token",
    libraryRoot,
    statePath,
    scanIntervalMs: 300_000,
    stabilityObservationMs: 120_000,
    claimWaitSeconds: 25,
    heartbeatIntervalMs: 30_000,
    uploadChunkBytes: 16 * 1024 * 1024,
  };
}

function createControlPlane(
  overrides: Partial<EdgeControlPlane>,
): EdgeControlPlane {
  return {
    heartbeat: vi.fn(() => Promise.resolve()),
    beginCatalogScan: vi.fn(() => Promise.resolve("scan-id")),
    putCatalogPage: vi.fn(() => Promise.resolve()),
    commitCatalogScan: vi.fn(() => Promise.resolve()),
    claimJob: vi.fn(() => Promise.resolve(undefined)),
    heartbeatJob: vi.fn(() => Promise.resolve(undefined)),
    requestUpload: vi.fn(() => Promise.reject(new Error("not used"))),
    refreshUploadCredential: vi.fn(() => Promise.reject(new Error("not used"))),
    completeJob: vi.fn(() => Promise.resolve()),
    failJob: vi.fn(() => Promise.resolve()),
    cancelledJob: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}
