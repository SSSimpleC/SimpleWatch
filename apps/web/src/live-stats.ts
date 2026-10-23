export type LiveHealth = "good" | "degraded" | "poor" | "unknown";

export interface LiveViewerStats {
  readonly bitrateMbps: number | null;
  readonly packetLossPercent: number | null;
  readonly rttMs: number | null;
  readonly jitterMs: number | null;
  readonly jitterBufferMs: number | null;
  /** Actual render rate when available, otherwise decoded rate; never an assumed source FPS. */
  readonly framesPerSecond: number | null;
  readonly receivedFramesPerSecond: number | null;
  readonly decodedFramesPerSecond: number | null;
  readonly droppedFramesPerSecond: number | null;
  readonly renderedFramesPerSecond: number | null;
  readonly videoBytesReceived: number | null;
  readonly videoDataGrowing: boolean;
  readonly protocol: string;
  readonly health: LiveHealth;
}

export interface LiveSampleContext {
  readonly generation: string | number;
  readonly atMs: number;
  readonly renderedFrames: number | null;
}

interface Sample {
  readonly id: string;
  readonly atMs: number;
  readonly renderedAtMs: number;
  readonly bytes: number | null;
  readonly packets: number | null;
  readonly lost: number | null;
  readonly received: number | null;
  readonly decoded: number | null;
  readonly dropped: number | null;
  readonly rendered: number | null;
  readonly bufferDelay: number | null;
  readonly emitted: number | null;
}

type StatsPeer = Pick<RTCPeerConnection, "getStats">;
type ReportEntry = RTCStats & Record<string, unknown>;

/** One request in flight, including across reader replacement. Late results cannot publish. */
export class LiveStatsSampler {
  private peer: StatsPeer | null = null;
  private generation: LiveSampleContext["generation"] | null = null;
  private epoch = 0;
  private busy = false;
  private previous: Sample | null = null;
  private attemptedAtMs: number | null = null;

  public reset(): void {
    this.epoch += 1;
    this.peer = null;
    this.generation = null;
    this.previous = null;
    this.attemptedAtMs = null;
  }

  public async sample(
    peer: StatsPeer,
    context: LiveSampleContext,
  ): Promise<LiveViewerStats | null> {
    if (this.peer !== peer || this.generation !== context.generation) {
      this.reset();
      this.peer = peer;
      this.generation = context.generation;
    }
    if (this.busy) return null;
    if (
      this.attemptedAtMs !== null &&
      context.atMs >= this.attemptedAtMs &&
      context.atMs - this.attemptedAtMs < 1_000
    )
      return null;
    this.attemptedAtMs = context.atMs;
    this.busy = true;
    const epoch = this.epoch;
    try {
      const report = await peer.getStats();
      if (epoch !== this.epoch) return null;
      return this.consume(report, context);
    } catch {
      if (epoch === this.epoch) this.previous = null;
      return null;
    } finally {
      this.busy = false;
    }
  }

  private consume(
    report: RTCStatsReport,
    context: LiveSampleContext,
  ): LiveViewerStats | null {
    const videos: ReportEntry[] = [];
    report.forEach((raw) => {
      const entry = raw as ReportEntry;
      if (
        entry.type === "inbound-rtp" &&
        (entry.kind === "video" || entry.mediaType === "video") &&
        entry.isRemote !== true
      )
        videos.push(entry);
    });
    // The program carries exactly one video track. An ambiguous report is not evidence.
    if (videos.length !== 1) {
      this.previous = null;
      return null;
    }
    const video = videos[0]!;
    const sample: Sample = {
      id: `${video.id}:${typeof video.ssrc === "number" || typeof video.ssrc === "string" ? video.ssrc : ""}`,
      atMs: finite(video.timestamp) ?? context.atMs,
      renderedAtMs: context.atMs,
      bytes: finite(video.bytesReceived),
      packets: finite(video.packetsReceived),
      lost: finite(video.packetsLost),
      received: finite(video.framesReceived),
      decoded: finite(video.framesDecoded),
      dropped: finite(video.framesDropped),
      rendered: finite(context.renderedFrames),
      bufferDelay: finite(video.jitterBufferDelay),
      emitted: finite(video.jitterBufferEmittedCount),
    };
    const previous = this.previous;
    this.previous = sample;
    const elapsed = previous ? (sample.atMs - previous.atMs) / 1000 : 0;
    const elapsedRender = previous
      ? (sample.renderedAtMs - previous.renderedAtMs) / 1000
      : 0;
    const valid =
      previous !== null &&
      previous.id === sample.id &&
      elapsed > 0 &&
      elapsed <= 5 &&
      elapsedRender > 0 &&
      elapsedRender <= 5 &&
      !countersReset(sample, previous);
    const delta = (key: keyof Omit<Sample, "id" | "atMs" | "renderedAtMs">) =>
      valid ? counterDelta(sample[key], previous[key]) : null;
    const bytes = delta("bytes");
    const received = delta("packets");
    const lost = delta("lost");
    const decodedFramesPerSecond = rate(delta("decoded"), elapsed);
    const renderedFramesPerSecond = rate(delta("rendered"), elapsedRender);
    const bufferDelay = delta("bufferDelay");
    const emitted = delta("emitted");
    const pair = selectedPair(report, video);
    const candidateId = pair?.localCandidateId;
    const candidate =
      typeof candidateId === "string"
        ? (report.get(candidateId) as ReportEntry | undefined)
        : undefined;
    const protocol =
      typeof candidate?.protocol === "string"
        ? candidate.protocol.toUpperCase()
        : "unknown";
    const packetLossPercent =
      received !== null && lost !== null && received + lost > 0
        ? (lost / (received + lost)) * 100
        : null;
    const rtt = finite(pair?.currentRoundTripTime);
    const jitter = finite(video.jitter);
    const framesPerSecond = renderedFramesPerSecond ?? decodedFramesPerSecond;
    const dropped = delta("dropped");
    const decoded = delta("decoded");
    return {
      bitrateMbps: bytes === null ? null : (bytes * 8) / elapsed / 1_000_000,
      packetLossPercent,
      rttMs: rtt === null ? null : rtt * 1000,
      jitterMs: jitter === null ? null : jitter * 1000,
      jitterBufferMs:
        emitted !== null && emitted > 0 && bufferDelay !== null
          ? (bufferDelay / emitted) * 1000
          : null,
      framesPerSecond,
      receivedFramesPerSecond: rate(delta("received"), elapsed),
      decodedFramesPerSecond,
      droppedFramesPerSecond: rate(dropped, elapsed),
      renderedFramesPerSecond,
      videoBytesReceived: sample.bytes,
      videoDataGrowing: bytes !== null && bytes > 0,
      protocol,
      health: classifyViewerHealth(
        packetLossPercent,
        rtt === null ? null : rtt * 1000,
        framesPerSecond,
        dropped !== null && decoded !== null && decoded + dropped > 0
          ? dropped / (decoded + dropped)
          : null,
      ),
    };
  }
}

/** FPS has no universal 27 FPS threshold: a healthy 24 FPS source is valid. */
export function classifyViewerHealth(
  loss: number | null,
  rttMs: number | null,
  framesPerSecond: number | null,
  droppedFraction: number | null = null,
): LiveHealth {
  if (
    (loss !== null && loss > 3) ||
    (rttMs !== null && rttMs > 400) ||
    framesPerSecond === 0 ||
    (droppedFraction !== null && droppedFraction > 0.2)
  )
    return "poor";
  if (
    (loss !== null && loss > 1) ||
    (rttMs !== null && rttMs > 250) ||
    (droppedFraction !== null && droppedFraction > 0.05)
  )
    return "degraded";
  return loss !== null && rttMs !== null && framesPerSecond !== null
    ? "good"
    : "unknown";
}

function selectedPair(
  report: RTCStatsReport,
  video: ReportEntry,
): ReportEntry | null {
  const transport =
    typeof video.transportId === "string"
      ? (report.get(video.transportId) as ReportEntry | undefined)
      : undefined;
  let selected = transport?.selectedCandidatePairId;
  if (typeof selected !== "string") {
    const ids: string[] = [];
    report.forEach((entry: ReportEntry) => {
      if (
        entry.type === "transport" &&
        typeof entry.selectedCandidatePairId === "string"
      )
        ids.push(entry.selectedCandidatePairId);
    });
    if (new Set(ids).size === 1) selected = ids[0];
  }
  const pair =
    typeof selected === "string"
      ? (report.get(selected) as ReportEntry | undefined)
      : undefined;
  return pair?.type === "candidate-pair" ? pair : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function counterDelta(
  current: number | null,
  previous: number | null,
): number | null {
  return current !== null && previous !== null && current >= previous
    ? current - previous
    : null;
}

function rate(delta: number | null, elapsed: number): number | null {
  return delta !== null && elapsed > 0 ? delta / elapsed : null;
}

function countersReset(current: Sample, previous: Sample): boolean {
  const keys = [
    "bytes",
    "packets",
    "lost",
    "received",
    "decoded",
    "dropped",
    "rendered",
    "bufferDelay",
    "emitted",
  ] as const;
  return keys.some(
    (key) =>
      current[key] !== null &&
      previous[key] !== null &&
      current[key] < previous[key],
  );
}
