import { describe, expect, it, vi } from "vitest";

import { classifyViewerHealth, LiveStatsSampler } from "../src/live-stats.js";

function report(
  atMs: number,
  fields: Record<string, unknown> = {},
): RTCStatsReport {
  return new Map([
    [
      "video",
      {
        id: "video",
        type: "inbound-rtp",
        timestamp: atMs,
        kind: "video",
        ssrc: 1,
        bytesReceived: 100_000 + atMs * 500,
        packetsReceived: 100 + atMs,
        packetsLost: 0,
        framesReceived: 20 + atMs * 0.024,
        framesDecoded: 20 + atMs * 0.024,
        framesDropped: 0,
        jitterBufferDelay: 20 + atMs * 0.0012,
        jitterBufferEmittedCount: 100 + atMs * 0.024,
        jitter: 0.005,
        transportId: "transport",
        ...fields,
      },
    ],
    [
      "transport",
      { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
    ],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        localCandidateId: "local",
        currentRoundTripTime: 0.08,
      },
    ],
    ["local", { id: "local", type: "local-candidate", protocol: "udp" }],
  ]) as unknown as RTCStatsReport;
}

function context(
  atMs: number,
  generation = 1,
  renderedFrames: number | null = atMs * 0.024,
) {
  return { atMs, generation, renderedFrames };
}

describe("live statistics windows", () => {
  it("starts unknown, computes deltas and keeps healthy 24fps sources healthy", async () => {
    const sampler = new LiveStatsSampler();
    const peer = {
      getStats: vi
        .fn()
        .mockResolvedValueOnce(report(0))
        .mockResolvedValueOnce(report(1000)),
    };
    expect(await sampler.sample(peer, context(0))).toMatchObject({
      bitrateMbps: null,
      packetLossPercent: null,
      framesPerSecond: null,
      health: "unknown",
    });
    expect(await sampler.sample(peer, context(1000))).toMatchObject({
      bitrateMbps: 4,
      packetLossPercent: 0,
      receivedFramesPerSecond: 24,
      decodedFramesPerSecond: 24,
      renderedFramesPerSecond: 24,
      droppedFramesPerSecond: 0,
      framesPerSecond: 24,
      jitterMs: 5,
      rttMs: 80,
      protocol: "UDP",
      health: "good",
      videoDataGrowing: true,
    });
  });

  it("uses window jitter delay, not lifetime average", async () => {
    const sampler = new LiveStatsSampler();
    const peer = {
      getStats: vi
        .fn()
        .mockResolvedValueOnce(report(0))
        .mockResolvedValueOnce(report(1000)),
    };
    await sampler.sample(peer, context(0));
    expect(
      (await sampler.sample(peer, context(1000)))?.jitterBufferMs,
    ).toBeCloseTo(50);
  });

  it("does not turn missing counters into zero or pretend decode is rendered evidence", async () => {
    const sampler = new LiveStatsSampler();
    const fields = {
      packetsLost: undefined,
      framesDecoded: undefined,
      framesReceived: undefined,
      framesDropped: undefined,
      jitter: undefined,
      jitterBufferDelay: undefined,
    };
    const peer = {
      getStats: vi
        .fn()
        .mockResolvedValueOnce(report(0, fields))
        .mockResolvedValueOnce(report(1000, fields)),
    };
    await sampler.sample(peer, context(0, 1, null));
    expect(await sampler.sample(peer, context(1000, 1, null))).toMatchObject({
      packetLossPercent: null,
      framesPerSecond: null,
      receivedFramesPerSecond: null,
      decodedFramesPerSecond: null,
      renderedFramesPerSecond: null,
      droppedFramesPerSecond: null,
      jitterMs: null,
      jitterBufferMs: null,
      health: "unknown",
    });
  });

  it("labels actual zero frames as poor, not healthy", async () => {
    const sampler = new LiveStatsSampler();
    const peer = {
      getStats: vi
        .fn()
        .mockResolvedValueOnce(report(0))
        .mockResolvedValueOnce(report(1000)),
    };
    await sampler.sample(peer, context(0, 1, 20));
    expect(await sampler.sample(peer, context(1000, 1, 20))).toMatchObject({
      framesPerSecond: 0,
      decodedFramesPerSecond: 24,
      health: "poor",
    });
    expect(classifyViewerHealth(null, null, null)).toBe("unknown");
    expect(classifyViewerHealth(0, 80, 24)).toBe("good");
  });

  it.each([
    ["bytes counter rollback", { bytesReceived: 1 }, 1000, 1],
    ["decode counter rollback", { framesDecoded: 1 }, 1000, 1],
    ["SSRC replacement", { ssrc: 2 }, 1000, 1],
    ["sample gap", {}, 6000, 1],
    ["generation replacement", {}, 1000, 2],
  ])(
    "resets the complete baseline after %s",
    async (_label, fields, atMs, generation) => {
      const sampler = new LiveStatsSampler();
      const peer = {
        getStats: vi
          .fn()
          .mockResolvedValueOnce(report(0))
          .mockResolvedValueOnce(report(atMs, fields)),
      };
      await sampler.sample(peer, context(0));
      expect(
        await sampler.sample(peer, context(atMs, generation)),
      ).toMatchObject({
        bitrateMbps: null,
        packetLossPercent: null,
        framesPerSecond: null,
        health: "unknown",
      });
    },
  );

  it("samples at most once per second and never overlaps getStats", async () => {
    const sampler = new LiveStatsSampler();
    let resolve!: (value: RTCStatsReport) => void;
    const peer = {
      getStats: vi.fn(
        () =>
          new Promise<RTCStatsReport>((done) => {
            resolve = done;
          }),
      ),
    };
    const first = sampler.sample(peer, context(0));
    expect(await sampler.sample(peer, context(1000))).toBeNull();
    expect(peer.getStats).toHaveBeenCalledTimes(1);
    resolve(report(0));
    await first;
    expect(await sampler.sample(peer, context(500))).toBeNull();
    expect(peer.getStats).toHaveBeenCalledTimes(1);
  });

  it("discards a pending result after generation replacement", async () => {
    const sampler = new LiveStatsSampler();
    let resolve!: (value: RTCStatsReport) => void;
    const oldPeer = {
      getStats: vi.fn(
        () =>
          new Promise<RTCStatsReport>((done) => {
            resolve = done;
          }),
      ),
    };
    const newPeer = { getStats: vi.fn().mockResolvedValue(report(1000)) };
    const pending = sampler.sample(oldPeer, context(0));
    expect(await sampler.sample(newPeer, context(1000, 2))).toBeNull();
    resolve(report(0));
    expect(await pending).toBeNull();
    expect(await sampler.sample(newPeer, context(1000, 2))).toMatchObject({
      health: "unknown",
    });
    expect(newPeer.getStats).toHaveBeenCalledTimes(1);
  });

  it("resets after getStats rejection and ignores ambiguous inbound video", async () => {
    const sampler = new LiveStatsSampler();
    const ambiguous = report(2000);
    (ambiguous as unknown as Map<string, unknown>).set("other", {
      id: "other",
      type: "inbound-rtp",
      kind: "video",
    });
    const peer = {
      getStats: vi
        .fn()
        .mockResolvedValueOnce(report(0))
        .mockRejectedValueOnce(new Error("closed"))
        .mockResolvedValueOnce(ambiguous)
        .mockResolvedValueOnce(report(3000)),
    };
    await sampler.sample(peer, context(0));
    expect(await sampler.sample(peer, context(1000))).toBeNull();
    expect(await sampler.sample(peer, context(2000))).toBeNull();
    expect(await sampler.sample(peer, context(3000))).toMatchObject({
      health: "unknown",
    });
  });
});
