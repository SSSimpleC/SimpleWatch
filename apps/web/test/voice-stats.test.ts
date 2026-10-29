import { describe, expect, it } from "vitest";
import { VoiceStatsAccumulator } from "../src/voice/stats.js";

function report(
  at: number,
  override: Record<string, unknown> = {},
): RTCStatsReport {
  return new Map([
    [
      "in",
      {
        id: "in",
        type: "inbound-rtp",
        kind: "audio",
        timestamp: at,
        bytesReceived: at * 12,
        packetsReceived: at / 20,
        packetsLost: at / 1000,
        jitter: 0.005,
        jitterBufferDelay: at / 1000,
        jitterBufferEmittedCount: at / 20,
        concealedSamples: at * 2,
        ...override,
      },
    ],
    [
      "out",
      {
        id: "out",
        type: "outbound-rtp",
        kind: "audio",
        timestamp: at,
        bytesSent: at * 12,
      },
    ],
    [
      "rtt",
      {
        id: "rtt",
        type: "remote-inbound-rtp",
        kind: "audio",
        timestamp: at,
        roundTripTime: 0.06,
      },
    ],
    [
      "video",
      {
        id: "video",
        type: "inbound-rtp",
        kind: "video",
        timestamp: at,
        bytesReceived: at * 10000,
      },
    ],
  ]) as unknown as RTCStatsReport;
}

describe("voice aggregate diagnostics", () => {
  it("measures audio-only interval bitrate, concealment and jitter without exporting identities", () => {
    const stats = new VoiceStatsAccumulator();
    expect(
      stats.sample([{ key: "secret-identity", report: report(0) }], 0)
        .receiveBitrateKbps,
    ).toBeNull();
    const result = stats.sample(
      [{ key: "secret-identity", report: report(1000) }],
      1000,
    );
    expect(result).toMatchObject({
      sendBitrateKbps: 96,
      receiveBitrateKbps: 96,
      jitterMs: 5,
      jitterBufferMs: 20,
      roundTripTimeMs: 60,
      concealedSamples: 2000,
    });
    expect(result.packetLossPercent).toBeCloseTo(100 / 51);
    expect(JSON.stringify(result)).not.toContain("secret-identity");
  });

  it("does not invent counters or use a retired track's history", () => {
    const stats = new VoiceStatsAccumulator();
    stats.sample([{ key: "old", report: report(0) }], 0);
    expect(
      stats.sample([{ key: "new", report: report(1000) }], 1000)
        .receiveBitrateKbps,
    ).toBeNull();
    stats.reset();
    expect(
      stats.sample([{ key: "new", report: report(2000) }], 2000)
        .sendBitrateKbps,
    ).toBeNull();
    expect(
      stats.sample(
        [
          {
            key: "new",
            report: report(3000, {
              bytesReceived: undefined,
              jitter: undefined,
              packetsLost: undefined,
            }),
          },
        ],
        3000,
      ),
    ).toMatchObject({
      receiveBitrateKbps: null,
      jitterMs: null,
      packetLossPercent: null,
    });
  });

  it("can report the selected ICE RTT for a pure listener without exposing candidate addresses", () => {
    const report = new Map([
      [
        "transport",
        {
          id: "transport",
          type: "transport",
          selectedCandidatePairId: "current",
        },
      ],
      [
        "current",
        {
          id: "current",
          type: "candidate-pair",
          currentRoundTripTime: 0.042,
          localCandidateId: "private-address",
        },
      ],
      [
        "unused",
        { id: "unused", type: "candidate-pair", currentRoundTripTime: 0.9 },
      ],
    ]) as unknown as RTCStatsReport;
    const result = new VoiceStatsAccumulator().sample(
      [{ key: "receiver", report }],
      0,
    );
    expect(result.roundTripTimeMs).toBe(42);
    expect(JSON.stringify(result)).not.toContain("private-address");
  });
});
