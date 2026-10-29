import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";
import { volumeGain } from "./policy.js";

export const voiceCompressorSettings = {
  threshold: -6,
  knee: 6,
  ratio: 20,
  attack: 0.003,
  release: 0.15,
} as const;

export function configureVoiceCompressor(node: DynamicsCompressorNode): void {
  for (const key of Object.keys(voiceCompressorSettings) as Array<
    keyof typeof voiceCompressorSettings
  >) {
    node[key].value = voiceCompressorSettings[key];
  }
}

/** Zero is a gate operation, not a twenty-millisecond fade. */
export function setVoiceGain(
  parameter: AudioParam,
  value: number,
  time: number,
  immediate = false,
): void {
  if (immediate || value === 0) {
    parameter.cancelScheduledValues(time);
    parameter.setValueAtTime(value, time);
    return;
  }
  if (typeof parameter.cancelAndHoldAtTime === "function") {
    parameter.cancelAndHoldAtTime(time);
  } else {
    parameter.cancelScheduledValues(time);
    parameter.setValueAtTime(parameter.value, time);
  }
  parameter.linearRampToValueAtTime(value, time + 0.02);
}

export function readVoiceLevel(analyser: AnalyserNode): {
  level: number;
  overloaded: boolean;
} {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  let peak = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) continue;
    sum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return {
    level: Math.min(1, Math.sqrt(sum / samples.length) * Math.SQRT2),
    overloaded: peak >= 0.98,
  };
}

function makeAnalyser(context: AudioContext): AnalyserNode {
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.5;
  return analyser;
}

interface RemotePath {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  playback: HTMLAudioElement;
  active: boolean;
  playbackBlocked: boolean;
  playbackAttempt: number;
}

/** The application owns this graph; LiveKit may use its context but must not close it. */
export class VoiceAudioGraph {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly outputGate: GainNode;
  private readonly outputAnalyser: AnalyserNode;
  private readonly paths = new Map<string, RemotePath>();
  private disposed = false;
  private outputSilenced = false;

  constructor(
    context: AudioContext,
    masterVolume: number,
    private readonly onPlaybackBlocked?: () => void,
  ) {
    this.context = context;
    this.master = context.createGain();
    this.compressor = context.createDynamicsCompressor();
    configureVoiceCompressor(this.compressor);
    this.outputGate = context.createGain();
    this.outputAnalyser = makeAnalyser(context);
    this.setMasterVolume(masterVolume, true);
    this.master.connect(this.compressor);
    this.compressor.connect(this.outputGate);
    this.outputGate.connect(this.outputAnalyser);
    this.outputAnalyser.connect(context.destination);
  }

  addTrack(key: string, track: MediaStreamTrack, volume: number): void {
    if (this.disposed) return;
    this.removeTrack(key);
    const stream = new MediaStream([track]);
    const source = this.context.createMediaStreamSource(stream);
    const gain = this.context.createGain();
    const analyser = makeAnalyser(this.context);
    // Restore before connecting: a saved mute must never emit a full-volume frame.
    setVoiceGain(
      gain.gain,
      volumeGain(volume, 500),
      this.context.currentTime,
      true,
    );
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(this.master);
    // Chromium can receive RTP without advancing its remote audio decoder when
    // a stream only feeds Web Audio. See Chromium issues:
    // https://issues.chromium.org/issues/40094084
    // https://issues.chromium.org/issues/40504498
    // A permanently silent element starts playout; the graph above remains
    // the sole audible route. Never pass this element to LiveKit.attach()/startAudio().
    const playback = document.createElement("audio");
    playback.dataset.simplewatchVoice = "playout-bridge";
    playback.defaultMuted = true;
    playback.muted = true;
    playback.volume = 0;
    playback.autoplay = true;
    playback.hidden = true;
    playback.tabIndex = -1;
    playback.setAttribute("aria-hidden", "true");
    playback.setAttribute("playsinline", "");
    playback.srcObject = stream;
    document.body.append(playback);
    const path = {
      source,
      gain,
      analyser,
      playback,
      active: true,
      playbackBlocked: false,
      playbackAttempt: 0,
    };
    this.paths.set(key, path);
    void this.playBridge(path).catch(() => undefined);
  }

  /** Retry silent playout in the same user gesture as the shared context resume. */
  async resumePlayback(): Promise<void> {
    await Promise.all(
      [...this.paths.values()].map((path) => this.playBridge(path)),
    );
  }

  private async playBridge(path: RemotePath): Promise<void> {
    if (this.disposed || !path.active) return;
    path.playback.defaultMuted = true;
    path.playback.muted = true;
    path.playback.volume = 0;
    const attempt = ++path.playbackAttempt;
    try {
      await path.playback.play();
      if (attempt === path.playbackAttempt) path.playbackBlocked = false;
    } catch (error) {
      // A detached/replaced track may reject an earlier play promise during
      // teardown; that is not a new autoplay failure for the current session.
      if (!this.disposed && path.active && attempt === path.playbackAttempt) {
        path.playbackBlocked = true;
        this.onPlaybackBlocked?.();
        throw error;
      }
    }
  }

  setTrackVolume(key: string, volume: number): void {
    const path = this.paths.get(key);
    if (path)
      setVoiceGain(
        path.gain.gain,
        volumeGain(volume, 500),
        this.context.currentTime,
      );
  }

  removeTrack(key: string): void {
    const path = this.paths.get(key);
    if (!path) return;
    path.active = false;
    path.playback.muted = true;
    path.playback.volume = 0;
    path.playback.pause();
    path.playback.srcObject = null;
    path.playback.removeAttribute("src");
    path.playback.load();
    path.playback.remove();
    path.source.disconnect();
    path.gain.disconnect();
    path.analyser.disconnect();
    this.paths.delete(key);
    // Remote MediaStreamTracks belong to LiveKit, not to this mixer.
  }

  setMasterVolume(volume: number, immediate = false): void {
    const value = volumeGain(volume, 100, 50);
    setVoiceGain(this.master.gain, value, this.context.currentTime, immediate);
    setVoiceGain(
      this.outputGate.gain,
      value === 0 || this.outputSilenced ? 0 : 1,
      this.context.currentTime,
      immediate,
    );
  }

  /** End audible output synchronously, even if RTC cleanup is still pending. */
  silenceOutput(): void {
    this.outputSilenced = true;
    setVoiceGain(this.outputGate.gain, 0, this.context.currentTime, true);
  }

  readLevels(): { tracks: Map<string, number>; overloaded: boolean } {
    const tracks = new Map<string, number>();
    for (const [id, path] of this.paths)
      tracks.set(id, readVoiceLevel(path.analyser).level);
    return {
      tracks,
      overloaded:
        readVoiceLevel(this.outputAnalyser).overloaded ||
        this.compressor.reduction < -6,
    };
  }

  get trackCount(): number {
    return this.paths.size;
  }

  get playbackBlocked(): boolean {
    return [...this.paths.values()].some((path) => path.playbackBlocked);
  }

  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.silenceOutput();
    for (const key of this.paths.keys()) this.removeTrack(key);
    this.master.disconnect();
    this.compressor.disconnect();
    this.outputGate.disconnect();
    this.outputAnalyser.disconnect();
    if (this.context.state !== "closed") await this.context.close();
  }
}

/** Public LiveKit TrackProcessor contract; it never owns/closes the shared context. */
export class MicrophoneGainProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  readonly name = "simplewatch-microphone-gain";
  processedTrack?: MediaStreamTrack;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private gate: GainNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private volume: number;
  private sending = false;

  constructor(
    volume: number,
    private readonly channels: 1 | 2,
  ) {
    this.volume = volume;
  }

  async init(options: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    const context = options.audioContext;
    this.context = context;
    this.source = context.createMediaStreamSource(
      new MediaStream([options.track]),
    );
    this.gain = context.createGain();
    this.analyser = makeAnalyser(context);
    this.compressor = context.createDynamicsCompressor();
    configureVoiceCompressor(this.compressor);
    this.gate = context.createGain();
    this.destination = context.createMediaStreamDestination();
    for (const node of [
      this.gain,
      this.analyser,
      this.compressor,
      this.gate,
      this.destination,
    ]) {
      node.channelCount = this.channels;
      node.channelCountMode = "explicit";
      node.channelInterpretation = "speakers";
    }
    setVoiceGain(
      this.gain.gain,
      volumeGain(this.volume, 200),
      context.currentTime,
      true,
    );
    setVoiceGain(
      this.gate.gain,
      this.sending && this.volume > 0 ? 1 : 0,
      context.currentTime,
      true,
    );
    this.source.connect(this.gain);
    this.gain.connect(this.analyser);
    this.analyser.connect(this.compressor);
    this.compressor.connect(this.gate);
    this.gate.connect(this.destination);
    const track = this.destination.stream.getAudioTracks()[0];
    if (!track) {
      await this.destroy();
      throw new Error("无法创建麦克风发送音轨");
    }
    this.processedTrack = track;
  }

  restart(options: AudioProcessorOptions): Promise<void> {
    return this.init(options);
  }

  setVolume(volume: number): void {
    this.volume = volumeGain(volume, 200) * 100;
    if (this.gain && this.context) {
      setVoiceGain(this.gain.gain, this.volume / 100, this.context.currentTime);
      this.setSending(this.sending);
    }
  }

  setSending(sending: boolean): void {
    this.sending = sending;
    if (this.gate && this.context) {
      setVoiceGain(
        this.gate.gain,
        sending && this.volume > 0 ? 1 : 0,
        this.context.currentTime,
      );
    }
  }

  readLevel(): { level: number; overloaded: boolean } {
    return this.analyser
      ? readVoiceLevel(this.analyser)
      : { level: 0, overloaded: false };
  }

  destroy(): Promise<void> {
    this.processedTrack?.stop();
    delete this.processedTrack;
    for (const node of [
      this.source,
      this.gain,
      this.analyser,
      this.compressor,
      this.gate,
      this.destination,
    ]) {
      node?.disconnect();
    }
    this.source = null;
    this.gain = null;
    this.analyser = null;
    this.compressor = null;
    this.gate = null;
    this.destination = null;
    this.context = null;
    return Promise.resolve();
  }
}
