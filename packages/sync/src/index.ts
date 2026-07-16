import type { PlaybackAnchor } from "@simplewatch/contracts";

export interface ClockSample {
  readonly clientSentAtMs: number;
  readonly serverReceivedAtMs: number;
  readonly serverSentAtMs: number;
  readonly clientReceivedAtMs: number;
}

export interface ClockEstimate {
  readonly offsetMs: number;
  readonly roundTripMs: number;
}

export interface DriftCorrection {
  readonly kind: "none" | "rate" | "seek";
  readonly playbackRate: number;
}

export function estimateClock(sample: ClockSample): ClockEstimate {
  const roundTripMs =
    sample.clientReceivedAtMs -
    sample.clientSentAtMs -
    (sample.serverSentAtMs - sample.serverReceivedAtMs);
  const offsetMs =
    (sample.serverReceivedAtMs -
      sample.clientSentAtMs +
      sample.serverSentAtMs -
      sample.clientReceivedAtMs) /
    2;

  return { offsetMs, roundTripMs: Math.max(0, roundTripMs) };
}

export function positionAt(
  anchor: PlaybackAnchor,
  serverNowMs: number,
): number {
  if (anchor.paused || serverNowMs <= anchor.effectiveAtMs)
    return anchor.positionSeconds;

  const elapsedSeconds = (serverNowMs - anchor.effectiveAtMs) / 1000;
  return Math.max(0, anchor.positionSeconds + elapsedSeconds * anchor.rate);
}

export function selectBestClockEstimate(
  samples: readonly ClockEstimate[],
): ClockEstimate | null {
  if (samples.length === 0) return null;
  return samples.reduce((best, current) =>
    current.roundTripMs < best.roundTripMs ? current : best,
  );
}

/**
 * Build a stable clock estimate from the initial burst of samples. The two
 * slowest paths are ignored since asymmetric queueing is the largest source
 * of error for a tiny private room; the median of the remainder prevents one
 * lucky-but-skewed packet from becoming authoritative.
 */
export function selectStableClockEstimate(
  samples: readonly ClockEstimate[],
): ClockEstimate | null {
  if (samples.length === 0) return null;
  const retained = [...samples]
    .sort((left, right) => left.roundTripMs - right.roundTripMs)
    .slice(0, Math.max(1, samples.length - 2));
  const offsets = retained
    .map((sample) => sample.offsetMs)
    .sort((left, right) => left - right);
  const roundTrips = retained
    .map((sample) => sample.roundTripMs)
    .sort((left, right) => left - right);
  return {
    offsetMs: median(offsets),
    roundTripMs: median(roundTrips),
  };
}

export function decideDriftCorrection(
  driftSeconds: number,
  baseRate: number,
): DriftCorrection {
  const absoluteDrift = Math.abs(driftSeconds);
  if (absoluteDrift <= 0.12) return { kind: "none", playbackRate: baseRate };
  if (absoluteDrift > 0.5) return { kind: "seek", playbackRate: baseRate };
  const adjustment = driftSeconds > 0 ? 0.03 : -0.03;
  return {
    kind: "rate",
    playbackRate: Math.max(0.5, Math.min(2, baseRate * (1 + adjustment))),
  };
}

function median(values: readonly number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1]! + values[middle]!) / 2
    : values[middle]!;
}
