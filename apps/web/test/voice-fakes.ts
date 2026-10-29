import { vi } from "vitest";

export class FakeAudioParam {
  value = 1;
  readonly writes: Array<{ kind: string; value: number; at: number }> = [];
  setValueAtTime(value: number, at: number) {
    this.value = value;
    this.writes.push({ kind: "set", value, at });
    return this;
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.value = value;
    this.writes.push({ kind: "ramp", value, at });
    return this;
  }
  cancelScheduledValues(at: number) {
    this.writes.push({ kind: "cancel", value: this.value, at });
    return this;
  }
  cancelAndHoldAtTime(at: number) {
    this.writes.push({ kind: "hold", value: this.value, at });
    return this;
  }
}

export class FakeAudioNode {
  channelCount = 2;
  channelCountMode = "max";
  channelInterpretation = "speakers";
  connections: FakeAudioNode[] = [];
  disconnect = vi.fn(() => {
    this.connections = [];
  });
  connect(node: FakeAudioNode) {
    this.connections.push(node);
    return node;
  }
}

export class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}
export class FakeCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam();
  knee = new FakeAudioParam();
  ratio = new FakeAudioParam();
  attack = new FakeAudioParam();
  release = new FakeAudioParam();
  reduction = 0;
}
export class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 256;
  smoothingTimeConstant = 0;
  sample = 0;
  getFloatTimeDomainData(array: Float32Array) {
    array.fill(this.sample);
  }
}

export class FakeMediaTrack extends EventTarget {
  readonly kind = "audio";
  enabled = true;
  readyState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  constructor(
    readonly settings: MediaTrackSettings = {
      channelCount: 1,
      deviceId: "mic-one",
    },
  ) {
    super();
  }
  getSettings() {
    return this.settings;
  }
}
export class FakeMediaStream {
  constructor(readonly tracks: FakeMediaTrack[] = []) {}
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

export class FakeAudioElement extends EventTarget {
  static instances: FakeAudioElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  defaultMuted = false;
  muted = false;
  volume = 1;
  autoplay = false;
  hidden = false;
  tabIndex = 0;
  isConnected = false;
  srcObject: FakeMediaStream | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  load = vi.fn();
  remove = vi.fn(() => {
    this.isConnected = false;
  });
  constructor() {
    super();
    FakeAudioElement.instances.push(this);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}
export class FakeDestination extends FakeAudioNode {
  readonly stream = new FakeMediaStream([new FakeMediaTrack()]);
}

export class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = [];
  state = "suspended";
  currentTime = 0;
  readonly destination = new FakeAudioNode();
  readonly gains: FakeGainNode[] = [];
  readonly compressors: FakeCompressorNode[] = [];
  readonly analysers: FakeAnalyserNode[] = [];
  readonly sources: FakeAudioNode[] = [];
  readonly destinations: FakeDestination[] = [];
  constructor() {
    super();
    FakeAudioContext.instances.push(this);
  }
  createGain() {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeCompressorNode();
    this.compressors.push(node);
    return node;
  }
  createAnalyser() {
    const node = new FakeAnalyserNode();
    this.analysers.push(node);
    return node;
  }
  createMediaStreamSource() {
    const node = new FakeAudioNode();
    this.sources.push(node);
    return node;
  }
  createMediaStreamDestination() {
    const node = new FakeDestination();
    this.destinations.push(node);
    return node;
  }
  resume = vi.fn(() => {
    this.state = "running";
    this.currentTime += 0.02;
    this.dispatchEvent(new Event("statechange"));
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = "closed";
    this.dispatchEvent(new Event("statechange"));
    return Promise.resolve();
  });
}

export interface FakeProcessor {
  init(options: {
    track: MediaStreamTrack;
    audioContext: AudioContext;
    kind: string;
  }): Promise<void>;
  destroy(): Promise<void>;
  processedTrack?: MediaStreamTrack;
}

export class FakeLocalAudioTrack {
  source = "microphone";
  isMuted = false;
  processor: FakeProcessor | null = null;
  static instances: FakeLocalAudioTrack[] = [];
  constructor(
    readonly raw: FakeMediaTrack,
    readonly constraints: MediaTrackConstraints,
    readonly userProvided: boolean,
    readonly context: AudioContext,
  ) {
    FakeLocalAudioTrack.instances.push(this);
  }
  async setProcessor(processor: FakeProcessor) {
    await processor.init({
      kind: "audio",
      track: this.raw as unknown as MediaStreamTrack,
      audioContext: this.context,
    });
    this.processor = processor;
  }
  mute = vi.fn(() => {
    this.isMuted = true;
    this.raw.enabled = false;
    return Promise.resolve(this);
  });
  unmute = vi.fn(() => {
    this.isMuted = false;
    this.raw.enabled = true;
    return Promise.resolve(this);
  });
  stop = vi.fn(() => {
    this.raw.stop();
    void this.processor?.destroy();
  });
  getRTCStatsReport() {
    return Promise.resolve(undefined);
  }
}

type Callback = (...args: unknown[]) => void;
export class FakeRoom {
  static instances: FakeRoom[] = [];
  static connectGate: Promise<void> | null = null;
  static publishGate: Promise<void> | null = null;
  readonly callbacks = new Map<string, Callback[]>();
  readonly remoteParticipants = new Map<string, unknown>();
  readonly localParticipant = {
    publishTrack: vi.fn(async (_track: unknown, _options: unknown) => {
      void _track;
      void _options;
      if (FakeRoom.publishGate) await FakeRoom.publishGate;
    }),
    unpublishTrack: vi.fn(() => Promise.resolve()),
  };
  constructor(readonly options: unknown) {
    FakeRoom.instances.push(this);
  }
  on(event: string, callback: Callback) {
    const list = this.callbacks.get(event) ?? [];
    list.push(callback);
    this.callbacks.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const callback of this.callbacks.get(event) ?? []) callback(...args);
  }
  connect = vi.fn(async () => {
    if (FakeRoom.connectGate) await FakeRoom.connectGate;
  });
  disconnect = vi.fn(() => Promise.resolve());
  startAudio = vi.fn(() => Promise.resolve());
  removeAllListeners() {
    this.callbacks.clear();
  }
}

export const fakeRoomEvents = {
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  TrackMuted: "trackMuted",
  TrackUnmuted: "trackUnmuted",
  ActiveSpeakersChanged: "activeSpeakersChanged",
  Reconnecting: "reconnecting",
  SignalReconnecting: "signalReconnecting",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
};

export class FakeLockManager {
  readonly held = new Map<string, { release: () => void }>();
  readonly waiting = new Map<string, Array<() => void>>();

  request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: { name: string } | null) => Promise<T>,
  ): Promise<T> {
    if (options.ifAvailable && this.held.has(name)) return callback(null);
    if (options.signal?.aborted)
      return Promise.reject(new DOMException("aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        if (options.signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        const done = () => {
          this.held.delete(name);
          const next = this.waiting.get(name)?.shift();
          next?.();
        };
        this.held.set(name, { release: done });
        void callback({ name }).then(resolve, reject).finally(done);
      };
      if (!this.held.has(name)) run();
      else {
        const list = this.waiting.get(name) ?? [];
        list.push(run);
        this.waiting.set(name, list);
        options.signal?.addEventListener(
          "abort",
          () => {
            const index = list.indexOf(run);
            if (index >= 0) list.splice(index, 1);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      }
    });
  }
}

export class FakeBroadcastChannel extends EventTarget {
  static channels = new Set<FakeBroadcastChannel>();
  constructor(readonly name: string) {
    super();
    FakeBroadcastChannel.channels.add(this);
  }
  postMessage(data: unknown) {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel !== this && channel.name === this.name)
        channel.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
  close() {
    FakeBroadcastChannel.channels.delete(this);
  }
}

export function installVoiceBrowser() {
  FakeAudioContext.instances = [];
  FakeAudioElement.instances = [];
  FakeLocalAudioTrack.instances = [];
  FakeRoom.instances = [];
  FakeRoom.connectGate = null;
  FakeRoom.publishGate = null;
  FakeBroadcastChannel.channels.clear();
  const locks = new FakeLockManager();
  const mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn<() => Promise<FakeMediaStream>>(() =>
      Promise.resolve(new FakeMediaStream([new FakeMediaTrack()])),
    ),
    enumerateDevices: vi.fn<
      () => Promise<
        Array<
          Pick<MediaDeviceInfo, "kind" | "deviceId"> &
            Partial<Pick<MediaDeviceInfo, "groupId">>
        >
      >
    >(() => Promise.resolve([{ kind: "audioinput", deviceId: "mic-one" }])),
  });
  const window = Object.assign(new EventTarget(), {
    AudioContext: FakeAudioContext,
  });
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    createElement: vi.fn((tag: string) => {
      if (tag !== "audio") throw new Error("Unexpected test element");
      return new FakeAudioElement();
    }),
    body: {
      append: vi.fn((element: FakeAudioElement) => {
        element.isConnected = true;
      }),
    },
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { locks, mediaDevices });
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  return { locks, mediaDevices, window, document };
}
