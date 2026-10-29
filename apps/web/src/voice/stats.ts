export interface VoiceStatsSample {
  sendBitrateKbps: number | null;
  receiveBitrateKbps: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  concealedSamples: number | null;
  roundTripTimeMs: number | null;
  sampledAtMs: number | null;
}

interface AudioStatsRow {
  id: string;
  type: string;
  kind?: string;
  mediaType?: string;
  timestamp: number;
  bytesSent?: number;
  bytesReceived?: number;
  packetsReceived?: number;
  packetsLost?: number;
  jitter?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  concealedSamples?: number;
  roundTripTime?: number;
  selectedCandidatePairId?: string;
  currentRoundTripTime?: number;
  nominated?: boolean;
  state?: string;
}

export const emptyVoiceStats: VoiceStatsSample = {
  sendBitrateKbps: null,
  receiveBitrateKbps: null,
  packetLossPercent: null,
  jitterMs: null,
  jitterBufferMs: null,
  concealedSamples: null,
  roundTripTimeMs: null,
  sampledAtMs: null,
};

function delta(
  current: number | undefined,
  previous: number | undefined,
): number | null {
  if (
    current === undefined ||
    previous === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  )
    return null;
  return current >= previous ? current - previous : null;
}

/** Only aggregate measurements leave this class; no SDP, token, device or participant identifiers. */
export class VoiceStatsAccumulator {
  private previous = new Map<string, AudioStatsRow>();

  sample(
    reports: Array<{ key: string; report: RTCStatsReport }>,
    sampledAtMs: number,
  ): VoiceStatsSample {
    const next = new Map<string, AudioStatsRow>();
    let sent = 0;
    let received = 0;
    let hasSent = false;
    let hasReceived = false;
    let receivedPackets = 0;
    let lostPackets = 0;
    let hasPackets = false;
    const jitters: number[] = [];
    const rtts: number[] = [];
    const transportRtts: number[] = [];
    let bufferDelay = 0;
    let emitted = 0;
    let concealed = 0;
    let hasConcealed = false;
    for (const { key, report } of reports) {
      const selectedPairs = new Set<string>();
      report.forEach((raw) => {
        const row = raw as AudioStatsRow;
        if (row.type === "transport" && row.selectedCandidatePairId)
          selectedPairs.add(row.selectedCandidatePairId);
      });
      report.forEach((raw) => {
        const row = raw as AudioStatsRow;
        if (
          row.type === "candidate-pair" &&
          (selectedPairs.has(row.id) ||
            (selectedPairs.size === 0 &&
              row.nominated === true &&
              row.state === "succeeded")) &&
          row.currentRoundTripTime !== undefined &&
          Number.isFinite(row.currentRoundTripTime)
        )
          transportRtts.push(row.currentRoundTripTime * 1000);
        if (row.kind !== "audio" && row.mediaType !== "audio") return;
        const id = `${key}:${row.id}`;
        if (next.has(id)) return;
        next.set(id, row);
        const previous = this.previous.get(id);
        const elapsed = previous ? row.timestamp - previous.timestamp : 0;
        if (row.type === "outbound-rtp" && elapsed > 0) {
          const bytes = delta(row.bytesSent, previous?.bytesSent);
          if (bytes !== null) {
            sent += (bytes * 8) / elapsed;
            hasSent = true;
          }
        }
        if (row.type === "inbound-rtp") {
          if (elapsed > 0) {
            const bytes = delta(row.bytesReceived, previous?.bytesReceived);
            if (bytes !== null) {
              received += (bytes * 8) / elapsed;
              hasReceived = true;
            }
            const packets = delta(
              row.packetsReceived,
              previous?.packetsReceived,
            );
            const loss = delta(row.packetsLost, previous?.packetsLost);
            if (packets !== null && loss !== null) {
              receivedPackets += packets;
              lostPackets += loss;
              hasPackets = true;
            }
            const delay = delta(
              row.jitterBufferDelay,
              previous?.jitterBufferDelay,
            );
            const count = delta(
              row.jitterBufferEmittedCount,
              previous?.jitterBufferEmittedCount,
            );
            if (delay !== null && count !== null && count > 0) {
              bufferDelay += delay;
              emitted += count;
            }
            const hidden = delta(
              row.concealedSamples,
              previous?.concealedSamples,
            );
            if (hidden !== null) {
              concealed += hidden;
              hasConcealed = true;
            }
          }
          if (row.jitter !== undefined && Number.isFinite(row.jitter))
            jitters.push(row.jitter * 1000);
        }
        if (
          row.type === "remote-inbound-rtp" &&
          row.roundTripTime !== undefined &&
          Number.isFinite(row.roundTripTime)
        ) {
          rtts.push(row.roundTripTime * 1000);
        }
      });
    }
    this.previous = next;
    return {
      sendBitrateKbps: hasSent ? sent : null,
      receiveBitrateKbps: hasReceived ? received : null,
      packetLossPercent:
        hasPackets && receivedPackets + lostPackets > 0
          ? (lostPackets / (receivedPackets + lostPackets)) * 100
          : null,
      jitterMs: jitters.length ? Math.max(...jitters) : null,
      jitterBufferMs: emitted > 0 ? (bufferDelay / emitted) * 1000 : null,
      concealedSamples: hasConcealed ? concealed : null,
      roundTripTimeMs: rtts.length
        ? Math.max(...rtts)
        : transportRtts.length
          ? Math.max(...transportRtts)
          : null,
      sampledAtMs,
    };
  }

  reset(): void {
    this.previous.clear();
  }
}
