import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { scanLibrary } from "../src/catalog.js";
import {
  TUS_PATCH_TIMEOUT_MILLISECONDS,
  TusUploadClient,
} from "../src/tus-client.js";
import type { TusCredential } from "../src/types.js";

describe("tus 断点续传", () => {
  it("凭据返回集合端点时先用固定uploadId创建资源再PATCH", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-tus-create-"));
    await writeFile(join(root, "Episode.mp4"), "video");
    const entry = (await scanLibrary(root)).entries[0]!;
    const requests: Array<{ readonly method: string; readonly url: string }> =
      [];
    const fetchImpl = vi.fn(
      (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const url =
          input instanceof URL
            ? input.toString()
            : typeof input === "string"
              ? input
              : input.url;
        const method = init?.method ?? "GET";
        requests.push({ method, url });
        if (method === "HEAD")
          return Promise.resolve(new Response(null, { status: 404 }));
        if (method === "POST") {
          expect(new Headers(init?.headers).get("Upload-Length")).toBe("5");
          expect(new Headers(init?.headers).get("Upload-Metadata")).toContain(
            "filename",
          );
          return Promise.resolve(
            new Response(null, {
              status: 201,
              headers: { Location: "/files/upload-id" },
            }),
          );
        }
        return Promise.resolve(
          new Response(null, {
            status: 204,
            headers: { "Upload-Offset": "5" },
          }),
        );
      },
    ) as unknown as typeof fetch;
    const credential: TusCredential = {
      edgeTransferId: "transfer-id",
      uploadId: "upload-id",
      tusUrl: "https://example.test/files/",
      token: "token-token-token-token-token-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshAfter: "2030-01-01T00:00:00.000Z",
      chunkBytes: 16,
    };

    const result = await new TusUploadClient(fetchImpl, 16, () =>
      Date.parse("2026-01-01"),
    ).upload({
      libraryRoot: root,
      entry,
      credential,
      refreshCredential: () => Promise.resolve(credential),
    });

    expect(requests).toEqual([
      { method: "HEAD", url: "https://example.test/files/upload-id" },
      { method: "POST", url: "https://example.test/files/" },
      { method: "PATCH", url: "https://example.test/files/upload-id" },
    ]);
    expect(result.offset).toBe(5);
  });

  it("从HEAD offset继续、刷新凭据并对完整本地文件计算SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-tus-"));
    await mkdir(join(root, "Series"));
    await writeFile(join(root, "Series", "Episode.mkv"), "abcdefgh");
    const entry = (await scanLibrary(root)).entries[0];
    expect(entry).toBeDefined();
    const bodies: string[] = [];
    const tokens: string[] = [];
    const fetchImpl = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get("Upload-Token") ?? "");
      if (init?.method === "HEAD") {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "Upload-Offset": "4" },
          }),
        );
      }
      const body = Buffer.from((init?.body as Uint8Array | undefined) ?? []);
      bodies.push(body.toString("utf8"));
      return Promise.resolve(
        new Response(null, {
          status: 204,
          headers: { "Upload-Offset": "8" },
        }),
      );
    }) as unknown as typeof fetch;
    const stale: TusCredential = {
      edgeTransferId: "transfer-id",
      uploadId: "upload-id",
      tusUrl: "https://example.test/files/upload-id",
      token: "stale-token-stale-token-stale-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshAfter: "2020-01-01T00:00:00.000Z",
      chunkBytes: 4,
    };
    const fresh: TusCredential = {
      ...stale,
      token: "fresh-token-fresh-token-fresh-token",
      refreshAfter: "2030-01-01T00:00:00.000Z",
    };
    const refresh = vi.fn(() => Promise.resolve(fresh));
    const progress = vi.fn();
    const client = new TusUploadClient(fetchImpl, 4, () =>
      Date.parse("2026-01-01"),
    );

    const result = await client.upload({
      libraryRoot: root,
      entry: entry!,
      credential: stale,
      refreshCredential: refresh,
      onProgress: progress,
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(tokens).toEqual([fresh.token, fresh.token]);
    expect(bodies).toEqual(["efgh"]);
    expect(progress).toHaveBeenLastCalledWith({ offset: 8, totalBytes: 8 });
    expect(result).toMatchObject({
      offset: 8,
      totalBytes: 8,
      sha256:
        "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab",
    });
  });

  it("最终PATCH响应丢失后用新凭据HEAD确认完整offset且不重复PATCH", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-tus-finish-lost-"));
    await writeFile(join(root, "Episode.mp4"), "video");
    const entry = (await scanLibrary(root)).entries[0]!;
    const stale: TusCredential = {
      edgeTransferId: "transfer-id",
      uploadId: "upload-id",
      tusUrl: "https://example.test/files/upload-id",
      token: "stale-token-stale-token-stale-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshAfter: "2030-01-01T00:00:00.000Z",
      chunkBytes: 4,
    };
    const fresh: TusCredential = {
      ...stale,
      token: "fresh-token-fresh-token-fresh-token",
    };
    const requests: Array<{ readonly method: string; readonly token: string }> =
      [];
    const fetchImpl = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const token = new Headers(init?.headers).get("Upload-Token") ?? "";
      requests.push({ method, token });
      if (method !== "HEAD") {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      if (token === stale.token) {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { "Upload-Offset": "5" },
        }),
      );
    }) as unknown as typeof fetch;
    const refresh = vi.fn(() => Promise.resolve(fresh));

    const result = await new TusUploadClient(fetchImpl, 4, () =>
      Date.parse("2026-01-01"),
    ).upload({
      libraryRoot: root,
      entry,
      credential: stale,
      refreshCredential: refresh,
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(requests).toEqual([
      { method: "HEAD", token: stale.token },
      { method: "HEAD", token: fresh.token },
    ]);
    expect(result).toMatchObject({
      offset: 5,
      totalBytes: 5,
      sha256:
        "0cab1c9617404faf2b24e221e189ca5945813e14d3f766345b09ca13bbe28ffc",
    });
  });

  it("拒绝刷新后改变upload URL或upload ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-tus-"));
    await writeFile(join(root, "Episode.mp4"), "video");
    const entry = (await scanLibrary(root)).entries[0]!;
    const credential: TusCredential = {
      edgeTransferId: "transfer-id",
      uploadId: "upload-id",
      tusUrl: "https://example.test/files/upload-id",
      token: "token-token-token-token-token-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshAfter: "2020-01-01T00:00:00.000Z",
      chunkBytes: 4,
    };
    const client = new TusUploadClient(fetch, 4, () =>
      Date.parse("2026-01-01"),
    );

    await expect(
      client.upload({
        libraryRoot: root,
        entry,
        credential,
        refreshCredential: () =>
          Promise.resolve({
            ...credential,
            uploadId: "different",
            tusUrl: "https://example.test/files/different",
          }),
      }),
    ).rejects.toThrow("改变了 tus upload URL");
  });

  it("单个PATCH在300秒没有响应时中止且保留可重试语义", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-tus-timeout-"));
    await writeFile(join(root, "Episode.mp4"), "video");
    const entry = (await scanLibrary(root)).entries[0]!;
    const credential: TusCredential = {
      edgeTransferId: "transfer-id",
      uploadId: "upload-id",
      tusUrl: "https://example.test/files/upload-id",
      token: "token-token-token-token-token-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshAfter: "2030-01-01T00:00:00.000Z",
      chunkBytes: 16,
    };
    vi.useFakeTimers();
    try {
      let patchSignal: AbortSignal | undefined;
      let markPatchStarted: (() => void) | undefined;
      const patchStarted = new Promise<void>((resolve) => {
        markPatchStarted = resolve;
      });
      const fetchImpl = vi.fn(
        (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
          if (init?.method === "HEAD") {
            return Promise.resolve(
              new Response(null, {
                status: 200,
                headers: { "Upload-Offset": "0" },
              }),
            );
          }
          patchSignal = init?.signal ?? undefined;
          markPatchStarted?.();
          return rejectWhenAborted(patchSignal);
        },
      ) as unknown as typeof fetch;
      const upload = new TusUploadClient(fetchImpl, 16, () =>
        Date.parse("2026-01-01"),
      ).upload({
        libraryRoot: root,
        entry,
        credential,
        refreshCredential: () => Promise.resolve(credential),
      });
      const observed = upload.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await patchStarted;
      expect(patchSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(TUS_PATCH_TIMEOUT_MILLISECONDS - 1);
      expect(patchSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(observed).resolves.toMatchObject({
        error: { retryable: true, status: 408 },
      });
      expect(patchSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function rejectWhenAborted(signal?: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    signal?.addEventListener("abort", () => reject(abortReason(signal)), {
      once: true,
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("操作已中止", "AbortError");
}
