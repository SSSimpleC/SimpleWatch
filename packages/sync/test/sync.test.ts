import { describe, expect, it } from "vitest";

import {
  decideDriftCorrection,
  estimateClock,
  positionAt,
  selectBestClockEstimate,
  selectStableClockEstimate,
} from "../src/index.js";

describe("synchronization primitives", () => {
  it("estimates clock offset while excluding server processing time", () => {
    expect(
      estimateClock({
        clientSentAtMs: 1_000,
        serverReceivedAtMs: 1_060,
        serverSentAtMs: 1_070,
        clientReceivedAtMs: 1_120,
      }),
    ).toEqual({ offsetMs: 5, roundTripMs: 110 });
  });

  it("projects a running playback anchor", () => {
    const anchor = {
      effectiveAtMs: 10_000,
      mediaId: null,
      paused: false,
      positionSeconds: 5,
      rate: 1.5,
      revision: 1,
    } as const;
    expect(positionAt(anchor, 12_000)).toBe(8);
    expect(positionAt(anchor, 9_000)).toBe(5);
    expect(positionAt({ ...anchor, paused: true }, 12_000)).toBe(5);
  });

  it("selects the lowest latency clock estimate", () => {
    expect(selectBestClockEstimate([])).toBeNull();
    expect(
      selectBestClockEstimate([
        { offsetMs: 5, roundTripMs: 80 },
        { offsetMs: 7, roundTripMs: 20 },
      ]),
    ).toEqual({ offsetMs: 7, roundTripMs: 20 });
  });

  it("drops the two slowest samples and uses a median clock offset", () => {
    expect(selectStableClockEstimate([])).toBeNull();
    expect(
      selectStableClockEstimate([
        { offsetMs: 101, roundTripMs: 30 },
        { offsetMs: 100, roundTripMs: 20 },
        { offsetMs: 99, roundTripMs: 25 },
        { offsetMs: 2_000, roundTripMs: 500 },
        { offsetMs: -2_000, roundTripMs: 400 },
        { offsetMs: 102, roundTripMs: 35 },
        { offsetMs: 98, roundTripMs: 28 },
      ]),
    ).toEqual({ offsetMs: 100, roundTripMs: 28 });
    expect(
      selectStableClockEstimate([
        { offsetMs: 10, roundTripMs: 10 },
        { offsetMs: 14, roundTripMs: 20 },
        { offsetMs: 500, roundTripMs: 300 },
        { offsetMs: -500, roundTripMs: 400 },
      ]),
    ).toEqual({ offsetMs: 12, roundTripMs: 15 });
  });

  it("chooses no-op, soft-rate and hard-seek drift correction", () => {
    expect(decideDriftCorrection(0.1, 1)).toEqual({
      kind: "none",
      playbackRate: 1,
    });
    expect(decideDriftCorrection(0.3, 1)).toEqual({
      kind: "rate",
      playbackRate: 1.03,
    });
    expect(decideDriftCorrection(-0.3, 1)).toEqual({
      kind: "rate",
      playbackRate: 0.97,
    });
    expect(decideDriftCorrection(0.8, 1)).toEqual({
      kind: "seek",
      playbackRate: 1,
    });
  });
});
