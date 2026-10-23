import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerBuildMonitor, parsePlayerBuild } from "../src/player-build.js";

const buildId = "a".repeat(64);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("non-disruptive player build checks", () => {
  it("invokes the default browser fetch with its global Window receiver", async () => {
    const nativeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, buildId })),
      );
    });
    vi.stubGlobal("fetch", nativeFetch);
    const monitor = new PlayerBuildMonitor();
    expect(await monitor.check()).toBe(buildId);
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(nativeFetch).toHaveBeenCalledWith(
      "/player-version.json",
      expect.objectContaining({ cache: "no-store", credentials: "omit" }),
    );
    monitor.dispose();
  });

  it("does not bind injected fetch functions to the monitor and contains synchronous failures", async () => {
    const injectedFetch = vi.fn(function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, buildId })),
      );
    });
    const monitor = new PlayerBuildMonitor(injectedFetch);
    expect(await monitor.check()).toBe(buildId);
    monitor.dispose();
    const failure = new PlayerBuildMonitor(() => {
      throw new Error("synchronous failure");
    });
    expect(await failure.check()).toBeNull();
    failure.dispose();
  });

  it("accepts only the bounded public build schema", () => {
    expect(parsePlayerBuild({ schemaVersion: 1, buildId })).toBe(buildId);
    for (const value of [
      null,
      [],
      { buildId },
      { schemaVersion: 2, buildId },
      { schemaVersion: 1, buildId: "https://secret" },
      { schemaVersion: 1, buildId: "a".repeat(65) },
    ])
      expect(parsePlayerBuild(value)).toBeNull();
  });

  it("does not send credentials, deduplicates and throttles requests", async () => {
    let now = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ schemaVersion: 1, buildId })),
      );
    const monitor = new PlayerBuildMonitor(fetcher, () => now);
    const first = monitor.check();
    expect(monitor.check()).toBe(first);
    expect(await first).toBe(buildId);
    expect(await monitor.check()).toBe(buildId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/player-version.json",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
      }),
    );
    now = 15_000;
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({ schemaVersion: 1, buildId: "b".repeat(64) }),
      ),
    );
    expect(await monitor.check()).toBe("b".repeat(64));
    expect(fetcher).toHaveBeenCalledTimes(2);
    monitor.dispose();
    expect(await monitor.check()).toBeNull();
  });

  it("tolerates failed or malformed checks without disturbing the player", async () => {
    for (const response of [
      new Response("oops"),
      new Response("x".repeat(300)),
      new Response("denied", { status: 401 }),
    ]) {
      const monitor = new PlayerBuildMonitor(
        vi.fn<typeof fetch>().mockResolvedValue(response),
      );
      expect(await monitor.check()).toBeNull();
      monitor.dispose();
    }
    const monitor = new PlayerBuildMonitor(
      vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    );
    expect(await monitor.check()).toBeNull();
    monitor.dispose();
  });

  it("aborts checks after five seconds and ignores results after disposal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    let finish: (value: Response) => void = () => undefined;
    const fetcher: typeof fetch = (_url, options) => {
      signal = options?.signal ?? null;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const monitor = new PlayerBuildMonitor(fetcher);
    const request = monitor.check();
    await vi.advanceTimersByTimeAsync(5000);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    monitor.dispose();
    finish(new Response(JSON.stringify({ schemaVersion: 1, buildId })));
    expect(await request).toBeNull();
  });
});
