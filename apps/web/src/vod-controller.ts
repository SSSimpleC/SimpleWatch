import type { TransportAnchor } from "@simplewatch/contracts";

export type VodPhase =
  | "disabled"
  | "preparing"
  | "seeking"
  | "buffering"
  | "playing"
  | "paused"
  | "autoplay-blocked"
  | "error";

export interface VodPresentedFrame {
  readonly mediaTime: number;
  readonly presentedFrames: number;
}

export interface VodMediaState {
  readonly currentTime: number;
  readonly duration: number;
  readonly readyState: number;
  readonly seeking: boolean;
  readonly paused: boolean;
  readonly playbackRate: number;
  readonly bufferedAheadSec: number;
  /** Actual rendered-frame counter (rVFC or a supported frame-count fallback). */
  readonly frameSequence?: number;
  readonly frame?: VodPresentedFrame | null;
  readonly frameEvidenceSupported?: boolean;
}

export interface VodMediaAdapter {
  readonly read: () => VodMediaState;
  readonly seek: (seconds: number) => void;
  readonly setPlaybackRate: (rate: number) => void;
  readonly play: () => Promise<void> | void;
  readonly pause: () => void;
  /** Suppress sound only while a user-requested paused frame is being decoded. */
  readonly setPrimingMuted: (muted: boolean) => void;
}

export interface VodClock {
  readonly monotonicNowMs: () => number;
  readonly serverNowMs: () => number;
}

/** Call calibrate after the existing NTP-style sampling; wall-clock jumps cannot
 * then move the playback timeline or change deadlines between samples. */
export class MonotonicServerClock implements VodClock {
  private sampleMonotonicMs: number;
  private sampleServerMs: number;

  public constructor(
    public readonly monotonicNowMs: () => number,
    initialServerMs: number,
  ) {
    this.sampleMonotonicMs = monotonicNowMs();
    this.sampleServerMs = initialServerMs;
  }

  public calibrate(
    serverMs: number,
    atMonotonicMs = this.monotonicNowMs(),
  ): void {
    if (!Number.isFinite(serverMs) || !Number.isFinite(atMonotonicMs)) return;
    this.sampleMonotonicMs = atMonotonicMs;
    this.sampleServerMs = serverMs;
  }

  public serverNowMs = (): number =>
    this.sampleServerMs + this.monotonicNowMs() - this.sampleMonotonicMs;
}

export interface VodSnapshot {
  readonly revision: number;
  readonly mediaId: string;
  readonly transport: TransportAnchor;
  readonly commandId?: string;
  readonly commandKind?: string;
}

export interface VodStatus {
  readonly activeRevision: number | null;
  readonly mediaId: string | null;
  readonly phase: VodPhase;
  readonly targetSec: number | null;
  readonly driftSec: number | null;
  readonly intentId: number | null;
  readonly seekAttempts: number;
  readonly error: string | null;
  readonly frameEvidence: "verified" | "pending" | "unavailable";
  readonly presentedTimeSec: number | null;
}

interface SeekIntent {
  readonly id: number;
  readonly explicit: boolean;
  startedAtMs: number;
  attempts: number;
  issuedTargetSec: number | null;
  issuedPositionSec: number;
  frameBaseline: number;
  seekedObserved: boolean;
  seekingObserved: boolean;
  samePosition: boolean;
  primingAttempted: boolean;
}

export type VodMediaEvent =
  | "loadedmetadata"
  | "loadeddata"
  | "seeking"
  | "seeked"
  | "waiting"
  | "playing"
  | "frame"
  | "error";

export interface VodControllerOptions {
  /** Explicit, page-local A/B test. Never persisted or enabled by default. */
  readonly comparisonMode?: "normal" | "host-only";
  readonly media: VodMediaAdapter;
  readonly clock: VodClock;
  readonly onStatus?: (status: VodStatus) => void;
}

/** All media effects pass through one controller. Call tick on the existing
 * clock interval and media events; metadata, seek completion and frame evidence
 * must come from the same video element/generation. */
export class VodPlaybackController {
  private enabled = false;
  private visible = true;
  private hiddenAtMs: number | null = null;
  private accepted: VodSnapshot | null = null;
  private active: VodSnapshot | null = null;
  private pending: VodSnapshot[] = [];
  private intent: SeekIntent | null = null;
  private nextIntentId = 0;
  private lastHardSeekMs = Number.NEGATIVE_INFINITY;
  private softCooldownUntilMs = 0;
  private blocked = false;
  private blockedAtMs: number | null = null;
  private error: string | null = null;
  private playPending = false;
  private generation = 0;
  private playRequestId = 0;
  private pausedPrime: { revision: number; deadlineMs: number } | null = null;
  private presentedFrame: VodPresentedFrame | null = null;
  private frameVerified = false;
  private lastIntentCommandKey: string | null = null;
  private status: VodStatus = {
    activeRevision: null,
    mediaId: null,
    phase: "disabled",
    targetSec: null,
    driftSec: null,
    intentId: null,
    seekAttempts: 0,
    error: null,
    frameEvidence: "unavailable",
    presentedTimeSec: null,
  };

  public constructor(private readonly options: VodControllerOptions) {}

  public acceptSnapshot(snapshot: VodSnapshot): boolean {
    if (this.accepted && snapshot.revision < this.accepted.revision)
      return false;
    if (
      this.accepted &&
      snapshot.revision === this.accepted.revision &&
      snapshot.mediaId !== this.accepted.mediaId
    )
      return false;
    if (this.accepted?.mediaId !== snapshot.mediaId) this.clearTimeline();
    if (this.accepted?.revision === snapshot.revision) {
      // Fresh connection/foreground recovery can require effects even when the
      // authoritative revision did not change. Never re-apply the same command.
      this.reconcile();
      return true;
    }
    const stable = {
      ...snapshot,
      transport: {
        ...snapshot.transport,
        rate:
          this.options.comparisonMode === "host-only"
            ? 1
            : snapshot.transport.rate,
      },
    };
    this.accepted = stable;
    this.pending.push(stable);
    this.tick();
    return true;
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.stopPausedPrime();
      this.intent = null;
      this.options.media.pause();
    } else if (this.active) this.beginIntent(false);
    this.tick();
  }

  public setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    const now = this.options.clock.monotonicNowMs();
    this.visible = visible;
    if (!visible) {
      this.stopPausedPrime();
      this.hiddenAtMs = now;
    } else {
      if (this.intent && this.hiddenAtMs !== null)
        this.intent.startedAtMs +=
          now - Math.max(this.hiddenAtMs, this.intent.startedAtMs);
      this.hiddenAtMs = null;
      this.reconcile();
    }
  }

  public reconcile(): void {
    this.tick();
  }

  /** Only an explicit user retry starts a new deadline after a failed seek. */
  public retry(): void {
    this.stopPausedPrime();
    this.error = null;
    this.blocked = false;
    this.blockedAtMs = null;
    this.intent = null;
    if (this.active) this.beginIntent(true);
    this.tick();
  }

  /** Keep this synchronous with the real user gesture; do not await auth first. */
  public userPlay(): void {
    if (this.intent && this.blockedAtMs !== null) {
      this.intent.startedAtMs +=
        this.options.clock.monotonicNowMs() -
        Math.max(this.blockedAtMs, this.intent.startedAtMs);
    }
    this.blocked = false;
    this.blockedAtMs = null;
    if (!this.enabled && this.active) this.beginIntent(false);
    this.enabled = true;
    if (!this.active) {
      // Enabling sound is not permission to play an unknown/old position before
      // the first authoritative anchor becomes effective. tick will apply a due
      // snapshot; a future one remains pending with no premature media effects.
      this.tick();
      return;
    }
    const media = this.options.media.read();
    if (
      this.active &&
      atMediaEnd(
        media,
        targetAt(
          this.active.transport,
          this.options.clock.serverNowMs(),
          media.duration,
        ),
      )
    ) {
      // Calling play() at EOF would restart the film from zero.
      this.tick();
      return;
    }
    if (this.active?.transport.state === "paused") {
      // WebKit can acknowledge currentTime/seeked while still displaying the
      // old frame. A real click may prime decoding once,
      // silently, until the matching frame arrives. Never cancel that play in
      // the same task or infer success from its Promise/currentTime alone.
      this.startPausedPrime(true);
      this.tick();
      return;
    }
    this.requestPlay(true);
    this.tick();
  }

  public notifyMediaEvent(
    event: VodMediaEvent,
    frame?: VodPresentedFrame,
  ): void {
    if (
      event === "frame" &&
      frame &&
      Number.isFinite(frame.mediaTime) &&
      Number.isFinite(frame.presentedFrames)
    ) {
      if (
        this.intent &&
        frame.presentedFrames <
          (this.presentedFrame?.presentedFrames ?? this.intent.frameBaseline)
      ) {
        // A source reload can reset the browser's presentation counter. The
        // caller fences old element callbacks; a new count is still required
        // to carry the correct mediaTime below.
        this.intent.frameBaseline = -1;
      }
      this.presentedFrame = { ...frame };
    }
    if (event === "error") this.error = "media-playback-error";
    const intent = this.intent;
    if (intent && intent.issuedTargetSec !== null) {
      if (event === "seeking") intent.seekingObserved = true;
      if (event === "seeked") intent.seekedObserved = true;
    }
    this.tick();
  }

  public getStatus(): VodStatus {
    return { ...this.status };
  }

  public reset(): void {
    this.clearTimeline();
    this.publish("disabled", null, null);
  }

  public tick(): void {
    const serverNow = this.options.clock.serverNowMs();
    const now = this.options.clock.monotonicNowMs();
    let newIntent = false;
    while (
      this.pending[0] &&
      this.pending[0].transport.anchoredAtServerMs <= serverNow
    ) {
      const applied = this.pending.shift()!;
      const first = this.active === null;
      this.active = applied;
      const commandKey = applied.commandId ?? `revision:${applied.revision}`;
      const explicit = ["seek", "select-vod", "restore-vod"].includes(
        applied.commandKind ?? "",
      );
      if (first || (explicit && commandKey !== this.lastIntentCommandKey)) {
        this.lastIntentCommandKey = commandKey;
        newIntent = true;
      }
    }
    if (newIntent) {
      this.error = null;
      this.intent = null;
      if (this.enabled) this.beginIntent(true);
    }
    if (this.pausedPrime) {
      if (this.pausedPrime.revision !== this.active?.revision)
        this.stopPausedPrime();
      else if (this.error || now >= this.pausedPrime.deadlineMs) {
        this.stopPausedPrime();
        this.error ??= "paused-frame-not-presented";
      }
    }
    if (!this.enabled) {
      this.publish("disabled", null, null);
      return;
    }
    const active = this.active;
    if (!active) {
      this.publish("preparing", null, null);
      return;
    }
    const media = this.options.media.read();
    const target = targetAt(active.transport, serverNow, media.duration);
    const transport = atMediaEnd(media, target)
      ? { ...active.transport, state: "paused" as const }
      : active.transport;
    const drift = target - media.currentTime;
    if (!this.visible) {
      this.publish("buffering", target, drift);
      return;
    }
    if (this.error) {
      this.publish("error", target, drift);
      return;
    }
    if (this.blocked) {
      this.publish("autoplay-blocked", target, drift);
      return;
    }
    this.applyTransport(media, transport);
    if (this.blocked || this.error) {
      this.publish(this.blocked ? "autoplay-blocked" : "error", target, drift);
      return;
    }
    if (!this.intent && media.readyState < 1) this.beginIntent(false);
    if (this.intent) {
      this.advanceIntent(media, target, drift, now);
      return;
    }
    if (media.seeking) {
      this.publish("seeking", target, drift);
      return;
    }
    if (
      media.readyState < 2 ||
      (transport.state === "playing" && media.bufferedAheadSec < 0.1)
    ) {
      this.restoreRate(media, transport.rate);
      this.publish("buffering", target, drift);
      return;
    }
    if (
      this.options.comparisonMode !== "host-only" &&
      Math.abs(drift) > (transport.state === "paused" ? 0.15 : 2) &&
      now - this.lastHardSeekMs >= 5_000
    ) {
      this.beginIntent(false);
      this.advanceIntent(media, target, drift, now);
      return;
    }
    if (
      this.options.comparisonMode !== "host-only" &&
      transport.state === "playing" &&
      Math.abs(drift) > 0.15 &&
      now >= this.softCooldownUntilMs
    ) {
      const adjustment = Math.max(-0.1, Math.min(0.1, drift / 10));
      this.restoreRate(media, transport.rate * (1 + adjustment));
    } else this.restoreRate(media, transport.rate);
    this.publish(transport.state, target, drift);
  }

  private beginIntent(explicit: boolean): void {
    const media = this.options.media.read();
    this.intent = {
      id: ++this.nextIntentId,
      explicit,
      startedAtMs: this.options.clock.monotonicNowMs(),
      attempts: 0,
      issuedTargetSec: null,
      issuedPositionSec: media.currentTime,
      frameBaseline: this.frame(media)?.presentedFrames ?? -1,
      seekedObserved: false,
      seekingObserved: false,
      samePosition: false,
      primingAttempted: false,
    };
    this.frameVerified = false;
  }

  private advanceIntent(
    media: VodMediaState,
    target: number,
    drift: number,
    now: number,
  ): void {
    const intent = this.intent!;
    const anchor = this.active!.transport;
    const transport = atMediaEnd(media, target)
      ? { ...anchor, state: "paused" as const }
      : anchor;
    if (now - intent.startedAtMs >= 10_000) {
      this.error = "seek-no-progress";
      this.publish("error", target, drift);
      return;
    }
    if (media.readyState < 1) {
      this.publish("preparing", target, drift);
      return;
    }
    if (intent.issuedTargetSec === null) {
      if (media.seeking) {
        this.publish("seeking", target, drift);
        return;
      }
      const existingFrame = this.frame(media);
      const pausedFrameKnown =
        transport.state !== "paused" ||
        !this.supportsFrames(media) ||
        (existingFrame !== null &&
          Math.abs(existingFrame.mediaTime - target) <= 0.15);
      if (
        Math.abs(drift) <= 0.15 &&
        media.readyState >= 2 &&
        pausedFrameKnown
      ) {
        // Reuse a known static frame. Without one, a single same-position seek
        // asks the browser to present a frame that an rVFC subscriber can observe.
        intent.issuedTargetSec = media.currentTime;
        intent.issuedPositionSec = media.currentTime;
        intent.seekedObserved = true;
        intent.samePosition = true;
      } else {
        this.issueSeek(intent, media, target, now);
        this.publish("seeking", target, drift);
        return;
      }
    }
    if (media.seeking) {
      intent.seekingObserved = true;
      this.publish("seeking", target, drift);
      return;
    }
    const frame = this.frame(media);
    const supportsFrames = this.supportsFrames(media);
    const newFrame = Boolean(
      frame &&
      (frame.presentedFrames > intent.frameBaseline ||
        (intent.samePosition && transport.state === "paused")),
    );
    const presentedAtTarget =
      frame !== null &&
      nearIssuedPosition(frame.mediaTime, intent, transport.state === "paused");
    const frameEvidence = newFrame && presentedAtTarget;
    const positioned = nearIssuedTarget(media, intent);
    const seekFinished =
      intent.seekedObserved ||
      intent.seekingObserved ||
      (frameEvidence && positioned);
    const progressPosition = supportsFrames
      ? (frame?.mediaTime ?? intent.issuedPositionSec)
      : media.currentTime;
    const playbackProgress =
      transport.state === "paused" ||
      progressPosition > intent.issuedPositionSec + 0.01;
    // A paused seek can acknowledge its clock change while still displaying the
    // old pixels. Once settled, permit one silent decode of the target instead
    // of repeatedly writing the same currentTime. It still needs a real frame,
    // is capped at three seconds, and cannot extend the intent's deadline.
    if (
      this.options.comparisonMode !== "host-only" &&
      transport.state === "paused" &&
      seekFinished &&
      positioned &&
      media.readyState >= 2 &&
      supportsFrames &&
      !frameEvidence &&
      !intent.primingAttempted &&
      now - this.lastHardSeekMs >= 1500 &&
      !atMediaEnd(media, target)
    ) {
      this.startPausedPrime(false);
      this.publish(
        this.blocked ? "autoplay-blocked" : this.error ? "error" : "buffering",
        target,
        drift,
      );
      return;
    }
    // With no rVFC capability, events may allow continued playback, but the
    // reported evidence remains unavailable rather than claiming a rendered frame.
    if (
      !seekFinished ||
      !positioned ||
      (supportsFrames && !frameEvidence) ||
      !playbackProgress ||
      media.readyState < 2
    ) {
      this.publish(seekFinished ? "buffering" : "seeking", target, drift);
      return;
    }
    const tolerance = transport.state === "paused" ? 0.15 : 2;
    if (
      this.options.comparisonMode !== "host-only" &&
      Math.abs(drift) > tolerance
    ) {
      if (intent.attempts < 2 && !media.seeking) {
        this.issueSeek(intent, media, target, now);
        this.publish("seeking", target, drift);
        return;
      }
      this.error = "seek-target-not-reached";
      this.publish("error", target, drift);
      return;
    }
    this.intent = null;
    this.frameVerified = frameEvidence;
    this.stopPausedPrime();
    this.softCooldownUntilMs = now + 2_000;
    this.restoreRate(media, transport.rate);
    this.publish(transport.state, target, drift);
  }

  private issueSeek(
    intent: SeekIntent,
    media: VodMediaState,
    target: number,
    now: number,
  ): void {
    intent.attempts += 1;
    intent.issuedTargetSec = target;
    intent.issuedPositionSec = target;
    intent.frameBaseline = this.frame(media)?.presentedFrames ?? -1;
    intent.seekedObserved = false;
    intent.seekingObserved = false;
    intent.samePosition = false;
    this.frameVerified = false;
    this.lastHardSeekMs = now;
    this.restoreRate(media, this.active!.transport.rate);
    try {
      this.options.media.seek(target);
    } catch {
      this.error = "seek-request-failed";
    }
  }

  private applyTransport(
    media: VodMediaState,
    transport: TransportAnchor,
  ): void {
    if (transport.state === "paused") {
      if (!media.paused && !this.pausedPrime) {
        this.playRequestId += 1;
        this.playPending = false;
        this.options.media.pause();
      }
      this.restoreRate(media, transport.rate);
    } else if (media.paused && !this.playPending) this.requestPlay();
  }

  private requestPlay(fromGesture = false): void {
    if (this.playPending && !fromGesture) return;
    const generation = this.generation;
    const requestId = ++this.playRequestId;
    this.playPending = true;
    const fail = (reason: unknown) => {
      if (generation !== this.generation || requestId !== this.playRequestId)
        return;
      this.playPending = false;
      const wasPriming = this.pausedPrime !== null;
      this.stopPausedPrime();
      if (this.active?.transport.state === "paused" && !wasPriming) return;
      const name =
        reason && typeof reason === "object" && "name" in reason
          ? reason.name
          : null;
      if (name === "AbortError") return;
      if (name === "NotAllowedError") {
        this.blocked = true;
        this.blockedAtMs ??= this.options.clock.monotonicNowMs();
        this.publish(
          "autoplay-blocked",
          this.status.targetSec,
          this.status.driftSec,
        );
      } else {
        this.error =
          name === "NotSupportedError"
            ? "media-format-unsupported"
            : "media-play-request-failed";
        this.publish("error", this.status.targetSec, this.status.driftSec);
      }
    };
    try {
      const result = this.options.media.play();
      if (result) {
        void result.then(() => {
          if (
            generation === this.generation &&
            requestId === this.playRequestId
          ) {
            this.playPending = false;
            if (this.active?.transport.state === "paused" && !this.pausedPrime)
              this.options.media.pause();
          }
        }, fail);
      } else this.playPending = false;
    } catch (reason) {
      fail(reason);
    }
  }

  private restoreRate(media: VodMediaState, rate: number): void {
    if (Math.abs(media.playbackRate - rate) > 0.001)
      this.options.media.setPlaybackRate(rate);
  }

  private stopPausedPrime(): void {
    if (!this.pausedPrime) return;
    this.pausedPrime = null;
    this.playRequestId += 1;
    this.playPending = false;
    this.options.media.pause();
    this.options.media.setPrimingMuted(false);
  }

  private startPausedPrime(fromGesture: boolean): void {
    if (
      this.options.comparisonMode === "host-only" ||
      !this.enabled ||
      !this.visible ||
      this.error ||
      this.blocked ||
      !this.active ||
      this.active.transport.state !== "paused" ||
      !this.intent ||
      this.intent.primingAttempted ||
      this.pausedPrime ||
      this.frameVerified ||
      !this.supportsFrames(this.options.media.read())
    )
      return;
    this.intent.primingAttempted = true;
    this.pausedPrime = {
      revision: this.active.revision,
      deadlineMs: Math.min(
        this.options.clock.monotonicNowMs() + 3_000,
        this.intent.startedAtMs + 10_000,
      ),
    };
    this.options.media.setPrimingMuted(true);
    this.requestPlay(fromGesture);
  }

  private frame(media: VodMediaState): VodPresentedFrame | null {
    return media.frame ?? this.presentedFrame;
  }

  private supportsFrames(media: VodMediaState): boolean {
    return media.frameEvidenceSupported ?? this.frame(media) !== null;
  }

  private clearTimeline(): void {
    this.stopPausedPrime();
    this.generation += 1;
    this.accepted = null;
    this.active = null;
    this.pending = [];
    this.intent = null;
    this.error = null;
    this.blocked = false;
    this.blockedAtMs = null;
    this.playPending = false;
    this.lastHardSeekMs = Number.NEGATIVE_INFINITY;
    this.softCooldownUntilMs = 0;
    this.presentedFrame = null;
    this.frameVerified = false;
    this.lastIntentCommandKey = null;
  }

  private publish(
    phase: VodPhase,
    targetSec: number | null,
    driftSec: number | null,
  ): void {
    const media = this.options.media.read();
    const frame = this.frame(media);
    this.status = {
      activeRevision: this.active?.revision ?? null,
      mediaId: this.active?.mediaId ?? null,
      phase,
      targetSec,
      driftSec,
      intentId: this.intent?.id ?? null,
      seekAttempts: this.intent?.attempts ?? 0,
      error: this.error,
      frameEvidence: !this.supportsFrames(media)
        ? "unavailable"
        : this.frameVerified
          ? "verified"
          : "pending",
      presentedTimeSec: frame?.mediaTime ?? null,
    };
    this.options.onStatus?.(this.getStatus());
  }
}

function targetAt(
  anchor: TransportAnchor,
  serverMs: number,
  duration: number,
): number {
  const elapsed =
    anchor.state === "playing"
      ? Math.max(0, serverMs - anchor.anchoredAtServerMs) / 1_000
      : 0;
  const target = Math.max(0, anchor.positionSec + elapsed * anchor.rate);
  return Number.isFinite(duration) && duration > 0
    ? Math.min(duration, target)
    : target;
}

function atMediaEnd(media: VodMediaState, target: number): boolean {
  return (
    Number.isFinite(media.duration) &&
    media.duration > 0 &&
    target >= media.duration - 0.01 &&
    media.currentTime >= media.duration - 0.01
  );
}

function nearIssuedTarget(media: VodMediaState, intent: SeekIntent): boolean {
  return nearIssuedPosition(media.currentTime, intent, false);
}

function nearIssuedPosition(
  position: number,
  intent: SeekIntent,
  paused: boolean,
): boolean {
  if (intent.issuedTargetSec === null) return false;
  // Position assignment alone is not proof. This only gates independent seek
  // and rendered-frame evidence collected by advanceIntent.
  return (
    position >= intent.issuedTargetSec - 0.15 &&
    position <= intent.issuedTargetSec + (paused ? 0.15 : 3)
  );
}
