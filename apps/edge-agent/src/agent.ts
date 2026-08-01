import { createHash } from "node:crypto";

import { EdgeApiError } from "./api-client.js";
import type { EdgeApiClient } from "./api-client.js";
import { delay, fullJitterBackoff } from "./backoff.js";
import { inspectCatalogFile, paginateCatalog, scanLibrary } from "./catalog.js";
import type { EdgeAgentConfig } from "./config.js";
import { proveSource, SourceProofError } from "./source-proof.js";
import type { AgentState } from "./state.js";
import { TusUploadError } from "./tus-client.js";
import type { TusUploadClient } from "./tus-client.js";
import type {
  CatalogEntry,
  EdgeTask,
  SourceIdentity,
  StoredUpload,
  TusCredential,
  UploadProgress,
} from "./types.js";

export interface AgentLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type EdgeControlPlane = Pick<
  EdgeApiClient,
  | "heartbeat"
  | "beginCatalogScan"
  | "putCatalogPage"
  | "commitCatalogScan"
  | "claimJob"
  | "heartbeatJob"
  | "requestUpload"
  | "refreshUploadCredential"
  | "completeJob"
  | "failJob"
  | "cancelledJob"
>;

export type EdgeTusUploader = Pick<TusUploadClient, "upload">;

const CLOUD_RECEIPT_INITIAL_DELAY_MILLISECONDS = 250;
const CLOUD_RECEIPT_MAX_DELAY_MILLISECONDS = 2_000;
const CLOUD_RECEIPT_MAX_ATTEMPTS = 8;

export class EdgeAgent {
  readonly #config: EdgeAgentConfig;
  readonly #state: AgentState;
  readonly #api: EdgeControlPlane;
  readonly #tus: EdgeTusUploader;
  readonly #logger: AgentLogger;
  readonly #now: () => number;
  #scanInFlight: Promise<number> | undefined;

  public constructor(
    config: EdgeAgentConfig,
    state: AgentState,
    api: EdgeControlPlane,
    tus: EdgeTusUploader,
    logger: AgentLogger,
    now: () => number = Date.now,
  ) {
    this.#config = config;
    this.#state = state;
    this.#api = api;
    this.#tus = tus;
    this.#logger = logger;
    this.#now = now;
  }

  public async synchronizeCatalog(signal?: AbortSignal): Promise<number> {
    if (this.#scanInFlight) return this.#scanInFlight;
    const operation = this.#doSynchronizeCatalog(signal);
    this.#scanInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.#scanInFlight === operation) this.#scanInFlight = undefined;
    }
  }

  async #doSynchronizeCatalog(signal?: AbortSignal): Promise<number> {
    const scan = await scanLibrary(this.#config.libraryRoot);
    const generation = this.#nextCatalogGeneration();
    const stableEntries = this.#state.observeCatalog(generation, scan.entries);
    if (stableEntries.length !== scan.entries.length) {
      this.#logger.info("家庭媒体目录仍在等待稳定性复核", {
        discovered: scan.entries.length,
        stable: stableEntries.length,
      });
      return stableEntries.length;
    }
    if (!this.#catalogSnapshotPassesQualityGate(stableEntries)) {
      return stableEntries.length;
    }
    const scanId = await this.#api.beginCatalogScan(generation, signal);
    const pages = paginateCatalog(scanId, generation, stableEntries);
    for (const page of pages) await this.#api.putCatalogPage(page, signal);
    await this.#api.commitCatalogScan(scanId, generation, pages.length, signal);
    this.#state.replaceCatalog(generation, stableEntries);
    this.#logger.info("家庭媒体目录已同步", {
      discovered: scan.entries.length,
      stable: stableEntries.length,
      pages: pages.length,
    });
    return stableEntries.length;
  }

  public async processTask(
    task: EdgeTask,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (task.payload.kind) {
      case "catalog_scan":
        await this.#catalogScanTask(task, signal);
        return;
      case "cancel_transfer":
        this.#state.deleteUploadByTransferId(task.payload.edgeTransferId);
        await this.#api.completeJob(
          task.id,
          task.leaseToken,
          undefined,
          signal,
        );
        return;
      case "verify_source":
        await this.#verifySourceTask(task, task.payload, signal);
        return;
      case "upload":
        await this.#uploadTask(task, task.payload, signal);
        return;
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    await Promise.all([
      this.#heartbeatLoop(signal),
      this.#runCatalogAndTaskLoops(signal),
    ]);
  }

  async #runCatalogAndTaskLoops(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#hasPublishedCatalog()) {
      try {
        await this.synchronizeCatalog(signal);
      } catch (error) {
        if (signal.aborted) return;
        this.#logger.warn("首次家庭媒体目录同步暂时失败", {
          error: safeErrorName(error),
        });
      }
      if (this.#hasPublishedCatalog()) break;
      await delay(this.#config.stabilityObservationMs, signal).catch(
        () => undefined,
      );
    }
    if (signal.aborted) return;
    await Promise.all([this.#catalogLoop(signal), this.#taskLoop(signal)]);
  }

  #hasPublishedCatalog(): boolean {
    const generation = Number(this.#state.getMeta("catalog_generation"));
    return Number.isSafeInteger(generation) && generation > 0;
  }

  async #verifySourceTask(
    task: EdgeTask,
    source: SourceIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    const taskController = new AbortController();
    const heartbeatController = new AbortController();
    let cancelRequested = false;
    const forwardAbort = () => taskController.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const heartbeat = this.#jobHeartbeatLoop(
      task,
      () => ({ offset: 0, totalBytes: source.expectedBytes }),
      heartbeatController.signal,
      () => {
        cancelRequested = true;
        taskController.abort(new DOMException("任务已取消", "AbortError"));
      },
      () =>
        taskController.abort(new DOMException("任务租约已失效", "AbortError")),
    );
    try {
      const entry = this.#requireCatalogEntry(source);
      const proof = await proveSource(
        this.#config.libraryRoot,
        entry,
        source,
        taskController.signal,
      );
      await this.#api.completeJob(
        task.id,
        task.leaseToken,
        proof,
        taskController.signal,
      );
    } catch (error) {
      if (cancelRequested) {
        await this.#api.cancelledJob(task.id, task.leaseToken, signal);
      } else {
        await this.#reportFailure(task, error, signal);
      }
    } finally {
      heartbeatController.abort();
      signal?.removeEventListener("abort", forwardAbort);
      await heartbeat;
    }
  }

  async #catalogScanTask(task: EdgeTask, signal?: AbortSignal): Promise<void> {
    const taskController = new AbortController();
    const heartbeatController = new AbortController();
    let cancelRequested = false;
    const forwardAbort = () => taskController.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const heartbeat = this.#jobHeartbeatLoop(
      task,
      () => ({ offset: 0, totalBytes: 0 }),
      heartbeatController.signal,
      () => {
        cancelRequested = true;
        taskController.abort(new DOMException("任务已取消", "AbortError"));
      },
      () =>
        taskController.abort(new DOMException("任务租约已失效", "AbortError")),
    );
    try {
      await this.synchronizeCatalog(taskController.signal);
      await this.#api.completeJob(
        task.id,
        task.leaseToken,
        undefined,
        taskController.signal,
      );
    } catch (error) {
      if (cancelRequested) {
        await this.#api.cancelledJob(task.id, task.leaseToken, signal);
      } else {
        await this.#reportFailure(task, error, signal);
      }
    } finally {
      heartbeatController.abort();
      signal?.removeEventListener("abort", forwardAbort);
      await heartbeat;
    }
  }

  async #uploadTask(
    task: EdgeTask,
    source: SourceIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    let entry;
    try {
      entry = this.#requireCatalogEntry(source);
      const current = await inspectCatalogFile(
        this.#config.libraryRoot,
        entry.relativePath,
      );
      if (current.revision !== entry.revision) {
        throw new SourceProofError("SOURCE_CHANGED", "媒体源版本已发生变化");
      }
    } catch (error) {
      await this.#reportFailure(task, error, signal);
      return;
    }

    let latestProgress: UploadProgress = { offset: 0, totalBytes: entry.bytes };
    const taskController = new AbortController();
    const heartbeatController = new AbortController();
    let cancelRequested = false;
    const forwardAbort = () => taskController.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const heartbeat = this.#jobHeartbeatLoop(
      task,
      () => latestProgress,
      heartbeatController.signal,
      () => {
        cancelRequested = true;
        taskController.abort(new DOMException("任务已取消", "AbortError"));
      },
      () =>
        taskController.abort(new DOMException("任务租约已失效", "AbortError")),
    );
    try {
      let stored = this.#state.getUpload(task.id);
      if (
        stored &&
        (stored.localId !== source.localId ||
          stored.sourceRevision !== entry.revision ||
          stored.totalBytes !== entry.bytes)
      ) {
        this.#state.deleteUpload(task.id);
        stored = undefined;
      }
      const sourceProof = await proveSource(
        this.#config.libraryRoot,
        entry,
        source,
        taskController.signal,
      );
      let credential = stored
        ? toCredential(stored)
        : await this.#api.requestUpload(
            task.id,
            task.leaseToken,
            sourceProof,
            taskController.signal,
          );
      latestProgress = {
        offset: stored?.offset ?? 0,
        totalBytes: entry.bytes,
      };
      const save = (
        nextCredential: TusCredential,
        progress = latestProgress,
      ) => {
        credential = nextCredential;
        this.#state.saveUpload({
          jobId: task.id,
          localId: source.localId,
          sourceRevision: entry.revision,
          uploadUrl: nextCredential.tusUrl,
          edgeTransferId: nextCredential.edgeTransferId,
          uploadId: nextCredential.uploadId,
          uploadToken: nextCredential.token,
          credentialExpiresAt: parseTimestamp(nextCredential.expiresAt),
          credentialRefreshAfter: parseTimestamp(nextCredential.refreshAfter),
          chunkBytes: nextCredential.chunkBytes,
          offset: progress.offset,
          totalBytes: progress.totalBytes,
          updatedAt: this.#now(),
        });
      };
      save(credential);

      const result = await this.#tus.upload({
        libraryRoot: this.#config.libraryRoot,
        entry,
        credential,
        refreshCredential: (previous, refreshSignal) =>
          this.#api.refreshUploadCredential(
            task.id,
            task.leaseToken,
            sourceProof,
            refreshSignal,
          ),
        onCredential: (nextCredential) => save(nextCredential),
        onProgress: (progress) => {
          latestProgress = progress;
          save(credential, progress);
        },
        signal: taskController.signal,
      });
      if (sourceProof.sha256 !== result.sha256) {
        throw new SourceProofError(
          "SOURCE_CHANGED",
          "媒体源在校验与传输之间发生了变化",
        );
      }
      await this.#api.heartbeatJob(
        task.id,
        task.leaseToken,
        { offset: result.offset, totalBytes: result.totalBytes },
        taskController.signal,
      );
      await this.#completeUploadedTask(
        task,
        {
          bytes: result.totalBytes,
          mtimeMs: result.mtimeMs,
          sha256: result.sha256,
        },
        taskController.signal,
      );
      this.#state.deleteUpload(task.id);
      this.#logger.info("家庭媒体上传完成", {
        jobId: task.id,
        bytes: result.totalBytes,
      });
    } catch (error) {
      if (cancelRequested) {
        this.#state.deleteUpload(task.id);
        await this.#api.cancelledJob(task.id, task.leaseToken, signal);
      } else {
        await this.#reportFailure(task, error, signal);
      }
    } finally {
      heartbeatController.abort();
      signal?.removeEventListener("abort", forwardAbort);
      await heartbeat;
    }
  }

  #requireCatalogEntry(source: SourceIdentity) {
    const entry = this.#state.getCatalogItem(source.localId);
    if (!entry) {
      throw new SourceProofError("SOURCE_MISSING", "家庭媒体源不存在");
    }
    if (
      entry.bytes !== source.expectedBytes ||
      entry.mtimeMs !== source.expectedMtimeMs
    ) {
      throw new SourceProofError("SOURCE_CHANGED", "家庭媒体源版本已发生变化");
    }
    return entry;
  }

  async #reportFailure(
    task: EdgeTask,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const failure = classifyFailure(error);
    this.#logger.warn("家庭媒体任务未完成", {
      jobId: task.id,
      code: failure.code,
      retryable: failure.retryable,
    });
    try {
      await this.#api.failJob(
        task.id,
        task.leaseToken,
        failure.code,
        failure.message,
        failure.retryable,
        signal,
      );
    } catch (reportError) {
      this.#logger.warn("任务失败状态暂时无法上报", {
        jobId: task.id,
        error: safeErrorName(reportError),
      });
    }
  }

  async #completeUploadedTask(
    task: EdgeTask,
    source: {
      readonly bytes: number;
      readonly mtimeMs: number;
      readonly sha256: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#api.completeJob(task.id, task.leaseToken, source, signal);
        return;
      } catch (error) {
        if (
          !isCloudReceiptPending(error) ||
          attempt >= CLOUD_RECEIPT_MAX_ATTEMPTS - 1
        ) {
          throw error;
        }
        const delayMilliseconds = Math.min(
          CLOUD_RECEIPT_MAX_DELAY_MILLISECONDS,
          CLOUD_RECEIPT_INITIAL_DELAY_MILLISECONDS * 2 ** attempt,
        );
        this.#logger.info("等待云端确认最终上传分块", {
          jobId: task.id,
          attempt: attempt + 1,
          delayMilliseconds,
        });
        await delay(delayMilliseconds, signal);
      }
    }
  }

  async #heartbeatLoop(signal: AbortSignal): Promise<void> {
    let connected = false;
    while (!signal.aborted) {
      try {
        await this.#api.heartbeat(signal);
        if (!connected) {
          this.#logger.info("Agent 已连接控制面");
          connected = true;
        }
      } catch (error) {
        if (signal.aborted) return;
        connected = false;
        this.#logger.warn("Agent 心跳暂时失败", {
          error: safeErrorName(error),
        });
      }
      await delay(this.#config.heartbeatIntervalMs, signal).catch(
        () => undefined,
      );
    }
  }

  async #catalogLoop(signal: AbortSignal): Promise<void> {
    let initialObservation = true;
    while (!signal.aborted) {
      try {
        await this.synchronizeCatalog(signal);
      } catch (error) {
        if (signal.aborted) return;
        this.#logger.warn("家庭媒体目录同步暂时失败", {
          error: safeErrorName(error),
        });
      }
      const interval = initialObservation
        ? this.#config.stabilityObservationMs
        : this.#config.scanIntervalMs;
      initialObservation = false;
      await delay(interval, signal).catch(() => undefined);
    }
  }

  async #taskLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const task = await this.#api.claimJob(
          this.#config.claimWaitSeconds,
          signal,
        );
        failures = 0;
        if (task) await this.processTask(task, signal);
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        this.#logger.warn("任务长轮询暂时失败", {
          error: safeErrorName(error),
          failures,
        });
        await delay(fullJitterBackoff(failures), signal).catch(() => undefined);
      }
    }
  }

  async #jobHeartbeatLoop(
    task: EdgeTask,
    progress: () => UploadProgress,
    signal: AbortSignal,
    onCancelRequested: () => void,
    onLeaseLost: () => void,
  ): Promise<void> {
    let leaseExpiresAt = Date.parse(task.leaseExpiresAt);
    if (!Number.isFinite(leaseExpiresAt)) {
      onLeaseLost();
      return;
    }
    while (!signal.aborted) {
      try {
        const response = await this.#api.heartbeatJob(
          task.id,
          task.leaseToken,
          progress(),
          signal,
        );
        if (response) {
          const nextLeaseExpiresAt = Date.parse(response.leaseExpiresAt);
          if (!Number.isFinite(nextLeaseExpiresAt)) {
            onLeaseLost();
            return;
          }
          leaseExpiresAt = nextLeaseExpiresAt;
        }
        if (response?.cancelRequested) {
          onCancelRequested();
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (
          (error instanceof EdgeApiError &&
            new Set([401, 403, 409]).has(error.status)) ||
          this.#now() >= leaseExpiresAt
        ) {
          onLeaseLost();
          return;
        }
        this.#logger.warn("任务租约心跳暂时失败", {
          jobId: task.id,
          error: safeErrorName(error),
        });
      }
      await delay(this.#config.heartbeatIntervalMs, signal).catch(
        () => undefined,
      );
    }
  }

  #nextCatalogGeneration(): number {
    const current = Number(this.#state.getMeta("scan_generation") ?? "0");
    const previous =
      Number.isSafeInteger(current) && current >= 0 ? current : 0;
    const generation = Math.max(previous + 1, this.#now());
    this.#state.setMeta("scan_generation", String(generation));
    return generation;
  }

  #catalogSnapshotPassesQualityGate(entries: readonly CatalogEntry[]): boolean {
    const previous = this.#state.listCatalog();
    if (previous.length === 0) {
      this.#clearCatalogQualityGate();
      return true;
    }
    const previousBytes = previous.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    const nextBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    const removedCount = previous.length - entries.length;
    const suspicious =
      entries.length === 0 ||
      (removedCount >= 10 && entries.length * 2 <= previous.length) ||
      (previousBytes > 0 && nextBytes * 2 <= previousBytes);
    if (!suspicious) {
      this.#clearCatalogQualityGate();
      return true;
    }

    const signature = createHash("sha256")
      .update(
        entries
          .map((entry) => `${entry.localId}\0${entry.revision}`)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    const previousSignature = this.#state.getMeta(
      "catalog_quality_pending_signature",
    );
    if (previousSignature === signature) {
      this.#clearCatalogQualityGate();
      this.#logger.warn("家庭媒体目录批量减少已通过第二次一致性确认", {
        previousItems: previous.length,
        currentItems: entries.length,
        previousBytes,
        currentBytes: nextBytes,
      });
      return true;
    }

    this.#state.setMeta("catalog_quality_pending_signature", signature);
    this.#logger.warn("家庭媒体目录批量减少，等待下一次一致性确认", {
      previousItems: previous.length,
      currentItems: entries.length,
      previousBytes,
      currentBytes: nextBytes,
    });
    return false;
  }

  #clearCatalogQualityGate(): void {
    this.#state.deleteMeta("catalog_quality_pending_signature");
  }
}

function toCredential(upload: StoredUpload): TusCredential {
  return {
    edgeTransferId: upload.edgeTransferId,
    uploadId: upload.uploadId,
    tusUrl: upload.uploadUrl,
    token: upload.uploadToken,
    expiresAt: new Date(upload.credentialExpiresAt).toISOString(),
    refreshAfter: new Date(upload.credentialRefreshAfter).toISOString(),
    chunkBytes: upload.chunkBytes,
  };
}

function classifyFailure(error: unknown): {
  readonly code:
    | "SOURCE_MISSING"
    | "SOURCE_CHANGED"
    | "PERMISSION_DENIED"
    | "INSUFFICIENT_STORAGE"
    | "NETWORK_ERROR"
    | "INTERNAL_ERROR";
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof SourceProofError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof TusUploadError) {
    const sourceChanged = error.message.includes("媒体源");
    return {
      code: error.retryable
        ? "NETWORK_ERROR"
        : sourceChanged
          ? "SOURCE_CHANGED"
          : "INTERNAL_ERROR",
      message: error.retryable ? "媒体传输暂时中断" : error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof EdgeApiError) {
    if (error.code === "INSUFFICIENT_STORAGE") {
      return {
        code: "INSUFFICIENT_STORAGE",
        message: "云端安全容量不足",
        retryable: false,
      };
    }
    if (
      error.code === "EDGE_SOURCE_CHANGED" ||
      error.code === "EDGE_SOURCE_MISMATCH"
    ) {
      return {
        code: "SOURCE_CHANGED",
        message: "家庭媒体源版本已经改变",
        retryable: false,
      };
    }
    if (error.code === "EDGE_UPLOAD_NOT_RECEIVED") {
      return {
        code: "NETWORK_ERROR",
        message: "云端仍在确认最终上传分块",
        retryable: true,
      };
    }
    return {
      code: error.retryable ? "NETWORK_ERROR" : "INTERNAL_ERROR",
      message: "云端任务接口暂时不可用",
      retryable: error.retryable,
    };
  }
  if (isNodeError(error, "ENOENT")) {
    return {
      code: "SOURCE_MISSING",
      message: "家庭媒体源不存在",
      retryable: false,
    };
  }
  if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) {
    return {
      code: "PERMISSION_DENIED",
      message: "家庭媒体源不可读取",
      retryable: false,
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "NETWORK_ERROR",
      message: "家庭 Agent 网络连接暂时中断",
      retryable: true,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "家庭 Agent 处理任务时发生内部错误",
    retryable: true,
  };
}

function isCloudReceiptPending(error: unknown): boolean {
  return (
    error instanceof EdgeApiError &&
    error.status === 409 &&
    error.code === "EDGE_UPLOAD_NOT_RECEIVED"
  );
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("云端凭据时间戳无效");
  return timestamp;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}
