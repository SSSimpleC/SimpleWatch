import { describe, expect, it, vi } from "vitest";

import { EdgeApiClient, type EdgeApiError } from "../src/api-client.js";

describe("Edge HTTPS 长轮询客户端", () => {
  it("把204解释为无任务并仅使用Bearer机器令牌", async () => {
    const fetchSpy = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer machine-token-machine-token-machine-token",
      );
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = new EdgeApiClient(
      "https://example.test",
      "machine-token-machine-token-machine-token",
      fetchSpy as unknown as typeof fetch,
    );

    await expect(client.claimJob(25)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const requestTarget = fetchSpy.mock.calls[0]?.[0];
    expect(requestTarget).toBeInstanceOf(URL);
    expect((requestTarget as URL).searchParams.get("waitSeconds")).toBe("25");
  });

  it("生产配置拒绝明文HTTP", () => {
    expect(
      () =>
        new EdgeApiClient(
          "http://example.test",
          "machine-token-machine-token-machine-token",
        ),
    ).toThrow("必须使用 HTTPS");
  });

  it("按云端机器路由发送协议心跳、catalog页和源证明凭据请求", async () => {
    const requests: Array<{
      readonly method: string;
      readonly pathname: string;
      readonly body: unknown;
    }> = [];
    const fetchImpl = vi.fn(
      (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const url =
          input instanceof URL
            ? input
            : typeof input === "string"
              ? new URL(input)
              : new URL(input.url);
        requests.push({
          method: init?.method ?? "GET",
          pathname: url.pathname,
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : undefined,
        });
        if (url.pathname.endsWith("upload-credential")) {
          return Promise.resolve(
            Response.json({
              edgeTransferId: "01900000-0000-7000-8000-000000000001",
              uploadId: "01900000-0000-7000-8000-000000000002",
              tusUrl: "https://example.test/files/",
              token: "token-token-token-token-token-token",
              expiresAt: "2030-01-01T00:00:00.000Z",
              refreshAfter: "2029-12-31T23:45:00.000Z",
              chunkBytes: 16_777_216,
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    ) as unknown as typeof fetch;
    const client = new EdgeApiClient(
      "https://example.test",
      "machine-token-machine-token-machine-token",
      fetchImpl,
    );
    const source = {
      bytes: 5,
      mtimeMs: 1_700_000_000_000,
      sha256: "a".repeat(64),
    };

    await client.heartbeat();
    await client.putCatalogPage({
      scanId: "scan-id",
      generation: 3,
      pageIndex: 2,
      entries: [],
    });
    await client.requestUpload("job-id", "lease-token", source);

    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      method: "POST",
      pathname: "/api/v1/edge/v1/heartbeat",
      body: { protocolVersion: 1, softwareVersion: "0.1.0" },
    });
    expect(requests.slice(1)).toEqual([
      {
        method: "PUT",
        pathname: "/api/v1/edge/v1/catalog/scans/scan-id/pages",
        body: { generation: 3, pageIndex: 2, entries: [] },
      },
      {
        method: "POST",
        pathname: "/api/v1/edge/v1/jobs/job-id/upload-credential",
        body: { leaseToken: "lease-token", source },
      },
    ]);
  });

  it("普通控制面请求在30秒后作为可重试超时失败", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(
        (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
          requestSignal = init?.signal ?? undefined;
          return rejectWhenAborted(requestSignal);
        },
      ) as unknown as typeof fetch;
      const client = new EdgeApiClient(
        "https://example.test",
        "machine-token-machine-token-machine-token",
        fetchImpl,
      );

      const request = client.heartbeat();
      const rejected = expect(request).rejects.toMatchObject({
        status: 408,
        retryable: true,
        code: "REQUEST_TIMEOUT",
      } satisfies Partial<EdgeApiError>);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("长轮询使用wait加10秒宽限而不是普通30秒截止", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(
        (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
          requestSignal = init?.signal ?? undefined;
          return rejectWhenAborted(requestSignal);
        },
      ) as unknown as typeof fetch;
      const client = new EdgeApiClient(
        "https://example.test",
        "machine-token-machine-token-machine-token",
        fetchImpl,
      );

      const request = client.claimJob(25);
      const rejected = expect(request).rejects.toMatchObject({
        status: 408,
        code: "REQUEST_TIMEOUT",
      } satisfies Partial<EdgeApiError>);
      await vi.advanceTimersByTimeAsync(34_999);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
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
