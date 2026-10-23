export type PlaybackComparison = "normal" | "native" | "host-only";

export function playbackComparisonLabel(mode: PlaybackComparison): string {
  if (mode === "native") return "A 原生播放 / 不参与同步";
  if (mode === "host-only") return "B 固定1× / 仅跟随Host指令";
  return "正常同步";
}

/** Position error is not network RTT, nor proof that a frame was presented. */
export function vodSyncSummary(driftSec: number | null | undefined): string {
  if (driftSec == null || !Number.isFinite(driftSec)) return "播放位置偏差待测";
  if (Math.abs(driftSec) > 0.5)
    return `${driftSec > 0 ? "落后" : "超前"}权威进度 ${Math.abs(driftSec).toFixed(2)}s，尚未同步`;
  return `播放位置偏差 ${Math.round(driftSec * 1000)} ms`;
}

export function allowsVodControl(mode: PlaybackComparison): boolean {
  return mode !== "native";
}

/** Diagnostics must not serialize sessionStorage data once per video frame. */
export class DiagnosticsWriteGate {
  private lastWriteAtMs = Number.NEGATIVE_INFINITY;

  public shouldWrite(nowMs: number): boolean {
    if (!Number.isFinite(nowMs) || nowMs - this.lastWriteAtMs < 1000)
      return false;
    this.lastWriteAtMs = nowMs;
    return true;
  }
}
