export interface FreezeObservation {
  readonly generation: string | number;
  readonly atMs: number;
  readonly foreground: boolean;
  readonly enabled: boolean;
  readonly started: boolean;
  readonly videoBytesReceived: number | null;
  readonly renderedFrames: number | null;
}

/** Keep one instance for the room lifetime; replacing a reader must not reset the retry budget. */
export class LiveFreezeRecovery {
  private previous: FreezeObservation | null = null;
  private stalledSince: number | null = null;
  private recoveries: number[] = [];

  public shouldRecover(current: FreezeObservation): boolean {
    const previous = this.previous;
    this.previous = current;
    const valid =
      previous !== null &&
      previous.generation === current.generation &&
      current.atMs > previous.atMs &&
      current.atMs - previous.atMs <= 2_500 &&
      current.foreground &&
      previous.foreground &&
      current.enabled &&
      previous.enabled &&
      current.started &&
      previous.started &&
      current.renderedFrames !== null &&
      previous.renderedFrames !== null &&
      current.videoBytesReceived !== null &&
      previous.videoBytesReceived !== null;
    if (
      !valid ||
      previous === null ||
      current.renderedFrames !== previous.renderedFrames ||
      current.videoBytesReceived <= previous.videoBytesReceived
    ) {
      this.stalledSince = null;
      return false;
    }
    this.stalledSince ??= previous.atMs;
    if (current.atMs - this.stalledSince < 3_000) return false;
    if (!this.requestRetry(current.atMs)) return false;
    this.stalledSince = null;
    return true;
  }

  /** The same budget covers explicit connection errors, avoiding two independent retry loops. */
  public requestRetry(atMs: number): boolean {
    this.recoveries = this.recoveries.filter(
      (time) => atMs >= time && atMs - time < 60_000,
    );
    if (this.recoveries.length >= 2) return false;
    this.recoveries.push(atMs);
    return true;
  }
}

export interface RenderedFrameObserver {
  getCount(): number | null;
  getMediaTime(): number | null;
  stop(): void;
}

/** Decode counters cannot prove that the browser actually presented a frame. */
export function observeRenderedFrames(
  video: HTMLVideoElement,
): RenderedFrameObserver {
  if (typeof video.requestVideoFrameCallback !== "function")
    return {
      getCount: () => null,
      getMediaTime: () => null,
      stop: () => undefined,
    };
  let stopped = false;
  let count = 0;
  let mediaTime: number | null = null;
  let handle = 0;
  const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
    if (stopped) return;
    // presentedFrames includes frames missed while JS was busy; counting callbacks alone undercounts.
    count = metadata.presentedFrames;
    mediaTime = metadata.mediaTime;
    handle = video.requestVideoFrameCallback(onFrame);
  };
  handle = video.requestVideoFrameCallback(onFrame);
  return {
    getCount: () => count,
    getMediaTime: () => mediaTime,
    stop: () => {
      stopped = true;
      if (typeof video.cancelVideoFrameCallback === "function")
        video.cancelVideoFrameCallback(handle);
    },
  };
}
