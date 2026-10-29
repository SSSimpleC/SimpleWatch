import {
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type LocalTrack,
  type RemoteAudioTrack,
  type RemoteParticipant,
} from "livekit-client";
import { MicrophoneGainProcessor, VoiceAudioGraph } from "./audio-graph.js";
import {
  captureChannels,
  captureConstraints,
  concreteInputDeviceId,
  isPermissionError,
  isRelaxableCaptureError,
  memberForIdentity,
  normalizeVoiceSettings,
  voicePublishOptions,
} from "./policy.js";
import {
  emptyVoiceStats,
  VoiceStatsAccumulator,
  type VoiceStatsSample,
} from "./stats.js";
import { VoiceTabCoordinator } from "./tab-coordinator.js";
import {
  initialVoiceState,
  type VoiceCredentials,
  type VoiceDiagnostics,
  type VoiceMember,
  type VoiceSessionState,
  type VoiceSettings,
} from "./types.js";

export interface VoiceSessionOptions {
  accountId: string;
  roomId: string;
  members: readonly VoiceMember[];
  settings: VoiceSettings;
  getCredentials: (signal: AbortSignal) => Promise<VoiceCredentials>;
  onState: (state: VoiceSessionState) => void;
  onSpeakers?: (memberIds: readonly string[]) => void;
  resolveMicrophoneGain?: (deviceId: string) => number;
}

interface RemoteVoice {
  track: RemoteAudioTrack;
  identity: string;
}

interface MicrophoneCapture {
  raw: MediaStreamTrack;
  deviceId: string;
  local: LocalAudioTrack;
  processor: MicrophoneGainProcessor;
  room: Room;
  pushToTalk: boolean;
}

// SDK 2.23's public LocalAudioTrack extends LocalTrack, but its processor declaration
// is not assignable under exactOptionalPropertyTypes. Preserve the object (not raw track).
function sdkTrack(track: LocalAudioTrack): LocalTrack {
  return track as unknown as LocalTrack;
}

/** One owner of all room voice resources. It never accesses the program video element. */
export class VoiceSession {
  private settings: VoiceSettings;
  private members: readonly VoiceMember[];
  private state: VoiceSessionState = { ...initialVoiceState };
  private readonly tabs: VoiceTabCoordinator;
  private room: Room | null = null;
  private graph: VoiceAudioGraph | null = null;
  private capture: MicrophoneCapture | null = null;
  private readonly remotes = new Map<string, RemoteVoice>();
  private readonly speaking = new Set<string>();
  private generation = 0;
  private captureGeneration = 0;
  private disposed = false;
  private disconnecting: Promise<void> | null = null;
  private leaving: Promise<void> | null = null;
  private connecting: Promise<void> | null = null;
  private opening: Promise<void> | null = null;
  private microphoneClosing: Promise<void> | null = null;
  private credentialsAbort: AbortController | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly accumulator = new VoiceStatsAccumulator();
  private stats: VoiceStatsSample = { ...emptyVoiceStats };
  private statsPending = false;
  private lastContextTime = 0;
  private lastContextAdvanceAt = 0;
  private pttPressed = false;
  private microphoneMutation: Promise<void> = Promise.resolve();
  private lastEmission = "";

  constructor(private readonly options: VoiceSessionOptions) {
    this.settings = normalizeVoiceSettings(options.settings);
    this.members = options.members;
    this.tabs = new VoiceTabCoordinator(options.accountId, async () => {
      await this.leaveTransport();
      this.patch({
        connection: "other-tab",
        error: "语音已交给另一标签页；影片播放不受影响",
      });
    });
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("pointerup", this.onPointerReleased);
    window.addEventListener("pointercancel", this.onPointerReleased);
    navigator.mediaDevices?.addEventListener(
      "devicechange",
      this.onDevicesChanged,
    );
    this.emit();
  }

  getState(): VoiceSessionState {
    return this.state;
  }

  connect(): Promise<void> {
    return this.connectWithOwnership(false);
  }

  takeOverTab(): Promise<void> {
    return this.connectWithOwnership(true);
  }

  private connectWithOwnership(takeover: boolean): Promise<void> {
    if (
      this.disposed ||
      this.state.connection === "connected" ||
      this.state.connection === "reconnecting"
    )
      return Promise.resolve();
    if (this.connecting) return this.connecting;
    const work = this.startConnection(takeover);
    this.connecting = work;
    void work.finally(() => {
      if (this.connecting === work) this.connecting = null;
    });
    return work;
  }

  private async startConnection(takeover: boolean): Promise<void> {
    if (!this.tabs.supported) {
      this.patch({
        connection: "unsupported",
        error:
          "此浏览器缺少安全的标签页语音协调能力，请使用较新的浏览器；影片仍可播放",
      });
      return;
    }
    const generation = ++this.generation;
    this.patch({ connection: "connecting", error: null });
    const owned = await this.tabs.acquire(takeover);
    if (this.disposed || generation !== this.generation) {
      if (owned) this.tabs.release();
      return;
    }
    if (!owned) {
      this.patch({
        connection: "other-tab",
        error: "语音由另一标签页使用；可在此接管，或关闭原标签页后重试",
      });
      return;
    }
    const abort = new AbortController();
    this.credentialsAbort = abort;
    let createdRoom: Room | null = null;
    try {
      // Authentication/service availability is independent of local audio.
      // A denied or cancelled join must not create and close the device's
      // audio context while the unrelated programme video is already playing.
      const credentials = await this.options.getCredentials(abort.signal);
      if (
        this.disposed ||
        generation !== this.generation ||
        abort.signal.aborted
      )
        return;
      const AudioContextClass = window.AudioContext;
      if (!AudioContextClass)
        throw new Error("浏览器不支持增强语音音频引擎；影片播放不受影响");
      const context = new AudioContextClass({ latencyHint: "interactive" });
      this.graph = new VoiceAudioGraph(
        context,
        this.settings.masterVolume,
        () => {
          if (!this.disposed && generation === this.generation) {
            this.patch({ output: "awaiting-gesture" });
          }
        },
      );
      context.addEventListener("statechange", this.onContextStateChange);
      this.lastContextTime = context.currentTime;
      this.lastContextAdvanceAt = performance.now();
      const room = new Room({ webAudioMix: { audioContext: context } });
      createdRoom = room;
      // Retain before any await, so leave/close can cancel a slow connect.
      this.room = room;
      this.registerRoomEvents(room, generation);
      await room.connect(credentials.url, credentials.token, {
        autoSubscribe: true,
      });
      if (!this.isCurrent(room, generation)) {
        await room.disconnect();
        return;
      }
      this.patch({ connection: "connected", error: null });
      this.startSampling();
      this.refreshParticipants();
      // It may be allowed already. Failure means a gesture is needed, not an RTC failure.
      void this.enableAudio();
    } catch {
      if (generation !== this.generation || this.disposed) return;
      await this.leaveTransport();
      this.tabs.release();
      this.patch({
        connection: "error",
        error: "语音连接失败，请重试；不会影响影片，也没有开启麦克风",
      });
    } finally {
      if (this.credentialsAbort === abort) this.credentialsAbort = null;
      if (createdRoom && (this.disposed || generation !== this.generation)) {
        await createdRoom.disconnect().catch(() => undefined);
      }
    }
  }

  /** Call directly inside a user gesture; do not await another operation first. */
  async enableAudio(): Promise<void> {
    const graph = this.graph;
    const room = this.room;
    if (!graph || !room || this.disposed) return;
    const generation = this.generation;
    try {
      // Both operations are invoked synchronously before awaiting either one.
      const resume = graph.context.resume();
      const startAudio = room.startAudio();
      const playout = graph.resumePlayback();
      const results = await Promise.allSettled([resume, startAudio, playout]);
      if (!this.isCurrent(room, generation)) return;
      if (
        graph.context.state !== "running" ||
        results.some((result) => result.status === "rejected")
      ) {
        this.patch({
          output:
            this.state.output === "running"
              ? "interrupted"
              : "awaiting-gesture",
        });
      } else {
        this.lastContextAdvanceAt = performance.now();
        // A running state alone is insufficient: the meter tick also observes clock progress.
        this.sampleLevels();
      }
    } catch {
      if (!this.isCurrent(room, generation)) return;
      this.patch({
        output:
          this.state.output === "running" ? "interrupted" : "awaiting-gesture",
      });
    }
  }

  updateMembers(members: readonly VoiceMember[]): void {
    this.members = members;
    this.applyRemoteVolumes();
    this.refreshParticipants();
  }

  updateSettings(settings: VoiceSettings): void {
    const next = normalizeVoiceSettings(settings);
    const inputChanged = next.inputDeviceId !== this.settings.inputDeviceId;
    const captureChanged = inputChanged || next.mode !== this.settings.mode;
    this.settings = next;
    if (inputChanged) this.patch({ activeInputDeviceId: "" });
    this.graph?.setMasterVolume(next.masterVolume);
    this.applyRemoteVolumes();
    this.capture?.processor.setVolume(
      this.state.activeInputDeviceId ? next.microphoneGain : 100,
    );
    if (captureChanged && (this.capture || this.opening)) {
      // Device/mode changes are privacy-sensitive: do not silently recapture on a passive update.
      void this.closeMicrophone();
      this.patch({
        microphoneError: "输入设备或音质模式已更新，请重新开启麦克风",
      });
    }
  }

  openMicrophone(pushToTalk = false): Promise<void> {
    if (
      this.disposed ||
      this.state.connection !== "connected" ||
      !this.room ||
      !this.graph
    )
      return Promise.resolve();
    if (this.capture) return Promise.resolve();
    if (this.opening) return this.opening;
    void this.enableAudio();
    const generation = ++this.captureGeneration;
    this.pttPressed = false;
    this.patch({ microphone: "requesting", microphoneError: null });
    const work = this.captureAndPublish(
      this.room,
      this.graph,
      generation,
      pushToTalk,
    );
    this.opening = work;
    void work.finally(() => {
      if (this.opening === work) this.opening = null;
    });
    return work;
  }

  private async captureAndPublish(
    room: Room,
    graph: VoiceAudioGraph,
    generation: number,
    pushToTalk: boolean,
  ): Promise<void> {
    let stream: MediaStream | null = null;
    let local: LocalAudioTrack | null = null;
    let processor: MicrophoneGainProcessor | null = null;
    const settings = { ...this.settings };
    let constraints = captureConstraints(settings);
    try {
      // A stopped raw track is not yet an unpublished SDK sender. Never let a
      // new capture/publish reuse that sender while its teardown is in flight.
      if (this.microphoneClosing) await this.microphoneClosing;
      if (!this.captureIsCurrent(room, generation)) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: constraints,
          video: false,
        });
      } catch (error) {
        if (
          !isRelaxableCaptureError(error) ||
          !this.captureIsCurrent(room, generation)
        )
          throw error;
        constraints = captureConstraints(settings, true);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: constraints,
          video: false,
        });
      }
      if (!this.captureIsCurrent(room, generation)) return;
      const raw = stream.getAudioTracks()[0];
      if (!raw) throw new Error("没有可用麦克风音轨");
      const actual = raw.getSettings();
      let actualDeviceId = concreteInputDeviceId(actual);
      if (!actualDeviceId && actual.groupId) {
        const devices = await navigator.mediaDevices
          .enumerateDevices()
          .catch(() => []);
        if (!this.captureIsCurrent(room, generation)) return;
        actualDeviceId = concreteInputDeviceId(actual, devices);
      }
      const channels = captureChannels(actual);
      const gain = actualDeviceId
        ? (this.options.resolveMicrophoneGain?.(actualDeviceId) ??
          this.settings.microphoneGain)
        : 100;
      processor = new MicrophoneGainProcessor(gain, channels.channels);
      local = new LocalAudioTrack(raw, constraints, true, graph.context);
      local.source = Track.Source.Microphone;
      await local.setProcessor(processor);
      if (!this.captureIsCurrent(room, generation)) return;
      const capture: MicrophoneCapture = {
        raw,
        deviceId: actualDeviceId,
        local,
        processor,
        room,
        pushToTalk,
      };
      this.capture = capture;
      raw.addEventListener("ended", this.onInputEnded);
      // Publish with a closed gate. Permission/publish races must never leak a first frame.
      await local.mute();
      await room.localParticipant.publishTrack(
        sdkTrack(local),
        voicePublishOptions(settings.mode, channels.channels),
      );
      if (!this.captureIsCurrent(room, generation) || this.capture !== capture)
        return;
      this.patch({
        microphone: pushToTalk ? "armed" : "transmitting",
        captureChannels: channels.channels,
        captureChannelsConfirmed: channels.confirmed,
        activeInputDeviceId: actualDeviceId,
      });
      if (!pushToTalk) {
        await local.unmute();
        if (this.captureIsCurrent(room, generation) && this.capture === capture)
          processor.setSending(true);
      } else if (this.pttPressed) {
        this.setPushToTalkPressed(true);
      }
      // The capture now owns these resources until closeMicrophone().
      stream = null;
      local = null;
      processor = null;
    } catch (error) {
      if (!this.captureIsCurrent(room, generation)) return;
      await this.closeMicrophone();
      this.patch({
        microphone: "error",
        microphoneError: isPermissionError(error)
          ? "麦克风权限未授予，仍可收听语音和影片；允许权限后再开麦"
          : "麦克风采集或发布失败，请检查输入设备后重试；收听不受影响",
      });
    } finally {
      if (local) {
        await room.localParticipant
          .unpublishTrack(sdkTrack(local))
          .catch(() => undefined);
        local.stop();
      }
      if (processor) await processor.destroy();
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  setPushToTalkPressed(pressed: boolean): void {
    const capture = this.capture;
    if (!capture?.pushToTalk || this.disposed) return;
    this.pttPressed = pressed;
    const generation = this.captureGeneration;
    // Close synchronously, even if an earlier unmute is still awaiting the SDK lock.
    if (!pressed) capture.processor.setSending(false);
    this.microphoneMutation = this.microphoneMutation
      .catch(() => undefined)
      .then(async () => {
        if (this.capture !== capture || generation !== this.captureGeneration)
          return;
        if (!this.pttPressed) {
          capture.processor.setSending(false);
          await capture.local.mute();
          if (this.capture === capture) this.patch({ microphone: "armed" });
        } else {
          await capture.local.unmute();
          if (
            this.capture === capture &&
            generation === this.captureGeneration &&
            this.pttPressed
          ) {
            capture.processor.setSending(true);
            this.patch({ microphone: "transmitting" });
          } else {
            capture.processor.setSending(false);
            await capture.local.mute();
          }
        }
      })
      .catch(() => {
        if (this.capture === capture) {
          void this.closeMicrophone();
          this.patch({ microphoneError: "按键说话已安全关闭，请重新开启" });
        }
      });
  }

  async closeMicrophone(): Promise<void> {
    ++this.captureGeneration;
    this.pttPressed = false;
    const capture = this.capture;
    this.capture = null;
    this.patch({
      microphone: "off",
      inputLevel: 0,
      inputOverloaded: false,
      captureChannels: null,
      captureChannelsConfirmed: false,
    });
    if (capture) {
      capture.processor.setSending(false);
      capture.raw.removeEventListener("ended", this.onInputEnded);
      // Stop the actual device synchronously; do not wait for network acknowledgement.
      capture.raw.stop();
      capture.local.stop();
      const previous = this.microphoneClosing;
      const cleanup = (async () => {
        if (previous) await previous;
        await capture.processor.destroy();
        await capture.room.localParticipant
          .unpublishTrack(sdkTrack(capture.local))
          .catch(() => undefined);
      })();
      this.microphoneClosing = cleanup;
      const clear = () => {
        if (this.microphoneClosing === cleanup) this.microphoneClosing = null;
      };
      void cleanup.then(clear, clear);
    }
    await this.microphoneClosing;
  }

  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.disconnecting = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.disposed = true;
    // Register the completion promise before cleanup emits state to a consumer.
    // Repeated dispose/unmount calls must wait for the same lock/context release.
    void this.finishDisconnect().then(resolve, reject);
    return this.disconnecting;
  }

  private async finishDisconnect(): Promise<void> {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("pointerup", this.onPointerReleased);
    window.removeEventListener("pointercancel", this.onPointerReleased);
    navigator.mediaDevices?.removeEventListener(
      "devicechange",
      this.onDevicesChanged,
    );
    await this.leaveTransport();
    await this.tabs.dispose();
    this.patch({ connection: "closed", error: null });
  }

  getDiagnostics(): VoiceDiagnostics {
    return {
      version: 1,
      connection: this.state.connection,
      output: this.state.output,
      microphone: this.state.microphone,
      mode: this.settings.mode,
      targetBitrateKbps: 96,
      captureChannels: this.state.captureChannels,
      captureChannelsConfirmed: this.state.captureChannelsConfirmed,
      contextState: this.graph?.context.state ?? "closed",
      inputLevel: this.state.inputLevel,
      inputOverloaded: this.state.inputOverloaded,
      outputOverloaded: this.state.outputOverloaded,
      receivedTrackCount: this.remotes.size,
      ...this.stats,
    };
  }

  private registerRoomEvents(room: Room, generation: number): void {
    const current = () => this.isCurrent(room, generation);
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (!current() || track.kind !== Track.Kind.Audio) return;
      this.remotes.set(publication.trackSid, {
        track: track as RemoteAudioTrack,
        identity: participant.identity,
      });
      this.graph?.addTrack(
        publication.trackSid,
        track.mediaStreamTrack,
        this.remoteVolume(participant.identity),
      );
      this.refreshParticipants();
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track, publication) => {
      if (!current()) return;
      this.graph?.removeTrack(publication.trackSid);
      this.remotes.delete(publication.trackSid);
      this.refreshParticipants();
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      if (current()) this.refreshParticipants();
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (!current()) return;
      for (const [id, remote] of this.remotes) {
        if (remote.identity === participant.identity) {
          this.graph?.removeTrack(id);
          this.remotes.delete(id);
        }
      }
      this.refreshParticipants();
    });
    room.on(RoomEvent.TrackMuted, () => {
      if (current()) this.refreshParticipants();
    });
    room.on(RoomEvent.TrackUnmuted, () => {
      if (current()) this.refreshParticipants();
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (participants) => {
      if (!current()) return;
      this.speaking.clear();
      for (const participant of participants) {
        const member = memberForIdentity(participant.identity, this.members);
        if (member) this.speaking.add(member.id);
      }
      this.options.onSpeakers?.([...this.speaking]);
      this.refreshParticipants();
    });
    const reconnecting = () => {
      if (!current()) return;
      void this.closeMicrophone();
      this.patch({ connection: "reconnecting" });
    };
    room.on(RoomEvent.Reconnecting, reconnecting);
    room.on(RoomEvent.SignalReconnecting, reconnecting);
    room.on(RoomEvent.Reconnected, () => {
      if (!current()) return;
      this.patch({ connection: "connected" });
      this.applyRemoteVolumes();
      void this.enableAudio();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!current()) return;
      // Explicit retry only. An old tab/device must not automatically fight a takeover.
      void this.leaveTransport().then(() => {
        this.tabs.release();
        if (!this.disposed)
          this.patch({
            connection: "error",
            error: "语音连接已结束，可重试连接；麦克风已关闭",
          });
      });
    });
  }

  private remoteVolume(identity: string): number {
    const member = memberForIdentity(identity, this.members);
    // Never play an unrecognised participant at default volume while membership catches up.
    if (!member) return 0;
    const key = member.accountId ?? `member:${member.id}`;
    return this.settings.participantVolumes[key] ?? 100;
  }

  private applyRemoteVolumes(): void {
    for (const [id, remote] of this.remotes)
      this.graph?.setTrackVolume(id, this.remoteVolume(remote.identity));
  }

  private refreshParticipants(
    levels: ReadonlyMap<string, number> = new Map(),
  ): void {
    const participants = this.members
      .filter((member) => member.accountId !== this.options.accountId)
      .map((member) => {
        const remoteParticipant = [
          ...(this.room?.remoteParticipants.values() ?? []),
        ].find(
          (participant) =>
            memberForIdentity(participant.identity, this.members)?.id ===
            member.id,
        );
        const tracks = [...this.remotes].filter(
          ([, remote]) =>
            memberForIdentity(remote.identity, this.members)?.id === member.id,
        );
        return {
          memberId: member.id,
          accountId: member.accountId,
          nickname: member.nickname,
          connected: Boolean(remoteParticipant),
          subscribed: tracks.length > 0,
          muted: this.remoteMuted(remoteParticipant),
          speaking: this.speaking.has(member.id),
          level:
            Math.round(
              Math.max(0, ...tracks.map(([id]) => levels.get(id) ?? 0)) * 100,
            ) / 100,
        };
      });
    this.patch({ participants });
  }

  private remoteMuted(participant: RemoteParticipant | undefined): boolean {
    if (!participant) return true;
    const publications = [...participant.audioTrackPublications.values()];
    return (
      publications.length === 0 ||
      publications.every((publication) => publication.isMuted)
    );
  }

  private startSampling(): void {
    if (this.meterTimer) clearInterval(this.meterTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.meterTimer = setInterval(() => {
      if (document.visibilityState === "visible") this.sampleLevels();
    }, 100);
    this.statsTimer = setInterval(() => {
      if (document.visibilityState === "visible") void this.sampleStats();
    }, 2_000);
    this.sampleLevels();
  }

  private sampleLevels(): void {
    const graph = this.graph;
    if (!graph || this.disposed) return;
    const time = graph.context.currentTime;
    if (graph.playbackBlocked) {
      this.state = { ...this.state, output: "awaiting-gesture" };
    } else if (
      graph.context.state === "running" &&
      time > this.lastContextTime
    ) {
      this.lastContextAdvanceAt = performance.now();
      this.state = { ...this.state, output: "running" };
    } else if (
      this.state.output === "running" &&
      performance.now() - this.lastContextAdvanceAt > 600
    ) {
      this.state = { ...this.state, output: "interrupted" };
    }
    this.lastContextTime = time;
    const output = graph.readLevels();
    const input = this.capture?.processor.readLevel() ?? {
      level: 0,
      overloaded: false,
    };
    this.state = {
      ...this.state,
      inputLevel: Math.round(input.level * 100) / 100,
      inputOverloaded: input.overloaded,
      outputOverloaded: output.overloaded,
    };
    this.refreshParticipants(output.tracks);
  }

  private async sampleStats(): Promise<void> {
    if (this.statsPending || !this.room) return;
    this.statsPending = true;
    const generation = this.generation;
    try {
      const tracks = [...this.remotes].map(([key, remote]) => ({
        key,
        track: remote.track,
      }));
      const reports = await Promise.all(
        tracks.map(async ({ key, track }) => ({
          key,
          report: await track.getRTCStatsReport().catch(() => undefined),
        })),
      );
      const localReport = await this.capture?.local
        .getRTCStatsReport()
        .catch(() => undefined);
      if (localReport) reports.push({ key: "local", report: localReport });
      if (generation !== this.generation || this.disposed) return;
      this.stats = this.accumulator.sample(
        reports.filter(
          (item): item is { key: string; report: RTCStatsReport } =>
            Boolean(item.report),
        ),
        Date.now(),
      );
    } catch {
      // Stats are optional observations, never a reason to interrupt audio or create rejection loops.
      if (generation === this.generation) this.stats = { ...emptyVoiceStats };
    } finally {
      this.statsPending = false;
    }
  }

  private leaveTransport(): Promise<void> {
    if (this.leaving) return this.leaving;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const work = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.leaving = work;
    void this.finishLeavingTransport().then(
      () => {
        if (this.leaving === work) this.leaving = null;
        resolve();
      },
      (error: unknown) => {
        if (this.leaving === work) this.leaving = null;
        reject(error);
      },
    );
    return work;
  }

  private async finishLeavingTransport(): Promise<void> {
    ++this.generation;
    this.credentialsAbort?.abort();
    this.credentialsAbort = null;
    if (this.meterTimer) clearInterval(this.meterTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.meterTimer = null;
    this.statsTimer = null;
    const room = this.room;
    const graph = this.graph;
    graph?.silenceOutput();
    this.room = null;
    this.graph = null;
    graph?.context.removeEventListener(
      "statechange",
      this.onContextStateChange,
    );
    await this.closeMicrophone();
    room?.removeAllListeners();
    await room?.disconnect().catch(() => undefined);
    await graph?.destroy().catch(() => undefined);
    this.remotes.clear();
    this.speaking.clear();
    this.options.onSpeakers?.([]);
    this.accumulator.reset();
    this.stats = { ...emptyVoiceStats };
    this.patch({
      participants: [],
      output: "awaiting-gesture",
      outputOverloaded: false,
    });
  }

  private isCurrent(room: Room, generation: number): boolean {
    return (
      !this.disposed && this.room === room && this.generation === generation
    );
  }

  private captureIsCurrent(room: Room, generation: number): boolean {
    return (
      !this.disposed &&
      this.room === room &&
      this.captureGeneration === generation &&
      this.state.connection === "connected"
    );
  }

  private patch(change: Partial<VoiceSessionState>): void {
    this.state = { ...this.state, ...change };
    this.emit();
  }

  private emit(): void {
    const serialized = JSON.stringify(this.state);
    if (serialized === this.lastEmission) return;
    this.lastEmission = serialized;
    this.options.onState(this.state);
  }

  private readonly onContextStateChange = (): void => {
    const context = this.graph?.context;
    if (!context) return;
    if (context.state === "closed") this.patch({ output: "failed" });
    else if (context.state !== "running")
      this.patch({
        output:
          this.state.output === "running" ? "interrupted" : "awaiting-gesture",
      });
  };

  private readonly onVisibilityChange = (): void => {
    this.accumulator.reset();
    this.stats = { ...emptyVoiceStats };
    if (document.visibilityState !== "visible") void this.closeMicrophone();
    else if (this.state.connection === "connected") void this.enableAudio();
  };

  private readonly onBlur = (): void => {
    void this.closeMicrophone();
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.setPushToTalkPressed(false);
  };
  private readonly onPointerReleased = (): void => {
    this.setPushToTalkPressed(false);
  };
  private readonly onInputEnded = (): void => {
    void this.closeMicrophone();
    this.patch({
      activeInputDeviceId: "",
      microphoneError: "麦克风已被系统中断，请检查输入设备后重新开启",
    });
  };
  private readonly onDevicesChanged = (): void => {
    const capture = this.capture;
    // Publishing can still be pending when permission reveals new device
    // labels. Use the capture's identity, not the not-yet-published UI state.
    const deviceId = capture?.deviceId ?? this.state.activeInputDeviceId;
    if (!deviceId) return;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (
          this.capture !== capture ||
          (capture === null && this.state.activeInputDeviceId !== deviceId)
        )
          return;
        const stillPresent = devices.some(
          (device) =>
            device.kind === "audioinput" && device.deviceId === deviceId,
        );
        // A system-default route can switch while both physical devices remain
        // connected. Stop rather than applying the old hardware's gain to it.
        const actualDeviceId = capture
          ? concreteInputDeviceId(capture.raw.getSettings(), devices)
          : deviceId;
        if (!stillPresent || actualDeviceId !== deviceId) this.onInputEnded();
      })
      .catch(() => undefined);
  };
}
