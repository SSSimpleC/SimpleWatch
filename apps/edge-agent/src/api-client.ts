import type {
  CatalogPagePayload,
  EdgeTask,
  TusCredential,
  UploadProgress,
} from "./types.js";

export interface SourceProof {
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

export const EDGE_API_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
export const EDGE_API_LONG_POLL_GRACE_MILLISECONDS = 10_000;

export class EdgeApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "EdgeApiError";
  }
}

export class EdgeApiClient {
  readonly #origin: URL;
  readonly #agentToken: string;
  readonly #fetch: typeof fetch;

  public constructor(
    apiOrigin: string,
    agentToken: string,
    fetchImpl: typeof fetch = fetch,
    allowInsecureHttp = false,
  ) {
    this.#origin = new URL(apiOrigin);
    this.#agentToken = agentToken;
    this.#fetch = fetchImpl;
    if (this.#origin.protocol !== "https:" && !allowInsecureHttp) {
      throw new Error("Edge API 必须使用 HTTPS");
    }
  }

  public heartbeat(signal?: AbortSignal): Promise<void> {
    return this.#request<void>(
      "POST",
      "/api/v1/edge/v1/heartbeat",
      {
        protocolVersion: 1,
        softwareVersion: "0.1.0",
        capabilities: {
          catalogScan: true,
          tusResume: true,
          sourceProof: "sha256",
        },
      },
      signal,
    );
  }

  public async beginCatalogScan(
    generation: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.#request<unknown>(
      "POST",
      "/api/v1/edge/v1/catalog/scans",
      { generation },
      signal,
    );
    return edgeCatalogScanCreatedSchema.parse(response).scanId;
  }

  public putCatalogPage(
    page: CatalogPagePayload,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#request<void>(
      "PUT",
      `/api/v1/edge/v1/catalog/scans/${encodeURIComponent(page.scanId)}/pages`,
      {
        generation: page.generation,
        pageIndex: page.pageIndex,
        entries: page.entries,
      },
      signal,
    );
  }

  public commitCatalogScan(
    scanId: string,
    generation: number,
    pageCount: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#request<void>(
      "POST",
      `/api/v1/edge/v1/catalog/scans/${encodeURIComponent(scanId)}/commit`,
      { generation, pageCount },
      signal,
    );
  }

  public async claimJob(
    waitSeconds = 25,
    signal?: AbortSignal,
  ): Promise<EdgeTask | undefined> {
    const response = await this.#request<unknown>(
      "GET",
      `/api/v1/edge/v1/jobs/claim?waitSeconds=${waitSeconds}`,
      undefined,
      signal,
      true,
      Math.max(0, waitSeconds) * 1000 + EDGE_API_LONG_POLL_GRACE_MILLISECONDS,
    );
    if (!response) return undefined;
    return edgeClaimedJobSchema.parse(response);
  }

  public heartbeatJob(
    jobId: string,
    leaseToken: string,
    progress?: UploadProgress,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly leaseExpiresAt: string;
        readonly cancelRequested: boolean;
      }
    | undefined
  > {
    return this.#request<unknown>(
      "POST",
      `/api/v1/edge/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      {
        leaseToken,
        ...(progress === undefined
          ? {}
          : { bytesTransferred: progress.offset }),
      },
      signal,
    ).then((response) => edgeJobHeartbeatResponseSchema.parse(response));
  }

  public requestUpload(
    jobId: string,
    leaseToken: string,
    source: SourceProof,
    signal?: AbortSignal,
  ): Promise<TusCredential> {
    return this.#request<unknown>(
      "POST",
      `/api/v1/edge/v1/jobs/${encodeURIComponent(jobId)}/upload-credential`,
      { leaseToken, source },
      signal,
    ).then((response) => edgeTusCredentialSchema.parse(response));
  }

  public refreshUploadCredential(
    jobId: string,
    leaseToken: string,
    source: SourceProof,
    signal?: AbortSignal,
  ): Promise<TusCredential> {
    return this.#request<unknown>(
      "POST",
      `/api/v1/edge/v1/jobs/${encodeURIComponent(jobId)}/upload-credential`,
      { leaseToken, source },
      signal,
    ).then((response) => edgeTusCredentialSchema.parse(response));
  }

  public completeJob(
    jobId: string,
    leaseToken: string,
    source: SourceProof | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#request<void>(
      "POST",
      `/api/v1/edge/v1/jobs/${encodeURIComponent(jobId)}/complete`,
      { leaseToken, ...(source === undefined ? {} : { source }) },
      signal,
    );
  }

  public failJob(
    jobId: string,
    leaseToken: string,
    code: string,
    message: string,
    retryable: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#request<void>(
      "POST",
      `/api/v1/edge/v1/jobs/${encodeURIComponent(jobId)}/fail`,
      { leaseToken, code, message, retryable },
      signal,
    );
  }

  public cancelledJob(
    jobId: string,
    leaseToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#request<void>(
      "POST",
      `/api/v1/edge/v1/jobs/${encodeURIComponent(jobId)}/cancelled`,
      { leaseToken },
      signal,
    );
  }

  async #request<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    allowNoContent = false,
    timeoutMilliseconds = EDGE_API_REQUEST_TIMEOUT_MILLISECONDS,
  ): Promise<T> {
    const deadline = deadlineSignal(signal, timeoutMilliseconds);
    try {
      const response = await this.#fetch(new URL(path, this.#origin), {
        method,
        headers: {
          Authorization: `Bearer ${this.#agentToken}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: deadline.signal,
      });
      if (response.status === 204 && allowNoContent) return undefined as T;
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | {
              readonly error?: {
                readonly code?: unknown;
                readonly message?: unknown;
              };
            }
          | undefined;
        const code =
          typeof payload?.error?.code === "string"
            ? payload.error.code
            : undefined;
        throw new EdgeApiError(
          typeof payload?.error?.message === "string"
            ? payload.error.message
            : `Edge API 请求失败：HTTP ${response.status}`,
          response.status,
          response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500,
          code,
        );
      }
      if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
      ) {
        return undefined as T;
      }
      return (await response.json()) as T;
    } catch (error) {
      if (deadline.didTimeout() && !signal?.aborted) {
        throw new EdgeApiError(
          "Edge API 请求超时",
          408,
          true,
          "REQUEST_TIMEOUT",
        );
      }
      throw error;
    } finally {
      deadline.dispose();
    }
  }
}

function deadlineSignal(
  parent: AbortSignal | undefined,
  timeoutMilliseconds: number,
): {
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
    controller.abort(new DOMException("Edge API 请求超时", "TimeoutError"));
  }, timeoutMilliseconds);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}
import {
  edgeCatalogScanCreatedSchema,
  edgeClaimedJobSchema,
  edgeJobHeartbeatResponseSchema,
  edgeTusCredentialSchema,
} from "@simplewatch/contracts";
