import { describe, expect, it } from "vitest";

import {
  MonotonicServerClock,
  VodPlaybackController,
  type VodControllerAction,
  type VodMediaState,
  type VodSnapshot,
  type VodStatus,
} from "../src/vod-controller.js";

type MutableMedia = { -readonly [K in keyof VodMediaState]: VodMediaState[K] };

interface SimulationOptions {
  readonly seekCostsMs?: readonly number[];
  readonly playStartDelayMs?: number;
  readonly playPromiseDelayMs?: number;
  readonly rateWriteCostMs?: number;
  readonly quantizeCurrentTime?: boolean;
  readonly frameEvidenceSupported?: boolean;
  readonly rejectedPlayCalls?: number;
}

/** A deterministic event loop, not a seek mock that immediately supplies a frame.
 * Assignment, seeked, play Promise settlement and actual presentation are separate.
 * Every rate write can stop decoding even if currentTime remains assignable. */
function simulation(options: SimulationOptions = {}) {
  let now = 0;
  let position = 0;
  let frameCount = 0;
  let nextFrameAt = 0;
  let decoderBlockedUntil = 0;
  let starvationUntil = 0;
  let seekGeneration = 0;
  let pausedFramePending = false;
  let playCalls = 0;
  let endRestarts = 0;
  let backgrounded = false;
  const events: Array<{ at: number; run: () => void }> = [];
  const seeks: Array<{ atMs: number; targetSec: number }> = [];
  const rateWrites: Array<{ atMs: number; rate: number }> = [];
  const actions: VodControllerAction[] = [];
  const observations: Array<{
    atMs: number;
    actualPosition: number;
    status: VodStatus;
  }> = [];
  const media: MutableMedia = {
    currentTime: 0,
    duration: 600,
    readyState: 4,
    seeking: false,
    paused: true,
    playbackRate: 1,
    bufferedAheadSec: 30,
    frameEvidenceSupported: options.frameEvidenceSupported ?? true,
    frame: null,
  };
  const updatePosition = () => {
    media.currentTime = options.quantizeCurrentTime
      ? Math.floor((position + 1e-8) * 10) / 10
      : position;
  };
  const schedule = (delayMs: number, run: () => void) => {
    events.push({ at: now + delayMs, run });
    events.sort((left, right) => left.at - right.at);
  };
  const clock = new MonotonicServerClock(() => now, 100_000);
  const controller = new VodPlaybackController({
    clock,
    onAction: (action) => actions.push(action),
    media: {
      read: () => ({ ...media }),
      seek: (targetSec) => {
        const generation = ++seekGeneration;
        const costs = options.seekCostsMs ?? [1500];
        const cost = costs[Math.min(seeks.length, costs.length - 1)] ?? 1500;
        seeks.push({ atMs: now, targetSec });
        position = targetSec;
        updatePosition();
        media.seeking = true;
        media.readyState = 1;
        schedule(0, () => controller.notifyMediaEvent("seeking"));
        schedule(cost, () => {
          if (generation !== seekGeneration) return;
          media.seeking = false;
          media.readyState = now < starvationUntil ? 2 : 4;
          pausedFramePending = true;
          nextFrameAt = now + 1000 / 30;
          controller.notifyMediaEvent("seeked");
        });
      },
      play: () => {
        playCalls += 1;
        if (playCalls <= (options.rejectedPlayCalls ?? 0))
          return Promise.reject(
            new DOMException("A user gesture is required", "NotAllowedError"),
          );
        if (position >= media.duration) {
          // Native HTMLMediaElement.play() at EOF can start the film from zero.
          endRestarts += 1;
          position = 0;
          updatePosition();
        }
        const startDelay = options.playStartDelayMs ?? 0;
        // play() changes the paused flag before the decoder delivers its first
        // frame. Promise timing is deliberately independent of that delivery.
        media.paused = false;
        decoderBlockedUntil = Math.max(decoderBlockedUntil, now + startDelay);
        schedule(startDelay, () => {
          nextFrameAt = Math.max(nextFrameAt, now + 1000 / 30);
          controller.notifyMediaEvent("playing");
        });
        return new Promise<void>((resolve) => {
          schedule(options.playPromiseDelayMs ?? startDelay, resolve);
        });
      },
      pause: () => {
        media.paused = true;
      },
      setPrimingMuted: () => undefined,
      setPlaybackRate: (rate) => {
        rateWrites.push({ atMs: now, rate });
        media.playbackRate = rate;
        decoderBlockedUntil = Math.max(
          decoderBlockedUntil,
          now + (options.rateWriteCostMs ?? 0),
        );
        schedule(0, () => controller.notifyMediaEvent("waiting"));
      },
    },
  });
  controller.setEnabled(true);

  function snapshot(
    revision = 1,
    positionSec = 20,
    state: "playing" | "paused" = "playing",
    delayMs = 0,
    commandKind = "seek",
    rate = 1,
  ): VodSnapshot {
    return {
      revision,
      mediaId: "asynchronous-original-file",
      commandId: `command-${revision}`,
      commandKind,
      transport: {
        positionSec,
        state,
        rate,
        anchoredAtServerMs: clock.serverNowMs() + delayMs,
      },
    };
  }

  async function advance(ms: number, repeat?: VodSnapshot) {
    const until = now + ms;
    while (now < until) {
      const elapsed = Math.min(10, until - now);
      if (
        !media.paused &&
        !backgrounded &&
        !media.seeking &&
        now >= decoderBlockedUntil &&
        now >= starvationUntil
      ) {
        position = Math.min(
          media.duration,
          position + (elapsed * media.playbackRate) / 1000,
        );
        if (position >= media.duration) media.paused = true;
      }
      now += elapsed;
      updatePosition();
      while (events[0] && events[0].at <= now) events.shift()!.run();
      await Promise.resolve();
      const canPresent =
        !backgrounded &&
        !media.seeking &&
        now >= decoderBlockedUntil &&
        now >= starvationUntil &&
        media.readyState >= 2;
      if (
        canPresent &&
        now >= nextFrameAt &&
        (!media.paused || pausedFramePending)
      ) {
        pausedFramePending = false;
        nextFrameAt += 1000 / 30;
        if (nextFrameAt <= now) nextFrameAt = now + 1000 / 30;
        if (media.frameEvidenceSupported) {
          media.frame = { mediaTime: position, presentedFrames: ++frameCount };
          controller.notifyMediaEvent("frame", media.frame);
        }
      }
      controller.tick();
      if (repeat && now % 500 === 0) controller.acceptSnapshot(repeat);
      if (now % 250 === 0)
        observations.push({
          atMs: now,
          actualPosition: position,
          status: controller.getStatus(),
        });
    }
  }

  function starve(ms: number) {
    starvationUntil = now + ms;
    media.bufferedAheadSec = 0.05;
    media.readyState = 2;
    controller.notifyMediaEvent("waiting");
    schedule(ms, () => {
      media.bufferedAheadSec = 30;
      media.readyState = media.seeking ? 1 : 4;
      controller.notifyMediaEvent("playing");
    });
  }

  function setBackgrounded(hidden: boolean) {
    backgrounded = hidden;
    controller.setVisible(!hidden);
  }

  function injectLateSeekedAndFrame(mediaTime: number) {
    // Intentionally bypass seekGeneration. A late callback must reach the real
    // controller; the harness may not discard it on the controller's behalf.
    // Keep currentTime/seeking as the current operation reports them, and give
    // the stale pixels a fresh callback count to exercise position validation.
    controller.notifyMediaEvent("seeked");
    media.frame = { mediaTime, presentedFrames: ++frameCount };
    controller.notifyMediaEvent("frame", media.frame);
  }

  return {
    controller,
    media,
    seeks,
    rateWrites,
    actions,
    observations,
    snapshot,
    advance,
    starve,
    setBackgrounded,
    injectLateSeekedAndFrame,
    get now() {
      return now;
    },
    get position() {
      return position;
    },
    get playCalls() {
      return playCalls;
    },
    get endRestarts() {
      return endRestarts;
    },
  };
}

function expectAligned(f: ReturnType<typeof simulation>, tolerance = 0.25) {
  const status = f.controller.getStatus();
  expect(status.error).toBeNull();
  expect(status.phase).toBe("playing");
  expect(Math.abs(status.targetSec! - f.position)).toBeLessThan(tolerance);
}

describe("fixed-rate VOD with asynchronous media effects", () => {
  it.each(
    [0, 700, 750, 1400].flatMap((rateWriteCostMs) =>
      [0, 200, 700].map((playStartDelayMs) => ({
        rateWriteCostMs,
        playStartDelayMs,
      })),
    ),
  )(
    "stays aligned for 180s with 1.5s seeks, $playStartDelayMs ms play delay and $rateWriteCostMs ms rate-write cost",
    async (options) => {
      const f = simulation({ ...options, quantizeCurrentTime: true });
      const command = f.snapshot(1, 20, "playing", 750);
      f.controller.acceptSnapshot(command);
      await f.advance(740);
      expect(f.seeks).toHaveLength(0);
      await f.advance(10);
      expect(f.seeks).toEqual([{ atMs: 750, targetSec: 20 }]);
      await f.advance(9250, command);
      expectAligned(f);
      const settledCount = f.seeks.length;
      expect(settledCount).toBeLessThanOrEqual(3);
      await f.advance(170_000, command);
      expectAligned(f);
      expect(f.rateWrites).toEqual([]);
      expect(f.seeks).toHaveLength(settledCount);
      expect(f.media.playbackRate).toBe(1);
      const steady = f.observations.filter((sample) => sample.atMs >= 10_000);
      expect(steady.length).toBeGreaterThan(600);
      expect(steady.every((sample) => sample.status.phase === "playing")).toBe(
        true,
      );
      expect(
        Math.max(
          ...steady.map((sample) =>
            Math.abs(sample.status.targetSec! - sample.actualPosition),
          ),
        ),
      ).toBeLessThan(0.25);
    },
  );

  it("re-estimates each seek independently and converges on attempt three after cold 1.5s then warm 0.1s decoding", async () => {
    const f = simulation({ seekCostsMs: [1500, 100, 100] });
    f.controller.acceptSnapshot(f.snapshot());
    await f.advance(1500);
    expect(f.controller.getStatus().phase).not.toBe("playing");
    await f.advance(8500);
    expect(f.seeks).toHaveLength(3);
    expectAligned(f);
    const count = f.seeks.length;
    await f.advance(170_000);
    expect(f.seeks).toHaveLength(count);
    expect(f.rateWrites).toEqual([]);
    expectAligned(f);
  });

  it("accounts for first-frame startup after both seeked and an already-resolved play Promise", async () => {
    const f = simulation({
      seekCostsMs: [100, 100, 100],
      playStartDelayMs: 700,
      playPromiseDelayMs: 0,
    });
    f.controller.acceptSnapshot(f.snapshot());
    await f.advance(600);
    expect(f.controller.getStatus().phase).not.toBe("playing");
    expect(f.controller.getStatus().frameEvidence).not.toBe("verified");
    await f.advance(9400);
    expectAligned(f);
    expect(f.seeks.length).toBeLessThanOrEqual(3);
    expect(f.rateWrites).toEqual([]);
  });

  it("stops after three incompatible seek costs instead of cycling or accepting a false in-sync result", async () => {
    const f = simulation({ seekCostsMs: [1400, 2800, 300] });
    const command = f.snapshot();
    f.controller.acceptSnapshot(command);
    await f.advance(10_000, command);
    expect(f.seeks).toHaveLength(3);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      error: "seek-target-not-reached",
    });
    expect(f.controller.getStatus().frameEvidence).not.toBe("verified");
    await f.advance(170_000, command);
    expect(f.seeks).toHaveLength(3);
    expect(f.rateWrites).toEqual([]);
    expect(f.controller.getStatus().phase).toBe("error");
    // A new explicit Host target has its own budget, even after this failure.
    f.controller.acceptSnapshot(f.snapshot(2, 60));
    await f.advance(10_000);
    expectAligned(f);
    expect(f.seeks.length).toBeGreaterThan(3);
    expect(f.seeks.length).toBeLessThanOrEqual(6);
  });

  it("does not renew a ten-second deadline for same-revision ticks or a late seeked event", async () => {
    const f = simulation({ seekCostsMs: [20_000] });
    const command = f.snapshot();
    f.controller.acceptSnapshot(command);
    await f.advance(10_000, command);
    expect(f.seeks).toHaveLength(1);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      error: "seek-no-progress",
    });
    await f.advance(170_000, command);
    expect(f.seeks).toHaveLength(1);
    expect(f.controller.getStatus().phase).toBe("error");
    expect(f.rateWrites).toEqual([]);
  });

  it("keeps a failed revision failed but executes a later Host pause at its effective time", async () => {
    const f = simulation({ seekCostsMs: [1400, 2800, 300] });
    const failedCommand = f.snapshot();
    f.controller.acceptSnapshot(failedCommand);
    await f.advance(10_000, failedCommand);
    expect(f.controller.getStatus().error).toBe("seek-target-not-reached");
    expect(f.seeks).toHaveLength(3);
    // A replay cannot mutate the command's transport or reset its failed budget.
    f.controller.acceptSnapshot({
      ...failedCommand,
      transport: { ...failedCommand.transport, state: "paused" },
    });
    await f.advance(1000, failedCommand);
    expect(f.controller.getStatus().error).toBe("seek-target-not-reached");
    expect(f.seeks).toHaveLength(3);
    const pausePosition = 20 + (f.now + 750) / 1000;
    f.controller.acceptSnapshot(
      f.snapshot(2, pausePosition, "paused", 750, "pause"),
    );
    await f.advance(740);
    expect(f.controller.getStatus().activeRevision).toBe(1);
    expect(f.controller.getStatus().error).toBe("seek-target-not-reached");
    await f.advance(10);
    expect(f.media.paused).toBe(true);
    expect(f.controller.getStatus().error).toBeNull();
    expect(f.controller.getStatus().activeRevision).toBe(2);
    await f.advance(2000);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      error: null,
    });
    expect(Math.abs(f.position - pausePosition)).toBeLessThanOrEqual(0.15);
    expect(f.seeks.length).toBeLessThanOrEqual(4);
    expect(f.rateWrites).toEqual([]);
  });

  it("excludes thirty hidden seconds from an already-issued seek's prediction and deadline", async () => {
    const f = simulation({ seekCostsMs: [1500] });
    const command = f.snapshot();
    f.controller.acceptSnapshot(command);
    await f.advance(500);
    expect(f.seeks).toHaveLength(1);
    f.setBackgrounded(true);
    await f.advance(30_000, command);
    expect(f.seeks).toHaveLength(1);
    expect(f.controller.getStatus().error).toBeNull();
    f.setBackgrounded(false);
    await f.advance(9000, command);
    expectAligned(f);
    expect(f.seeks).toHaveLength(3);
    const second = f.seeks[1]!;
    const predictedLead = second.targetSec - (20 + second.atMs / 1000);
    expect(predictedLead).toBeGreaterThanOrEqual(0);
    expect(predictedLead).toBeLessThan(1);
    expect(f.rateWrites).toEqual([]);
  });

  it("excludes thirty seconds awaiting a user gesture after NotAllowedError from seek prediction", async () => {
    const f = simulation({
      seekCostsMs: [1500],
      playStartDelayMs: 700,
      rejectedPlayCalls: 1,
    });
    const command = f.snapshot();
    f.controller.acceptSnapshot(command);
    await f.advance(500);
    expect(f.controller.getStatus().phase).toBe("autoplay-blocked");
    expect(f.playCalls).toBe(1);
    expect(f.seeks).toHaveLength(1);
    await f.advance(30_000, command);
    expect(f.controller.getStatus().phase).toBe("autoplay-blocked");
    expect(f.playCalls).toBe(1);
    f.controller.userPlay();
    await f.advance(9000, command);
    expectAligned(f);
    expect(f.seeks).toHaveLength(3);
    const second = f.seeks[1]!;
    const predictedLead = second.targetSec - (20 + second.atMs / 1000);
    expect(predictedLead).toBeGreaterThanOrEqual(0);
    expect(predictedLead).toBeLessThan(1);
    expect(f.rateWrites).toEqual([]);
  });

  it("caps measured compensation at three seconds and can correct the resulting warm-seek overshoot", async () => {
    const f = simulation({ seekCostsMs: [4000, 100, 100] });
    f.controller.acceptSnapshot(f.snapshot());
    await f.advance(10_000);
    expect(f.seeks).toHaveLength(3);
    const second = f.seeks[1]!;
    const authoritativeAtSecondSeek = 20 + second.atMs / 1000;
    expect(second.targetSec - authoritativeAtSecondSeek).toBeCloseTo(3, 5);
    expectAligned(f);
    expect(f.rateWrites).toEqual([]);
  });

  it("does not seek while starved and recovers once at the base rate after real frames resume", async () => {
    const f = simulation({ seekCostsMs: [100] });
    f.controller.acceptSnapshot(f.snapshot());
    await f.advance(10_000);
    expectAligned(f);
    const beforeStarvation = f.seeks.length;
    f.starve(1500);
    await f.advance(1400);
    expect(f.seeks).toHaveLength(beforeStarvation);
    expect(f.controller.getStatus().phase).toBe("buffering");
    await f.advance(18_600);
    expectAligned(f);
    expect(f.seeks.length).toBeGreaterThan(beforeStarvation);
    expect(f.seeks.length).toBeLessThanOrEqual(beforeStarvation + 3);
    const afterRecovery = f.seeks.length;
    await f.advance(150_000);
    expectAligned(f);
    expect(f.seeks).toHaveLength(afterRecovery);
    expect(f.rateWrites).toEqual([]);
  });

  it("keeps missing presentation evidence unavailable rather than manufacturing verified frames", async () => {
    const f = simulation({
      frameEvidenceSupported: false,
      seekCostsMs: [1500],
    });
    f.controller.acceptSnapshot(f.snapshot());
    await f.advance(10_000);
    expect(f.controller.getStatus().frameEvidence).toBe("unavailable");
    expect(f.controller.getStatus().presentedTimeSec).toBeNull();
    expect(
      f.observations.every(
        (sample) => sample.status.frameEvidence !== "verified",
      ),
    ).toBe(true);
    expect(f.seeks.length).toBeLessThanOrEqual(3);
    expect(f.rateWrites).toEqual([]);
  });

  it("does not repeatedly spend automatic re-entry budget, but still accepts a new Host seek", async () => {
    const f = simulation({ seekCostsMs: [100] });
    f.controller.acceptSnapshot(f.snapshot());
    await f.advance(10_000);
    f.starve(1500);
    await f.advance(20_000);
    expectAligned(f);
    const afterFirstRecovery = f.seeks.length;
    f.starve(1500);
    await f.advance(20_000);
    expect(f.seeks).toHaveLength(afterFirstRecovery);
    // Keeping the number honest is essential: exhausted recovery budget must
    // not pretend that uninterrupted playback is also correctly synchronized.
    expect(Math.abs(f.controller.getStatus().driftSec!)).toBeGreaterThan(1);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "error",
      error: "sync-recovery-budget-exhausted",
    });
    expect(f.controller.getStatus().frameEvidence).not.toBe("verified");
    await f.advance(130_000);
    expect(f.seeks).toHaveLength(afterFirstRecovery);
    expect(f.controller.getStatus().phase).toBe("error");
    f.controller.acceptSnapshot(f.snapshot(2, 100));
    await f.advance(10_000);
    expectAligned(f);
    expect(f.seeks.length).toBeGreaterThan(afterFirstRecovery);
    expect(f.rateWrites).toEqual([]);
  });

  it("does not call play at EOF when the measured seek compensation reaches the duration", async () => {
    const f = simulation({ seekCostsMs: [1500] });
    f.media.duration = 20;
    f.controller.acceptSnapshot(f.snapshot(1, 18.9));
    await f.advance(10_000);
    expect(f.seeks.some((seek) => seek.targetSec === 20)).toBe(true);
    expect(f.seeks.every((seek) => seek.targetSec <= 20)).toBe(true);
    expect(f.position).toBe(20);
    expect(f.media.paused).toBe(true);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      error: null,
    });
    expect(f.endRestarts).toBe(0);
    expect(f.playCalls).toBe(1);
    expect(f.rateWrites).toEqual([]);
  });

  it("does not let a user sound gesture restart a predicted EOF while waiting for the authority", async () => {
    const f = simulation({ seekCostsMs: [1000, 100] });
    f.controller.acceptSnapshot(f.snapshot(1, 598.7));
    await f.advance(1150);
    expect(f.position).toBe(600);
    expect(f.controller.getStatus().phase).toBe("buffering");
    f.controller.userPlay();
    expect(f.endRestarts).toBe(0);
    await f.advance(1000);
    expect(f.position).toBe(600);
    expect(f.controller.getStatus()).toMatchObject({
      phase: "paused",
      error: null,
    });
    expect(f.endRestarts).toBe(0);
  });

  it("does not let the old seeked frame fulfill a newer Host target", async () => {
    const f = simulation({ seekCostsMs: [1500, 100, 100] });
    f.controller.acceptSnapshot(f.snapshot(1, 20));
    await f.advance(500);
    f.controller.acceptSnapshot(f.snapshot(2, 80));
    await f.advance(1010);
    expect(f.controller.getStatus().activeRevision).toBe(2);
    expect(f.controller.getStatus().frameEvidence).not.toBe("verified");
    await f.advance(8490);
    expectAligned(f);
    expect(f.seeks[1]?.targetSec).toBeGreaterThanOrEqual(81);
    expect(f.rateWrites).toEqual([]);
  });

  it("rejects manually injected late old callbacks without contaminating the newer seek's loss estimate", async () => {
    const f = simulation({ seekCostsMs: [1500] });
    f.controller.acceptSnapshot(f.snapshot(1, 20));
    await f.advance(500);
    f.controller.acceptSnapshot(f.snapshot(2, 80));
    await f.advance(1000);
    expect(f.seeks).toHaveLength(2);
    expect(f.media.seeking).toBe(true);
    f.injectLateSeekedAndFrame(20.04);
    expect(f.controller.getStatus().activeRevision).toBe(2);
    expect(f.controller.getStatus().frameEvidence).not.toBe("verified");
    expect(f.seeks).toHaveLength(2);

    // The new seek's media clock is already positioned, but no genuine new
    // frame has arrived yet. This is stronger than injecting only mid-seek.
    await f.advance(1500);
    expect(f.media.seeking).toBe(false);
    expect(f.media.currentTime).toBeCloseTo(81, 5);
    f.injectLateSeekedAndFrame(20.08);
    expect(f.controller.getStatus().frameEvidence).not.toBe("verified");
    expect(f.controller.getStatus().phase).not.toBe("playing");
    expect(f.seeks).toHaveLength(2);

    await f.advance(40);
    expect(f.seeks).toHaveLength(3);
    const compensation = f.seeks[2]!;
    const authoritativeAtCompensation = 80 + (compensation.atMs - 500) / 1000;
    expect(compensation.targetSec - authoritativeAtCompensation).toBeCloseTo(
      1.5,
      2,
    );
    // The stale 20s pixels must not be converted into the capped 3s prediction.
    expect(compensation.targetSec - authoritativeAtCompensation).toBeLessThan(
      2,
    );
    await f.advance(10_000);
    expectAligned(f);
    expect(f.seeks).toHaveLength(3);
    expect(f.rateWrites).toEqual([]);
  });

  it("retains a later Host pause when the old asynchronous play starts and resolves", async () => {
    const f = simulation({
      seekCostsMs: [100],
      playStartDelayMs: 700,
      playPromiseDelayMs: 1000,
    });
    f.controller.acceptSnapshot(f.snapshot(1, 20));
    await f.advance(300);
    f.controller.acceptSnapshot(f.snapshot(2, 20.3, "paused", 0, "pause"));
    await f.advance(9700);
    expect(f.media.paused).toBe(true);
    expect(f.controller.getStatus().activeRevision).toBe(2);
    expect(f.controller.getStatus().phase).toBe("paused");
    expect(Math.abs(f.position - 20.3)).toBeLessThanOrEqual(0.15);
    expect(f.rateWrites).toEqual([]);
  });

  it("writes a non-default Host base rate once without manufacturing a second correction rate", async () => {
    const f = simulation({ seekCostsMs: [1500], rateWriteCostMs: 1400 });
    f.controller.acceptSnapshot(f.snapshot(1, 20, "playing", 0, "seek", 1.25));
    await f.advance(10_000);
    expectAligned(f);
    await f.advance(170_000);
    expectAligned(f);
    expect(f.rateWrites.map((entry) => entry.rate)).toEqual([1.25]);
    expect(
      f.actions
        .filter((action) => action.kind === "rate")
        .every((action) => action.reason !== "drift"),
    ).toBe(true);
  });

  it.each(
    [100, 1500].flatMap((seekCost) =>
      [0, 200, 700, 1400].map((playDelay) => ({ seekCost, playDelay })),
    ),
  )(
    "aligns paused-to-playing and later resume inside each initial intention with $seekCost ms seeks and $playDelay ms play startup",
    async ({ seekCost, playDelay }) => {
      const f = simulation({
        seekCostsMs: [seekCost],
        playStartDelayMs: playDelay,
      });
      f.controller.acceptSnapshot(f.snapshot(1, 20, "paused"));
      await f.advance(4000);
      expect(f.controller.getStatus()).toMatchObject({
        phase: "paused",
        error: null,
        frameEvidence: "verified",
      });
      await f.advance(2000);

      const startAndObserve = async (revision: number, positionSec: number) => {
        const actionCount = f.actions.length;
        const seekCount = f.seeks.length;
        const command = f.snapshot(
          revision,
          positionSec,
          "playing",
          750,
          "play",
        );
        f.controller.acceptSnapshot(command);
        await f.advance(740);
        expect(f.media.paused).toBe(true);
        expect(f.seeks).toHaveLength(seekCount);
        await f.advance(10);
        expect(f.controller.getStatus().activeRevision).toBe(revision);
        const beforeFirstFrame = Math.max(0, playDelay - 100);
        await f.advance(beforeFirstFrame);
        // The play Promise may have changed paused, but the startup-delay
        // window has not supplied any advancing presentation evidence yet.
        expect(f.controller.getStatus().phase).not.toBe("playing");
        expect(f.controller.getStatus().frameEvidence).not.toBe("verified");
        await f.advance(10_000 - beforeFirstFrame, command);
        expectAligned(f);
        const startupActions = f.actions.slice(actionCount);
        if (playDelay > 250)
          expect(startupActions.some((action) => action.kind === "seek")).toBe(
            true,
          );
        expect(
          startupActions
            .filter((action) => action.kind === "seek")
            .every((action) => action.reason === "alignment"),
        ).toBe(true);
        expect(
          startupActions.filter((action) => action.kind === "rate"),
        ).toEqual([]);
        const settledSeekCount = f.seeks.length;
        await f.advance(180_000, command);
        expectAligned(f);
        expect(f.seeks).toHaveLength(settledSeekCount);
        expect(f.rateWrites).toEqual([]);
      };

      await startAndObserve(2, 20);
      const pausePosition = f.controller.getStatus().targetSec! + 0.75;
      f.controller.acceptSnapshot(
        f.snapshot(3, pausePosition, "paused", 750, "pause"),
      );
      await f.advance(3000);
      expect(f.controller.getStatus()).toMatchObject({
        phase: "paused",
        error: null,
      });
      await f.advance(2000);
      await startAndObserve(4, pausePosition);
    },
  );

  it("does not create a new alignment for a same-speed playing-to-playing Host command", async () => {
    const f = simulation({ seekCostsMs: [1500], playStartDelayMs: 700 });
    f.controller.acceptSnapshot(f.snapshot(1, 20));
    await f.advance(10_000);
    expectAligned(f);
    const count = f.seeks.length;
    const nextPosition = f.controller.getStatus().targetSec! + 0.75;
    const command = f.snapshot(2, nextPosition, "playing", 750, "play");
    f.controller.acceptSnapshot(command);
    await f.advance(180_000, command);
    expectAligned(f);
    expect(f.controller.getStatus().activeRevision).toBe(2);
    expect(f.seeks).toHaveLength(count);
    expect(f.rateWrites).toEqual([]);
  });
});
