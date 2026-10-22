import { describe, expect, it, vi } from "vitest";

import {
  MonotonicServerClock,
  VodPlaybackController,
  type VodMediaState,
  type VodPresentedFrame,
  type VodSnapshot,
} from "../src/vod-controller.js";

type MutableMedia = { -readonly [K in keyof VodMediaState]: VodMediaState[K] };

function fixture(options: { supported?: boolean; metadata?: boolean } = {}) {
  let now = 0;
  const media: MutableMedia = {
    currentTime: 0,
    duration: 300,
    readyState: options.metadata === false ? 0 : 4,
    seeking: false,
    paused: true,
    playbackRate: 1,
    bufferedAheadSec: 30,
    frameEvidenceSupported: options.supported ?? true,
    frame: { mediaTime: 0, presentedFrames: 1 },
  };
  const seek = vi.fn((position: number) => {
    media.currentTime = position;
    media.seeking = true;
  });
  const play = vi.fn<() => Promise<void> | void>(() => {
    media.paused = false;
  });
  const pause = vi.fn(() => {
    media.paused = true;
  });
  const setPrimingMuted = vi.fn();
  const clock = new MonotonicServerClock(() => now, 100_000);
  const controller = new VodPlaybackController({
    media: {
      read: () => ({ ...media }),
      seek,
      play,
      pause,
      setPrimingMuted,
      setPlaybackRate: (rate) => {
        media.playbackRate = rate;
      },
    },
    clock,
  });
  controller.setEnabled(true);
  function snapshot(
    revision: number,
    positionSec: number,
    state: "playing" | "paused" = "paused",
    delay = 0,
    commandKind?: string,
    commandId?: string,
  ): VodSnapshot {
    return {
      revision,
      mediaId: "film",
      transport: {
        state,
        positionSec,
        rate: 1,
        anchoredAtServerMs: clock.serverNowMs() + delay,
      },
      ...(commandKind ? { commandKind } : {}),
      ...(commandId ? { commandId } : {}),
    };
  }
  function frame(
    position: number,
    count = (media.frame?.presentedFrames ?? 0) + 1,
  ) {
    const next: VodPresentedFrame = {
      mediaTime: position,
      presentedFrames: count,
    };
    media.frame = next;
    controller.notifyMediaEvent("frame", next);
  }
  function finish(position = media.currentTime) {
    media.currentTime = position;
    media.seeking = false;
    controller.notifyMediaEvent("seeked");
    frame(position);
  }
  function advance(ms: number) {
    now += ms;
    controller.tick();
  }
  return {
    controller,
    media,
    seek,
    play,
    pause,
    setPrimingMuted,
    clock,
    snapshot,
    frame,
    finish,
    advance,
  };
}

describe("VOD playback controller", () => {
  it.each(["playing", "paused"] as const)(
    "does not let an enable gesture play before the first %s anchor is effective",
    (state) => {
      const f = fixture();
      f.controller.setEnabled(false);
      f.controller.acceptSnapshot(f.snapshot(1, 42, state, 750, "seek"));
      f.controller.userPlay();
      expect(f.play).not.toHaveBeenCalled();
      expect(f.media.paused).toBe(true);
      f.advance(749);
      expect(f.seek).not.toHaveBeenCalled();
      expect(f.play).not.toHaveBeenCalled();
      f.advance(1);
      expect(f.seek).toHaveBeenCalledExactlyOnceWith(42);
      expect(f.play).toHaveBeenCalledTimes(state === "playing" ? 1 : 0);
    },
  );

  it("primes a fresh paused seek only on a real gesture and pauses on the matching frame", async () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 42));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    expect(f.play).not.toHaveBeenCalled();
    f.play.mockImplementationOnce(() => {
      expect(f.setPrimingMuted).toHaveBeenLastCalledWith(true);
      f.media.paused = false;
      return Promise.resolve();
    });
    f.controller.userPlay();
    await Promise.resolve();
    expect(f.media.paused).toBe(false);
    f.frame(0);
    expect(f.media.paused).toBe(false);
    expect(f.controller.getStatus().frameEvidence).toBe("pending");
    f.media.currentTime = 42.03;
    f.frame(42.03);
    expect(f.media.paused).toBe(true);
    expect(f.setPrimingMuted.mock.calls).toEqual([[true], [false]]);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      frameEvidence: "verified",
      presentedTimeSec: 42.03,
    });
    f.advance(5_000);
    expect(f.play).toHaveBeenCalledTimes(1);
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("does not restart playback for an already verified paused frame", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 0));
    f.controller.userPlay();
    expect(f.play).not.toHaveBeenCalled();
    expect(f.setPrimingMuted).not.toHaveBeenCalled();
  });

  it.each(["playing", "paused"] as const)(
    "does not restart a film at EOF when enabling a %s snapshot",
    (state) => {
      const f = fixture();
      f.controller.acceptSnapshot(f.snapshot(1, 300, state));
      f.play.mockClear();
      f.controller.userPlay();
      expect(f.play).not.toHaveBeenCalled();
      expect(f.setPrimingMuted).not.toHaveBeenCalled();
    },
  );

  it("bounds paused priming to one play and three seconds without pretending seeked is a frame", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 42));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    f.controller.userPlay();
    f.controller.userPlay();
    f.advance(2_999);
    expect(f.media.paused).toBe(false);
    f.advance(1);
    expect(f.media.paused).toBe(true);
    expect(f.setPrimingMuted).toHaveBeenLastCalledWith(false);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      error: "paused-frame-not-presented",
      frameEvidence: "pending",
    });
    f.advance(20_000);
    expect(f.play).toHaveBeenCalledTimes(1);
  });

  it.each(["hidden", "disabled", "reset", "revision", "media-error"])(
    "cancels paused priming and restores sound on %s",
    (reason) => {
      const f = fixture();
      f.controller.acceptSnapshot(f.snapshot(1, 42));
      f.controller.userPlay();
      expect(f.media.paused).toBe(false);
      if (reason === "hidden") f.controller.setVisible(false);
      if (reason === "disabled") f.controller.setEnabled(false);
      if (reason === "reset") f.controller.reset();
      if (reason === "revision") f.controller.acceptSnapshot(f.snapshot(2, 16));
      if (reason === "media-error") f.controller.notifyMediaEvent("error");
      expect(f.media.paused).toBe(true);
      expect(f.setPrimingMuted.mock.calls).toEqual([[true], [false]]);
      expect(f.controller.getStatus().frameEvidence).not.toBe("verified");
    },
  );

  it("does not hide autoplay denial while priming a paused frame", async () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 42));
    f.play.mockRejectedValueOnce(
      new DOMException("gesture", "NotAllowedError"),
    );
    f.controller.userPlay();
    await Promise.resolve();
    expect(f.media.paused).toBe(true);
    expect(f.setPrimingMuted).toHaveBeenLastCalledWith(false);
    expect(f.controller.getStatus().phase).toBe("autoplay-blocked");
  });

  it("decodes a missing paused frame once without treating seeked as visual proof", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 42, "paused"));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    f.advance(1499);
    expect(f.seek).toHaveBeenCalledTimes(1);
    expect(f.controller.getStatus().frameEvidence).toBe("pending");
    f.advance(1);
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(42);
    expect(f.play).toHaveBeenCalledTimes(1);
    expect(f.setPrimingMuted).toHaveBeenLastCalledWith(true);
    expect(f.controller.getStatus().frameEvidence).toBe("pending");
    f.finish(42);
    expect(f.media.paused).toBe(true);
    expect(f.setPrimingMuted).toHaveBeenLastCalledWith(false);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      frameEvidence: "verified",
      activeRevision: 1,
    });
  });

  it("does not extend the paused-frame deadline or exceed one compensation", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 42, "paused"));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    f.advance(1500);
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    for (let index = 0; index < 17; index += 1) f.advance(500);
    expect(f.seek).toHaveBeenCalledTimes(1);
    expect(f.play).toHaveBeenCalledTimes(1);
    expect(f.media.paused).toBe(true);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      error: "paused-frame-not-presented",
      frameEvidence: "pending",
    });
  });

  it("never primes an unobservable paused frame when rVFC is unavailable", () => {
    const f = fixture({ supported: false });
    f.controller.acceptSnapshot(f.snapshot(1, 42));
    f.controller.userPlay();
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    f.advance(5000);
    expect(f.play).not.toHaveBeenCalled();
    expect(f.setPrimingMuted).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      frameEvidence: "unavailable",
    });
  });

  it("keeps the old anchor until the future seek is effective", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(0, 0));
    f.controller.acceptSnapshot(f.snapshot(1, 0, "playing"));
    f.controller.acceptSnapshot(
      f.snapshot(2, 20, "playing", 750, "seek", "jump"),
    );
    f.media.currentTime = 0.5;
    f.frame(0.5);
    f.advance(500);
    expect(f.seek).not.toHaveBeenCalled();
    expect(f.controller.getStatus().targetSec).toBe(0.5);
    f.advance(250);
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(20);
  });

  it("labels old verified frames with the active revision until a future seek actually takes effect", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(3, 0));
    f.controller.acceptSnapshot(
      f.snapshot(4, 40, "paused", 750, "seek", "future-jump"),
    );
    f.frame(0);
    f.advance(749);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 3,
      mediaId: "film",
      phase: "paused",
      targetSec: 0,
      frameEvidence: "verified",
    });

    f.advance(1);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 4,
      mediaId: "film",
      phase: "seeking",
      targetSec: 40,
      frameEvidence: "pending",
    });
    f.finish(40);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 4,
      mediaId: "film",
      phase: "paused",
      frameEvidence: "verified",
      presentedTimeSec: 40,
    });
  });

  it("keeps an earlier due seek when a later pause is also queued", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(0, 0));
    f.controller.acceptSnapshot(f.snapshot(1, 20, "playing", 750, "seek"));
    f.controller.acceptSnapshot(f.snapshot(2, 20.25, "paused", 1_000, "pause"));
    f.advance(750);
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(20);
    f.advance(250);
    expect(f.media.paused).toBe(true);
    expect(f.seek).toHaveBeenCalledTimes(1);
  });

  it("does not restart a slow seek every 500ms and requires actual playback frames", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 20, "playing", 0, "seek"));
    f.advance(500);
    f.advance(500);
    f.advance(500);
    expect(f.seek).toHaveBeenCalledTimes(1);
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    expect(f.controller.getStatus().phase).not.toBe("playing");
    f.media.currentTime = 20.04;
    f.frame(20.04);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "playing",
      frameEvidence: "verified",
    });
    expect(f.seek).toHaveBeenCalledTimes(1);
    f.advance(2_000);
    f.media.currentTime = 22.04;
    f.controller.tick();
    expect(f.media.playbackRate).toBeLessThanOrEqual(1.1);
  });

  it("does not claim paused seek success from currentTime, seeked, or the wrong frame", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 40, "paused", 0, "seek"));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    expect(f.controller.getStatus().frameEvidence).toBe("pending");
    f.frame(0);
    expect(f.controller.getStatus().phase).not.toBe("paused");
    f.frame(40);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      frameEvidence: "verified",
      presentedTimeSec: 40,
    });
  });

  it("does not treat repeated callback counts as new presented frames", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 10, "paused", 0, "seek"));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    f.frame(10, 1);
    f.frame(10, 1);
    expect(f.controller.getStatus().frameEvidence).toBe("pending");
    f.frame(10, 2);
    expect(f.controller.getStatus().frameEvidence).toBe("verified");
  });

  it("reports unavailable evidence when the browser cannot expose frame presentation", () => {
    const f = fixture({ supported: false });
    f.media.frame = null;
    f.controller.acceptSnapshot(f.snapshot(1, 10, "paused", 0, "seek"));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 1,
      mediaId: "film",
      phase: "paused",
      frameEvidence: "unavailable",
    });
  });

  it("completes and advances a seek without frame callbacks while retaining unavailable evidence", () => {
    const f = fixture({ supported: false });
    f.media.frame = null;
    f.controller.acceptSnapshot(f.snapshot(7, 15, "playing", 0, "seek"));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    expect(f.controller.getStatus().phase).not.toBe("playing");

    f.media.currentTime = 15.04;
    f.controller.notifyMediaEvent("playing");
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 7,
      mediaId: "film",
      phase: "playing",
      intentId: null,
      frameEvidence: "unavailable",
      presentedTimeSec: null,
    });
    f.media.currentTime = 16;
    f.advance(1_000);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 7,
      mediaId: "film",
      phase: "playing",
      targetSec: 16,
      frameEvidence: "unavailable",
    });
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(15);
  });

  it("clears the active media and revision on reset even when an old frame remains in the adapter", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(5, 20, "paused", 0, "seek"));
    f.finish(20);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 5,
      mediaId: "film",
      frameEvidence: "verified",
    });

    f.controller.reset();
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: null,
      mediaId: null,
      phase: "disabled",
      targetSec: null,
      frameEvidence: "pending",
    });
    f.frame(20);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: null,
      mediaId: null,
      phase: "preparing",
      frameEvidence: "pending",
    });
  });

  it("does not attribute an old film's verified frame to a future replacement film", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(5, 20, "paused", 0, "seek"));
    f.finish(20);
    f.controller.acceptSnapshot({
      ...f.snapshot(6, 60, "paused", 750, "select-vod", "replace-film"),
      mediaId: "next-film",
    });
    f.advance(749);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: null,
      mediaId: null,
      phase: "preparing",
      frameEvidence: "pending",
    });
    expect(f.controller.acceptSnapshot(f.snapshot(5, 20))).toBe(false);

    f.advance(1);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 6,
      mediaId: "next-film",
      phase: "seeking",
      frameEvidence: "pending",
    });
    f.finish(60);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 6,
      mediaId: "next-film",
      phase: "paused",
      frameEvidence: "verified",
      presentedTimeSec: 60,
    });
  });

  it("retains only the newest metadata-pending target and ignores old revisions across media", () => {
    const f = fixture({ metadata: false });
    f.controller.acceptSnapshot(f.snapshot(1, 10, "paused", 0, "seek"));
    f.controller.acceptSnapshot(f.snapshot(2, 30, "paused", 0, "seek"));
    expect(f.seek).not.toHaveBeenCalled();
    f.media.readyState = 4;
    f.controller.notifyMediaEvent("loadedmetadata");
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(30);
    expect(
      f.controller.acceptSnapshot({
        ...f.snapshot(1, 90),
        mediaId: "old-film",
      }),
    ).toBe(false);
  });

  it("does not let old seek completion satisfy a newer explicit target", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 20, "paused", 0, "seek"));
    f.controller.acceptSnapshot(f.snapshot(2, 50, "paused", 0, "seek"));
    expect(f.seek).toHaveBeenCalledTimes(1);
    f.finish(20);
    expect(f.seek).toHaveBeenCalledTimes(2);
    expect(f.seek).toHaveBeenLastCalledWith(50);
    expect(f.controller.getStatus().phase).not.toBe("paused");
    f.finish(50);
    expect(f.controller.getStatus().phase).toBe("paused");
  });

  it("periodic same-command snapshots and seek events do not renew the 10-second deadline", () => {
    const f = fixture();
    f.controller.acceptSnapshot(
      f.snapshot(1, 20, "paused", 0, "seek", "same-command"),
    );
    for (let revision = 2; revision < 12; revision += 1) {
      f.advance(1_000);
      f.controller.acceptSnapshot(
        f.snapshot(revision, 20, "paused", 0, "seek", "same-command"),
      );
      f.controller.notifyMediaEvent("seeking");
    }
    expect(f.seek).toHaveBeenCalledTimes(1);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      error: "seek-no-progress",
    });
    f.controller.reconcile();
    expect(f.controller.getStatus().phase).toBe("error");
  });

  it("permits only one supplementary seek and does not loop afterward", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 20, "playing", 0, "seek"));
    f.advance(3_000);
    f.media.seeking = false;
    f.media.currentTime = 20.04;
    f.controller.notifyMediaEvent("seeked");
    f.frame(20.04);
    expect(f.seek).toHaveBeenCalledTimes(2);
    f.advance(3_000);
    f.media.seeking = false;
    f.media.currentTime = 23.04;
    f.controller.notifyMediaEvent("seeked");
    f.frame(23.04);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      error: "seek-target-not-reached",
    });
    f.advance(5_000);
    expect(f.seek).toHaveBeenCalledTimes(2);
  });

  it("reconciles the same revision after local position divergence", () => {
    const f = fixture();
    const snapshot = f.snapshot(1, 0);
    f.controller.acceptSnapshot(snapshot);
    f.media.currentTime = 30;
    f.controller.acceptSnapshot(snapshot);
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("does not hard-correct buffered-out, hidden or native seeking playback", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(0, 0));
    f.controller.acceptSnapshot(f.snapshot(1, 0, "playing"));
    f.media.currentTime = 20;
    f.media.bufferedAheadSec = 0;
    f.controller.tick();
    expect(f.controller.getStatus().phase).toBe("buffering");
    f.media.bufferedAheadSec = 30;
    f.controller.setVisible(false);
    f.advance(1_000);
    expect(f.seek).not.toHaveBeenCalled();
    f.media.seeking = true;
    f.controller.setVisible(true);
    expect(f.seek).not.toHaveBeenCalled();
    f.media.seeking = false;
    f.controller.tick();
    expect(f.seek).toHaveBeenCalledTimes(1);
  });

  it("uses at most ten-percent rate correction and restores the authoritative rate", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(0, 0));
    f.controller.acceptSnapshot(f.snapshot(1, 0, "playing"));
    f.advance(2_000);
    expect(f.media.playbackRate).toBe(1.1);
    f.media.currentTime = 2;
    f.controller.tick();
    expect(f.media.playbackRate).toBe(1);
    f.media.currentTime = 3.5;
    f.controller.tick();
    expect(f.media.playbackRate).toBe(0.9);
    expect(f.seek).not.toHaveBeenCalled();
  });

  it("uses a monotonic server mapping despite external wall-clock changes", () => {
    let now = 10;
    const clock = new MonotonicServerClock(() => now, 1_000);
    now = 510;
    expect(clock.serverNowMs()).toBe(1_500);
    clock.calibrate(1_400, 410);
    expect(clock.serverNowMs()).toBe(1_500);
    clock.calibrate(Number.NaN);
    expect(clock.serverNowMs()).toBe(1_500);
  });

  it("classifies autoplay denial, invokes play directly on gesture, and resumes", async () => {
    const f = fixture();
    f.play.mockImplementationOnce(() =>
      Promise.reject(new DOMException("gesture", "NotAllowedError")),
    );
    f.controller.acceptSnapshot(f.snapshot(1, 0, "playing"));
    await Promise.resolve();
    expect(f.controller.getStatus().phase).toBe("autoplay-blocked");
    f.advance(20_000);
    f.controller.userPlay();
    expect(f.play).toHaveBeenCalledTimes(2);
    expect(f.controller.getStatus().error).toBeNull();
  });

  it("distinguishes unsupported media from autoplay and ignores stale promise failures", async () => {
    const f = fixture();
    f.play.mockImplementationOnce(() =>
      Promise.reject(new DOMException("codec", "NotSupportedError")),
    );
    f.controller.acceptSnapshot(f.snapshot(1, 0, "playing"));
    await Promise.resolve();
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      error: "media-format-unsupported",
    });
    f.controller.reset();
    let reject!: (reason: unknown) => void;
    f.play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    f.controller.acceptSnapshot(f.snapshot(2, 0, "playing"));
    f.controller.reset();
    reject(new DOMException("old", "NotAllowedError"));
    await Promise.resolve();
    expect(f.controller.getStatus().phase).toBe("disabled");
  });

  it("does not count a background suspension as foreground seek failure", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 20, "paused", 0, "seek"));
    f.advance(5_000);
    f.controller.setVisible(false);
    f.advance(60_000);
    f.controller.setVisible(true);
    expect(f.controller.getStatus().phase).toBe("seeking");
    f.advance(5_000);
    expect(f.controller.getStatus().error).toBe("seek-no-progress");
  });

  it("defers the first snapshot until its future anchor is effective", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 50, "paused", 750, "seek"));
    f.advance(749);
    expect(f.seek).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: null,
      mediaId: null,
      phase: "preparing",
    });
    f.advance(1);
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(50);
    expect(f.controller.getStatus()).toMatchObject({
      activeRevision: 1,
      mediaId: "film",
      phase: "seeking",
    });
  });

  it("does not postpone a no-progress deadline for supplemental corrections", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 20, "playing", 0, "seek"));
    f.advance(8_000);
    f.media.currentTime = 20.04;
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    f.frame(20.04);
    expect(f.seek).toHaveBeenCalledTimes(2);
    f.advance(2_000);
    expect(f.controller.getStatus().error).toBe("seek-no-progress");
  });

  it("does not consider an ignored currentTime assignment successful", () => {
    const f = fixture();
    f.seek.mockImplementation(() => undefined);
    f.controller.acceptSnapshot(f.snapshot(1, 20, "paused", 0, "seek"));
    f.controller.notifyMediaEvent("seeked");
    f.frame(0);
    f.advance(10_000);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      frameEvidence: "pending",
    });
    expect(f.seek).toHaveBeenCalledTimes(1);
  });

  it("only explicit user retry restarts a failed intention", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(1, 20, "paused", 0, "seek"));
    f.advance(10_000);
    f.controller.reconcile();
    expect(f.seek).toHaveBeenCalledTimes(1);
    f.media.seeking = false;
    f.controller.retry();
    f.finish(20);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      error: null,
      frameEvidence: "verified",
    });
  });

  it("does not relabel an intentional pause's play cancellation as autoplay denial", async () => {
    const f = fixture();
    let reject!: (reason: unknown) => void;
    f.play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    f.controller.acceptSnapshot(f.snapshot(0, 0, "playing"));
    f.controller.acceptSnapshot(f.snapshot(1, 0, "paused"));
    reject(new DOMException("cancelled while pausing", "NotAllowedError"));
    await Promise.resolve();
    expect(f.controller.getStatus().phase).not.toBe("autoplay-blocked");
  });

  it("reasserts a newer pause when an older pending play resolves", async () => {
    const f = fixture();
    let resolve!: () => void;
    f.play.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    f.controller.acceptSnapshot(f.snapshot(0, 0, "playing"));
    f.controller.acceptSnapshot(f.snapshot(1, 0, "paused"));
    f.media.paused = false;
    resolve();
    await Promise.resolve();
    expect(f.media.paused).toBe(true);
  });

  it("allows frame counters to reset after a source reload without fabricating the mediaTime", () => {
    const f = fixture();
    f.frame(0, 100);
    f.controller.acceptSnapshot(f.snapshot(1, 20, "paused", 0, "seek"));
    f.media.seeking = false;
    f.controller.notifyMediaEvent("seeked");
    f.frame(0, 1);
    expect(f.controller.getStatus().frameEvidence).toBe("pending");
    f.frame(20, 2);
    expect(f.controller.getStatus().frameEvidence).toBe("verified");
  });

  it("verifies an already-paused frame when enabling a snapshot received before the user gesture", () => {
    const f = fixture();
    f.controller.setEnabled(false);
    f.controller.acceptSnapshot(f.snapshot(1, 0));
    expect(f.controller.getStatus().phase).toBe("disabled");
    f.controller.setEnabled(true);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      frameEvidence: "verified",
    });
    expect(f.seek).not.toHaveBeenCalled();
  });

  it("verifies advancing frames after a direct user gesture enables a previously disabled snapshot", () => {
    const f = fixture();
    f.controller.setEnabled(false);
    f.controller.acceptSnapshot(f.snapshot(1, 0, "playing"));
    f.controller.userPlay();
    expect(f.controller.getStatus().frameEvidence).toBe("pending");
    f.media.currentTime = 0.04;
    f.frame(0.04);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "playing",
      frameEvidence: "verified",
    });
  });

  it("requests one same-position render when paused before frame observation starts", () => {
    const f = fixture();
    f.media.frame = null;
    f.controller.acceptSnapshot(f.snapshot(1, 0));
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(0);
    f.advance(500);
    expect(f.seek).toHaveBeenCalledTimes(1);
    f.finish(0);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      frameEvidence: "verified",
    });
  });

  it("does not auto-restart an ended film while the authoritative transport remains playing", () => {
    const f = fixture();
    f.controller.acceptSnapshot(f.snapshot(0, 0));
    f.media.currentTime = 300;
    f.media.frame = { mediaTime: 299.97, presentedFrames: 1000 };
    f.media.paused = true;
    f.controller.acceptSnapshot(f.snapshot(1, 300, "playing"));
    f.advance(5_000);
    expect(f.play).not.toHaveBeenCalled();
    expect(f.seek).not.toHaveBeenCalled();
    expect(f.controller.getStatus().phase).toBe("paused");
  });
});
