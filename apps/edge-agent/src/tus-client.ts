import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { inspectCatalogFile } from "./catalog.js";
import type {
  CatalogEntry,
  TusCredential,
  UploadProgress,
  UploadResult,
} from "./types.js";

const TUS_VERSION = "1.0.0";
export const TUS_PATCH_TIMEOUT_MILLISECONDS = 300_000;

export interface TusUploadOptions {
  readonly libraryRoot: string;
  readonly entry: CatalogEntry;
  readonly credential: TusCredential;
  readonly refreshCredential: (
    current: TusCredential,
    signal?: AbortSignal,
  ) => Promise<TusCredential>;
  readonly onCredential?: (credential: TusCredential) => void;
  readonly onProgress?: (progress: UploadProgress) => void;
  readonly signal?: AbortSignal;
}

export class TusUploadError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TusUploadError";
  }
}

export class TusUploadClient {
  readonly #fetch: typeof fetch;
  readonly #maximumChunkBytes: number;
  readonly #now: () => number;

  public constructor(
    fetchImpl: typeof fetch = fetch,
    maximumChunkBytes = 16 * 1024 * 1024,
    now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes <= 0) {
      throw new Error("tus 分块大小无效");
    }
    this.#fetch = fetchImpl;
    this.#maximumChunkBytes = maximumChunkBytes;
    this.#now = now;
  }

  public async upload(options: TusUploadOptions): Promise<UploadResult> {
    let credential = await this.#freshCredential(
      normalizeCredential(options.credential),
      options.refreshCredential,
      options.signal,
    );
    const prepared = await this.#prepareResource(
      credential,
      options.entry,
      options.refreshCredential,
      options.signal,
    );
    credential = prepared.credential;
    options.onCredential?.(credential);
    let offset = prepared.offset;
    if (offset > options.entry.bytes) {
      throw new TusUploadError("服务端 tus offset 超过本地文件大小", false);
    }

    const before = await inspectCatalogFile(
      options.libraryRoot,
      options.entry.relativePath,
    );
    if (before.revision !== options.entry.revision) {
      throw new TusUploadError("媒体源在任务领取后发生变化", false);
    }

    const filePath = resolve(options.libraryRoot, options.entry.relativePath);
    const handle = await open(filePath, "r");
    const hash = createHash("sha256");
    const chunkBytes = Math.min(
      this.#maximumChunkBytes,
      requireChunkBytes(credential.chunkBytes),
    );
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let position = 0;
    try {
      while (position < options.entry.bytes) {
        throwIfAborted(options.signal);
        const length = Math.min(
          buffer.byteLength,
          options.entry.bytes - position,
        );
        const result = await handle.read(buffer, 0, length, position);
        if (result.bytesRead === 0) {
          throw new TusUploadError("读取媒体源时意外到达文件末尾", false);
        }
        const chunk = buffer.subarray(0, result.bytesRead);
        hash.update(chunk);
        const chunkEnd = position + result.bytesRead;
        if (chunkEnd > offset) {
          const uploadStart = Math.max(0, offset - position);
          const uploadBytes = chunk.subarray(uploadStart);
          credential = await this.#freshCredential(
            credential,
            options.refreshCredential,
            options.signal,
          );
          options.onCredential?.(credential);
          offset = await this.#patchWithRefresh(
            credential,
            offset,
            uploadBytes,
            options.refreshCredential,
            (refreshed) => {
              credential = refreshed;
              options.onCredential?.(refreshed);
            },
            options.signal,
          );
          options.onProgress?.({ offset, totalBytes: options.entry.bytes });
        }
        position = chunkEnd;
      }
    } finally {
      await handle.close();
    }

    if (offset !== options.entry.bytes) {
      throw new TusUploadError("tus 上传没有到达预期文件大小", true);
    }
    const after = await inspectCatalogFile(
      options.libraryRoot,
      options.entry.relativePath,
    );
    if (after.revision !== options.entry.revision) {
      throw new TusUploadError("媒体源在上传过程中发生变化", false);
    }
    return {
      offset,
      totalBytes: options.entry.bytes,
      sha256: hash.digest("hex"),
      mtimeMs: options.entry.mtimeMs,
    };
  }

  async #prepareResource(
    credential: TusCredential,
    entry: CatalogEntry,
    refreshCredential: TusUploadOptions["refreshCredential"],
    signal?: AbortSignal,
  ): Promise<{ readonly credential: TusCredential; readonly offset: number }> {
    try {
      return { credential, offset: await this.#head(credential, signal) };
    } catch (error) {
      if (!(error instanceof TusUploadError)) throw error;
      if (error.status === 401 || error.status === 403) {
        const refreshed = normalizeCredential(
          await refreshCredential(credential, signal),
        );
        assertSameUpload(credential, refreshed);
        try {
          return {
            credential: refreshed,
            offset: await this.#head(refreshed, signal),
          };
        } catch (retryError) {
          if (
            retryError instanceof TusUploadError &&
            retryError.status === 404
          ) {
            await this.#create(refreshed, entry, signal);
            return { credential: refreshed, offset: 0 };
          }
          throw retryError;
        }
      }
      if (error.status !== 404) throw error;
      await this.#create(credential, entry, signal);
      return { credential, offset: 0 };
    }
  }

  async #head(
    credential: TusCredential,
    signal?: AbortSignal,
  ): Promise<number> {
    const response = await this.#fetch(credential.tusUrl, {
      method: "HEAD",
      headers: tusHeaders(credential),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new TusUploadError(
        `tus HEAD 失败：HTTP ${response.status}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }
    return parseOffset(response);
  }

  async #create(
    credential: TusCredential,
    entry: CatalogEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    const endpoint = tusEndpoint(credential);
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: {
        ...tusHeaders(credential),
        "Upload-Length": String(entry.bytes),
        "Upload-Metadata": [
          `filename ${Buffer.from(entry.displayName, "utf8").toString("base64")}`,
          `filetype ${Buffer.from("application/octet-stream").toString("base64")}`,
        ].join(","),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status !== 201) {
      throw new TusUploadError(
        `tus POST 失败：HTTP ${response.status}`,
        isRetryableStatus(response.status) || response.status === 409,
        response.status,
      );
    }
    const location = response.headers.get("Location");
    if (!location) throw new TusUploadError("tus POST 缺少 Location", false);
    const created = normalizeUrl(new URL(location, endpoint));
    if (created !== normalizeUrl(new URL(credential.tusUrl))) {
      throw new TusUploadError("tus POST 创建了非预期 upload ID", false);
    }
  }

  async #patchWithRefresh(
    credential: TusCredential,
    offset: number,
    body: Uint8Array,
    refreshCredential: TusUploadOptions["refreshCredential"],
    onRefresh: (credential: TusCredential) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    let response = await this.#patch(credential, offset, body, signal);
    if (response.status === 401 || response.status === 403) {
      const refreshed = normalizeCredential(
        await refreshCredential(credential, signal),
      );
      assertSameUpload(credential, refreshed);
      onRefresh(refreshed);
      response = await this.#patch(refreshed, offset, body, signal);
    }
    if (!response.ok) {
      throw new TusUploadError(
        `tus PATCH 失败：HTTP ${response.status}`,
        isRetryableStatus(response.status) ||
          response.status === 409 ||
          response.status === 423,
        response.status,
      );
    }
    const nextOffset = parseOffset(response);
    if (nextOffset !== offset + body.byteLength) {
      throw new TusUploadError("tus PATCH 返回了不一致的 offset", false);
    }
    return nextOffset;
  }

  async #patch(
    credential: TusCredential,
    offset: number,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Response> {
    const deadline = patchDeadlineSignal(signal);
    try {
      return await this.#fetch(credential.tusUrl, {
        method: "PATCH",
        headers: {
          ...tusHeaders(credential),
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": String(offset),
        },
        body: body as BodyInit,
        signal: deadline.signal,
      });
    } catch (error) {
      if (deadline.didTimeout() && !signal?.aborted) {
        throw new TusUploadError("单个 tus PATCH 超过五分钟", true, 408);
      }
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  async #freshCredential(
    current: TusCredential,
    refreshCredential: TusUploadOptions["refreshCredential"],
    signal?: AbortSignal,
  ): Promise<TusCredential> {
    const refreshAfter = Date.parse(current.refreshAfter);
    if (!Number.isFinite(refreshAfter)) {
      throw new TusUploadError("tus 凭据 refreshAfter 无效", false);
    }
    if (this.#now() < refreshAfter) return normalizeCredential(current);
    const refreshed = normalizeCredential(
      await refreshCredential(current, signal),
    );
    assertSameUpload(current, refreshed);
    return refreshed;
  }
}

function normalizeCredential(credential: TusCredential): TusCredential {
  const url = new URL(credential.tusUrl);
  const suffix = `/${encodeURIComponent(credential.uploadId)}`;
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(suffix)) url.pathname = `${path}${suffix}`;
  return { ...credential, tusUrl: url.toString() };
}

function tusEndpoint(credential: TusCredential): URL {
  const url = new URL(credential.tusUrl);
  const suffix = `/${encodeURIComponent(credential.uploadId)}`;
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(suffix)) {
    throw new TusUploadError("tus URL 与 upload ID 不一致", false);
  }
  url.pathname = `${path.slice(0, -suffix.length)}/`;
  return url;
}

function tusHeaders(credential: TusCredential): Record<string, string> {
  return {
    "Tus-Resumable": TUS_VERSION,
    "Upload-Token": credential.token,
  };
}

function parseOffset(response: Response): number {
  const raw = response.headers.get("Upload-Offset");
  const offset = Number(raw);
  if (!raw || !Number.isSafeInteger(offset) || offset < 0) {
    throw new TusUploadError("tus 响应缺少有效 Upload-Offset", false);
  }
  return offset;
}

function assertSameUpload(previous: TusCredential, next: TusCredential): void {
  if (
    previous.uploadId !== next.uploadId ||
    normalizeUrl(new URL(previous.tusUrl)) !==
      normalizeUrl(new URL(next.tusUrl))
  ) {
    throw new TusUploadError("刷新凭据改变了 tus upload URL", false);
  }
}

function normalizeUrl(url: URL): string {
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function requireChunkBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TusUploadError("云端返回了无效的 tus 分块大小", false);
  }
  return value;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function patchDeadlineSignal(parent?: AbortSignal): {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("tus PATCH 超时", "TimeoutError"));
  }, TUS_PATCH_TIMEOUT_MILLISECONDS);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}
