import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Track, type AudioProcessorOptions } from "livekit-client";
import {
  MicrophoneGainProcessor,
  VoiceAudioGraph,
  setVoiceGain,
  voiceCompressorSettings,
} from "../src/voice/audio-graph.js";
import {
  FakeAudioContext,
  FakeAudioElement,
  FakeAudioParam,
  FakeMediaTrack,
  installVoiceBrowser,
} from "./voice-fakes.js";

beforeEach(() => {
  installVoiceBrowser();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice audio graph ownership", () => {
  it("restores saved gain before output, supports 500%, and does not stop remote tracks", async () => {
    const context = new FakeAudioContext();
    const graph = new VoiceAudioGraph(context as unknown as AudioContext, 50);
    const remote = new FakeMediaTrack();
    graph.addTrack("friend", remote as unknown as MediaStreamTrack, 0);
    expect(context.gains.map((node) => node.gain.value)).toEqual([0.5, 1, 0]);
    expect(graph.trackCount).toBe(1);
    const playback = FakeAudioElement.instances[0]!;
    expect(playback).toMatchObject({
      muted: true,
      defaultMuted: true,
      volume: 0,
      hidden: true,
      isConnected: true,
    });
    expect(playback.play).toHaveBeenCalledOnce();
    graph.setTrackVolume("friend", 500);
    expect(context.gains[2]?.gain.value).toBe(5);
    graph.setMasterVolume(0);
    expect(context.gains[1]?.gain.writes.at(-1)).toMatchObject({
      kind: "set",
      value: 0,
    });
    graph.removeTrack("friend");
    expect(remote.stop).not.toHaveBeenCalled();
    expect(context.sources[0]?.disconnect).toHaveBeenCalledOnce();
    expect(playback.pause).toHaveBeenCalledOnce();
    expect(playback.load).toHaveBeenCalledOnce();
    expect(playback.srcObject).toBeNull();
    expect(playback.isConnected).toBe(false);
    await graph.destroy();
    await graph.destroy();
    expect(context.close).toHaveBeenCalledOnce();
    expect(graph.trackCount).toBe(0);
  });

  it("uses one audible graph and only permanently silent native decoder bridges", async () => {
    const context = new FakeAudioContext();
    const graph = new VoiceAudioGraph(context as unknown as AudioContext, 50);
    for (let index = 0; index < 4; index++)
      graph.addTrack(
        String(index),
        new FakeMediaTrack() as unknown as MediaStreamTrack,
        500,
      );
    expect(context.compressors).toHaveLength(1);
    const compressor = context.compressors[0]!;
    for (const [key, value] of Object.entries(voiceCompressorSettings)) {
      expect(
        compressor[key as keyof typeof voiceCompressorSettings].value,
      ).toBe(value);
    }
    expect(context.gains[0]?.connections).toEqual([compressor]);
    expect(compressor.connections).toEqual([context.gains[1]]);
    expect(FakeAudioElement.instances).toHaveLength(4);
    expect(
      FakeAudioElement.instances.every(
        (element) => element.muted && element.volume === 0,
      ),
    ).toBe(true);
    compressor.reduction = -7;
    expect(graph.readLevels().overloaded).toBe(true);
    await graph.destroy();
    expect(
      FakeAudioElement.instances.every(
        (element) => !element.isConnected && element.srcObject === null,
      ),
    ).toBe(true);
  });

  it("reports blocked decoder playout, retries silently, and ignores detached-track rejections", async () => {
    const context = new FakeAudioContext();
    const blocked = vi.fn();
    const graph = new VoiceAudioGraph(
      context as unknown as AudioContext,
      50,
      blocked,
    );
    graph.addTrack(
      "friend",
      new FakeMediaTrack() as unknown as MediaStreamTrack,
      100,
    );
    const playback = FakeAudioElement.instances[0]!;
    playback.play.mockRejectedValueOnce(
      new DOMException("gesture", "NotAllowedError"),
    );
    await expect(graph.resumePlayback()).rejects.toThrow("gesture");
    expect(graph.playbackBlocked).toBe(true);
    expect(blocked).toHaveBeenCalledOnce();
    await graph.resumePlayback();
    expect(graph.playbackBlocked).toBe(false);
    expect(playback.muted).toBe(true);
    expect(playback.volume).toBe(0);
    let reject!: (reason: Error) => void;
    playback.play.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
    );
    const pending = graph.resumePlayback();
    graph.removeTrack("friend");
    reject(new DOMException("detached", "AbortError"));
    await pending;
    expect(blocked).toHaveBeenCalledOnce();
    await graph.destroy();
  });

  it("smooths ordinary changes but makes zero a direct gate operation", () => {
    const param = new FakeAudioParam();
    setVoiceGain(param as unknown as AudioParam, 2, 1);
    expect(param.writes.at(-1)).toEqual({ kind: "ramp", value: 2, at: 1.02 });
    setVoiceGain(param as unknown as AudioParam, 0, 1.01);
    expect(param.writes.slice(-2)).toEqual([
      { kind: "cancel", value: 2, at: 1.01 },
      { kind: "set", value: 0, at: 1.01 },
    ]);
  });

  it("terminal silence closes output immediately and later volume changes cannot reopen it", async () => {
    const context = new FakeAudioContext();
    const graph = new VoiceAudioGraph(context as unknown as AudioContext, 50);
    graph.silenceOutput();
    expect(context.gains[1]!.gain.value).toBe(0);
    graph.setMasterVolume(100);
    expect(context.gains[1]!.gain.value).toBe(0);
    expect(context.state).not.toBe("closed");
    await graph.destroy();
  });
});

describe("microphone processor", () => {
  function options(
    context: FakeAudioContext,
    track = new FakeMediaTrack(),
  ): AudioProcessorOptions {
    return {
      kind: Track.Kind.Audio,
      track: track as unknown as MediaStreamTrack,
      audioContext: context as unknown as AudioContext,
    };
  }

  it.each([1, 2] as const)(
    "keeps actual %i-channel processing and is closed until explicitly sending",
    async (channels) => {
      const context = new FakeAudioContext();
      const processor = new MicrophoneGainProcessor(200, channels);
      await processor.init(options(context));
      expect(context.gains[0]?.gain.value).toBe(2);
      expect(context.gains[1]?.gain.value).toBe(0);
      expect(context.destinations[0]?.channelCount).toBe(channels);
      expect(context.destinations[0]?.channelCountMode).toBe("explicit");
      processor.setSending(true);
      expect(context.gains[1]?.gain.value).toBe(1);
      processor.setVolume(0);
      expect(context.gains[1]?.gain.value).toBe(0);
      const processed = processor.processedTrack as unknown as FakeMediaTrack;
      await processor.destroy();
      expect(processed.stop).toHaveBeenCalledOnce();
      expect(processor.processedTrack).toBeUndefined();
      expect(context.close).not.toHaveBeenCalled();
    },
  );

  it("restarts with the supplied context, releases old nodes/tracks, and never closes either context", async () => {
    const oldContext = new FakeAudioContext();
    const nextContext = new FakeAudioContext();
    const raw = new FakeMediaTrack();
    const processor = new MicrophoneGainProcessor(100, 1);
    await processor.init(options(oldContext, raw));
    const oldTrack = processor.processedTrack as unknown as FakeMediaTrack;
    await processor.restart(options(nextContext, raw));
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(oldContext.sources[0]?.disconnect).toHaveBeenCalledOnce();
    expect(nextContext.sources).toHaveLength(1);
    await processor.destroy();
    expect(raw.stop).not.toHaveBeenCalled();
    expect(oldContext.close).not.toHaveBeenCalled();
    expect(nextContext.close).not.toHaveBeenCalled();
  });
});
