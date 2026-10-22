import { describe, expect, it, vi } from "vitest";
import {
  LiveFreezeRecovery,
  observeRenderedFrames,
  type FreezeObservation,
} from "../src/live-playback.js";

function observation(
  atMs: number,
  overrides: Partial<FreezeObservation> = {},
): FreezeObservation {
  return {
    generation: 1,
    atMs,
    foreground: true,
    enabled: true,
    started: true,
    videoBytesReceived: atMs * 100 + 1,
    renderedFrames: 30,
    ...overrides,
  };
}

describe("bounded live freeze recovery", () => {
  it("requires three seconds of actual video data growth without presentation", () => {
    const detector = new LiveFreezeRecovery();
    for (const atMs of [0, 1000, 2000])
      expect(detector.shouldRecover(observation(atMs))).toBe(false);
    expect(detector.shouldRecover(observation(3000))).toBe(true);
  });

  it.each([
    { foreground: false },
    { enabled: false },
    { started: false },
    { renderedFrames: null },
    { videoBytesReceived: null },
    { videoBytesReceived: 123 },
  ])(
    "does not treat unavailable/suspended playback as a freeze: %j",
    (overrides) => {
      const detector = new LiveFreezeRecovery();
      for (const atMs of [0, 1000, 2000, 3000, 4000])
        expect(detector.shouldRecover(observation(atMs, overrides))).toBe(
          false,
        );
    },
  );

  it("never recovers merely low FPS and resets after foreground/sample gaps", () => {
    const detector = new LiveFreezeRecovery();
    for (const atMs of [0, 1000, 2000, 3000, 4000])
      expect(
        detector.shouldRecover(
          observation(atMs, { renderedFrames: atMs / 1000 }),
        ),
      ).toBe(false);
    detector.shouldRecover(observation(5000, { foreground: false }));
    expect(detector.shouldRecover(observation(9000))).toBe(false);
    expect(detector.shouldRecover(observation(10000))).toBe(false);
  });

  it("shares two retries per minute across errors and reader generations", () => {
    const detector = new LiveFreezeRecovery();
    expect(detector.requestRetry(0)).toBe(true);
    for (const atMs of [1000, 2000, 3000])
      detector.shouldRecover(observation(atMs));
    expect(detector.shouldRecover(observation(4000))).toBe(true);
    for (const atMs of [5000, 6000, 7000, 8000, 9000])
      expect(detector.shouldRecover(observation(atMs, { generation: 2 }))).toBe(
        false,
      );
    expect(detector.requestRetry(10_000)).toBe(false);
    expect(detector.requestRetry(60_000)).toBe(true);
  });
});

describe("presented frame observer", () => {
  it("uses presentedFrames/mediaTime rather than callback count and cancels on stop", () => {
    let callback!: VideoFrameRequestCallback;
    const video = {
      requestVideoFrameCallback: vi.fn((value: VideoFrameRequestCallback) => {
        callback = value;
        return 12;
      }),
      cancelVideoFrameCallback: vi.fn(),
    };
    const observer = observeRenderedFrames(
      video as unknown as HTMLVideoElement,
    );
    callback(100, {
      presentedFrames: 25,
      mediaTime: 0.9,
    } as VideoFrameCallbackMetadata);
    expect(observer.getCount()).toBe(25);
    expect(observer.getMediaTime()).toBe(0.9);
    const pending = callback;
    observer.stop();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(12);
    pending(200, {
      presentedFrames: 30,
      mediaTime: 1.1,
    } as VideoFrameCallbackMetadata);
    expect(observer.getCount()).toBe(25);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
  });

  it("does not use decoded frames as evidence on browsers lacking rVFC", () => {
    const video = {
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 999 }),
    };
    const observer = observeRenderedFrames(
      video as unknown as HTMLVideoElement,
    );
    expect(observer.getCount()).toBeNull();
    expect(observer.getMediaTime()).toBeNull();
    observer.stop();
  });
});
