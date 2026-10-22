import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../src/database.js";
import { TransportService } from "../src/services/transport-service.js";

afterEach(() => vi.unstubAllGlobals());

function harness() {
  let now = 0;
  let source: unknown = { type: "webRTCSession", id: "publisher" };
  let ready = true;
  let body = metrics("publisher", 0, 0, 0);
  const metricsFetch = vi.fn(() => Promise.resolve(new Response(body)));
  const fetchMock = vi.fn((url: string | URL | Request) => {
    const address =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (address.includes(":9998/metrics")) return metricsFetch();
    return Promise.resolve(
      new Response(
        JSON.stringify({
          items: [{ name: "program", ready, source, tracks: ["H264", "Opus"] }],
        }),
      ),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const database = {
    prepare: () => ({ get: () => ({ live_path: "program" }) }),
  } as unknown as AppDatabase;
  const service = new TransportService(database, {
    mediaJwtSecret: "test-live-media-secret-at-least-32-bytes",
    obsCredentialEncryptionKey: "test-live-obs-secret-at-least-32-bytes",
    mediaOrigin: "https://watch.example.test",
    livekitApiKey: "test-key",
    livekitApiSecret: "test-livekit-secret-at-least-32-bytes",
    livekitUrl: "wss://watch.example.test/voice",
    mediamtxControlUrl: "http://mediamtx:9997",
    now: () => now,
  });
  return {
    service,
    metricsFetch,
    fetchMock,
    set: (options: {
      now?: number;
      source?: unknown;
      body?: string;
      ready?: boolean;
    }) => {
      if (options.now !== undefined) now = options.now;
      if (options.source !== undefined) source = options.source;
      if (options.body !== undefined) body = options.body;
      if (options.ready !== undefined) ready = options.ready;
    },
  };
}

// Label names and counter names match MediaMTX v1.18.2 internal/metrics/metrics.go.
function metrics(
  id: string,
  bytes: number,
  packets: number,
  lost: number,
  state = "publish",
  path = "program",
) {
  const labels = `id="${id}",path="${path}",remoteAddr="127.0.0.1:1000",state="${state}"`;
  return (
    `webrtc_sessions_inbound_bytes{${labels}} ${bytes}\n` +
    `webrtc_sessions_inbound_rtp_packets{${labels}} ${packets}\n` +
    `webrtc_sessions_inbound_rtp_packets_lost{${labels}} ${lost}\n`
  );
}

describe("live source session statistics", () => {
  it("selects only the current publisher, not readers or previous publishers on its path", async () => {
    const test = harness();
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "unknown",
    });
    test.set({
      now: 2000,
      body:
        metrics("publisher", 1_000_000, 1000, 50) +
        metrics("old-publisher", 99_000_000, 1000, 0) +
        metrics("reader", 99_000_000, 1000, 0, "read") +
        metrics("publisher", 99_000_000, 1000, 0, "publish", "another-program"),
    });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceBitrateMbps: 4,
      sourcePacketLossPercent: 50 / 10.5,
      sourceHealth: "poor",
    });
  });

  it("shares metrics results for two seconds and concurrent path requests", async () => {
    const test = harness();
    const first = await Promise.all(
      Array.from({ length: 5 }, () => test.service.getLiveStatus("room")),
    );
    expect(first.every((status) => status.sourceHealth === "unknown")).toBe(
      true,
    );
    expect(test.metricsFetch).toHaveBeenCalledTimes(1);
    expect(test.fetchMock).toHaveBeenCalledTimes(2);
    test.set({ now: 1000 });
    await test.service.getLiveStatus("room");
    expect(test.metricsFetch).toHaveBeenCalledTimes(1);
    test.set({ now: 2000, body: metrics("publisher", 1_000_000, 1000, 0) });
    const second = await Promise.all(
      Array.from({ length: 5 }, () => test.service.getLiveStatus("room")),
    );
    expect(second.every((status) => status.sourceBitrateMbps === 4)).toBe(true);
    expect(test.metricsFetch).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a slow metrics request or let concurrent observers reset its baseline", async () => {
    const test = harness();
    let resolve!: (response: Response) => void;
    test.metricsFetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = test.service.getLiveStatus("room");
    await vi.waitFor(() => expect(test.metricsFetch).toHaveBeenCalledTimes(1));
    test.set({ now: 2500 });
    const second = test.service.getLiveStatus("room");
    resolve(new Response(metrics("publisher", 1000, 10, 0)));
    expect(await first).toMatchObject({ sourceHealth: "unknown" });
    expect(await second).toMatchObject({ sourceHealth: "unknown" });
    expect(test.metricsFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["absent", "# missing metrics"],
    ["zero traffic", metrics("publisher", 0, 0, 0)],
    ["only reader", metrics("reader", 1000, 100, 0, "read")],
    ["other source", metrics("other", 1000, 100, 0)],
  ])("never reports healthy with %s metrics", async (_label, body) => {
    const test = harness();
    await test.service.getLiveStatus("room");
    test.set({ now: 2000, body });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "unknown",
      sourcePacketLossPercent: null,
    });
  });

  it("requires all counters and an authoritative source identity", async () => {
    const test = harness();
    await test.service.getLiveStatus("room");
    test.set({
      now: 2000,
      body: metrics("publisher", 1000, 100, 0)
        .split("\n")
        .slice(0, 2)
        .join("\n"),
    });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "unknown",
      sourcePacketLossPercent: null,
    });
    test.set({ now: 4000, source: { type: "webRTCSession" } });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      state: "online",
      sourceHealth: "unknown",
    });
    test.set({ now: 6000, source: { type: "rtmpConn", id: "publisher" } });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "unknown",
    });
  });

  it("resets after publisher replacement, rollback, long sample gaps and offline transitions", async () => {
    const test = harness();
    await test.service.getLiveStatus("room");
    test.set({ now: 2000, body: metrics("publisher", 1_000_000, 1000, 0) });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "good",
    });
    test.set({
      now: 4000,
      source: { type: "webRTCSession", id: "new-publisher" },
      body: metrics("new-publisher", 2_000_000, 2000, 0),
    });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "unknown",
    });
    test.set({ now: 6000, body: metrics("new-publisher", 1000, 1, 0) });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "unknown",
    });
    test.set({
      now: 22_000,
      body: metrics("new-publisher", 3_000_000, 3000, 0),
    });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "unknown",
    });
    test.set({ now: 24_000, ready: false });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      state: "offline",
    });
    test.set({ now: 26_000, ready: true });
    expect(await test.service.getLiveStatus("room")).toMatchObject({
      sourceHealth: "unknown",
    });
  });
});
