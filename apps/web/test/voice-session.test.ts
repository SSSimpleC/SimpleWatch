import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeAudioContext,
  FakeAudioElement,
  FakeLocalAudioTrack,
  FakeMediaStream,
  FakeMediaTrack,
  FakeRoom,
  installVoiceBrowser,
} from "./voice-fakes.js";
import { VoiceSession } from "../src/voice/session.js";
import type { VoiceSessionOptions } from "../src/voice/session.js";
import type { VoiceSettings } from "../src/voice/types.js";

vi.mock("livekit-client", async () => {
  const fake = await import("./voice-fakes.js");
  return {
    Room: fake.FakeRoom,
    LocalAudioTrack: fake.FakeLocalAudioTrack,
    RoomEvent: fake.fakeRoomEvents,
    Track: { Kind: { Audio: "audio" }, Source: { Microphone: "microphone" } },
  };
});

const memberId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const deviceId = "00000000-0000-4000-8000-000000000003";
const settings: VoiceSettings = {
  masterVolume: 50,
  participantVolumes: {},
  microphoneGain: 100,
  inputDeviceId: "",
  mode: "dialogue",
};
let browser: ReturnType<typeof installVoiceBrowser>;
const sessions: VoiceSession[] = [];

function createSession(
  overrides: Partial<VoiceSessionOptions> = {},
): VoiceSession {
  const session = new VoiceSession({
    accountId: "me",
    roomId: "room-one",
    members: [
      { id: memberId, accountId: "me", nickname: "Me" },
      { id: otherId, accountId: "friend", nickname: "Friend" },
    ],
    settings,
    getCredentials: () =>
      Promise.resolve({ url: "wss://voice.invalid", token: "private-token" }),
    onState: vi.fn(),
    ...overrides,
  });
  sessions.push(session);
  return session;
}

async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  browser = installVoiceBrowser();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("voice session privacy and lifetime", () => {
  it("joins in receive-only mode without requesting a microphone or creating a local audio track", async () => {
    const session = createSession();
    await session.connect();
    expect(session.getState()).toMatchObject({
      connection: "connected",
      microphone: "off",
    });
    expect(browser.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(FakeLocalAudioTrack.instances).toHaveLength(0);
    expect(
      FakeRoom.instances[0]?.localParticipant.publishTrack,
    ).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("keeps receiving when microphone permission is refused and never retries that permission", async () => {
    browser.mediaDevices.getUserMedia.mockRejectedValue(
      new DOMException("private text", "NotAllowedError"),
    );
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    expect(session.getState()).toMatchObject({
      connection: "connected",
      microphone: "error",
    });
    expect(session.getState().microphoneError).toContain("权限未授予");
    expect(browser.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(FakeRoom.instances[0]?.disconnect).not.toHaveBeenCalled();
    expect(session.getState().microphoneError).not.toContain("private text");
  });

  it("publishes actual stereo at 96kbps with gain restored before opening its sending gate", async () => {
    const raw = new FakeMediaTrack({
      channelCount: 2,
      deviceId: "stereo-input",
    });
    browser.mediaDevices.getUserMedia.mockResolvedValue(
      new FakeMediaStream([raw]),
    );
    const session = createSession({
      resolveMicrophoneGain: (id) => (id === "stereo-input" ? 175 : 100),
    });
    await session.connect();
    await session.openMicrophone();
    expect(
      FakeRoom.instances[0]?.localParticipant.publishTrack,
    ).toHaveBeenCalledWith(
      FakeLocalAudioTrack.instances[0],
      expect.objectContaining({
        audioPreset: { maxBitrate: 96000, priority: "high" },
        forceStereo: true,
        dtx: false,
        red: true,
      }),
    );
    expect(session.getState()).toMatchObject({
      microphone: "transmitting",
      captureChannels: 2,
      captureChannelsConfirmed: true,
      activeInputDeviceId: "stereo-input",
    });
    expect(FakeAudioContext.instances[0]?.gains[2]?.gain.value).toBe(1.75);
    await session.closeMicrophone();
    expect(raw.readyState).toBe("ended");
    expect(session.getState().microphone).toBe("off");
  });

  it("resolves a default capture alias to its unique hardware before restoring gain", async () => {
    const raw = new FakeMediaTrack({ deviceId: "default", groupId: "usb" });
    browser.mediaDevices.getUserMedia.mockResolvedValue(
      new FakeMediaStream([raw]),
    );
    browser.mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: "audioinput", deviceId: "default", groupId: "usb" },
      { kind: "audioinput", deviceId: "usb-mic", groupId: "usb" },
    ]);
    const resolveMicrophoneGain = vi.fn(() => 175);
    const session = createSession({ resolveMicrophoneGain });
    await session.connect();
    await session.openMicrophone();
    expect(resolveMicrophoneGain).toHaveBeenCalledWith("usb-mic");
    expect(session.getState().activeInputDeviceId).toBe("usb-mic");
    expect(FakeAudioContext.instances[0]?.gains[2]?.gain.value).toBe(1.75);
    await session.closeMicrophone();
    expect(session.getState().activeInputDeviceId).toBe("usb-mic");
  });

  it("keeps unidentified microphone gain at 100% instead of inheriting a default-route gain", async () => {
    browser.mediaDevices.getUserMedia.mockResolvedValue(
      new FakeMediaStream([new FakeMediaTrack({ deviceId: "default" })]),
    );
    const resolveMicrophoneGain = vi.fn(() => 200);
    const session = createSession({
      settings: { ...settings, microphoneGain: 200 },
      resolveMicrophoneGain,
    });
    await session.connect();
    await session.openMicrophone();
    expect(resolveMicrophoneGain).not.toHaveBeenCalled();
    expect(session.getState().activeInputDeviceId).toBe("");
    expect(FakeAudioContext.instances[0]?.gains[2]?.gain.value).toBe(1);
    session.updateSettings({ ...settings, microphoneGain: 150 });
    expect(FakeAudioContext.instances[0]?.gains[2]?.gain.value).toBe(1);
  });

  it("closes a switched default route even if the former physical microphone remains connected", async () => {
    const actual = { deviceId: "default", groupId: "usb" };
    const raw = new FakeMediaTrack(actual);
    browser.mediaDevices.getUserMedia.mockResolvedValue(
      new FakeMediaStream([raw]),
    );
    browser.mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: "audioinput", deviceId: "usb-mic", groupId: "usb" },
      { kind: "audioinput", deviceId: "built-in", groupId: "internal" },
    ]);
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    expect(session.getState().activeInputDeviceId).toBe("usb-mic");
    actual.groupId = "internal";
    browser.mediaDevices.dispatchEvent(new Event("devicechange"));
    await flush();
    expect(raw.stop).toHaveBeenCalled();
    expect(raw.readyState).toBe("ended");
    expect(
      FakeRoom.instances[0]!.localParticipant.unpublishTrack,
    ).toHaveBeenCalledOnce();
    expect(session.getState()).toMatchObject({
      microphone: "off",
      activeInputDeviceId: "",
    });
    expect(browser.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  });

  it("does not confuse permission-driven device enumeration during publish with microphone removal", async () => {
    let release!: () => void;
    FakeRoom.publishGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createSession();
    await session.connect();
    const opening = session.openMicrophone();
    await flush();
    browser.mediaDevices.dispatchEvent(new Event("devicechange"));
    await flush();
    release();
    await opening;
    expect(session.getState()).toMatchObject({
      microphone: "transmitting",
      activeInputDeviceId: "mic-one",
    });
    expect(FakeLocalAudioTrack.instances[0]!.raw.readyState).toBe("live");
    expect(
      FakeRoom.instances[0]!.localParticipant.unpublishTrack,
    ).not.toHaveBeenCalled();
  });

  it("stops a late permission result after leaving without ever publishing it", async () => {
    let release!: (value: FakeMediaStream) => void;
    browser.mediaDevices.getUserMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const session = createSession();
    await session.connect();
    const opening = session.openMicrophone();
    await session.disconnect();
    const raw = new FakeMediaTrack();
    release(new FakeMediaStream([raw]));
    await opening;
    expect(raw.stop).toHaveBeenCalledOnce();
    expect(
      FakeRoom.instances[0]?.localParticipant.publishTrack,
    ).not.toHaveBeenCalled();
    expect(session.getState().connection).toBe("closed");
  });

  it("does not emit a microphone frame if close happens during a delayed publish", async () => {
    let release!: () => void;
    FakeRoom.publishGate = new Promise((resolve) => {
      release = resolve;
    });
    const session = createSession();
    await session.connect();
    const opening = session.openMicrophone();
    await flush();
    expect(
      FakeRoom.instances[0]?.localParticipant.publishTrack,
    ).toHaveBeenCalledOnce();
    await session.closeMicrophone();
    release();
    await opening;
    expect(FakeLocalAudioTrack.instances[0]?.unmute).not.toHaveBeenCalled();
    expect(FakeLocalAudioTrack.instances[0]?.raw.readyState).toBe("ended");
    expect(session.getState().microphone).toBe("off");
  });

  it("does not publish a replacement microphone before prior unpublish completes", async () => {
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    let release!: () => void;
    const room = FakeRoom.instances[0]!;
    room.localParticipant.unpublishTrack.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const closing = session.closeMicrophone();
    await flush();
    expect(FakeLocalAudioTrack.instances[0]!.raw.readyState).toBe("ended");
    const opening = session.openMicrophone();
    try {
      await flush();
      expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
      expect(browser.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await closing;
      await opening;
    }
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(session.getState().microphone).toBe("transmitting");
  });

  it("cancels a queued reopen while preserving immediate raw microphone stop", async () => {
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    let release!: () => void;
    const room = FakeRoom.instances[0]!;
    room.localParticipant.unpublishTrack.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const closing = session.closeMicrophone();
    expect(FakeLocalAudioTrack.instances[0]!.raw.readyState).toBe("ended");
    await flush();
    const opening = session.openMicrophone();
    await flush();
    const canceled = session.closeMicrophone();
    release();
    await Promise.all([closing, opening, canceled]);
    expect(browser.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce();
    expect(session.getState().microphone).toBe("off");
  });

  it("aborts credential loading without touching audio before a late response", async () => {
    let release!: (value: { url: string; token: string }) => void;
    let signal: AbortSignal | null = null;
    const session = createSession({
      getCredentials: (value) => {
        signal = value;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const connecting = session.connect();
    await flush();
    await session.disconnect();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    release({ url: "wss://late.invalid", token: "late-secret" });
    await connecting;
    expect(FakeRoom.instances).toHaveLength(0);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it("does not create an audio context when the voice service refuses credentials", async () => {
    const session = createSession({
      getCredentials: () => Promise.reject(new Error("Service unavailable")),
    });
    await session.connect();
    expect(session.getState().connection).toBe("error");
    expect(FakeRoom.instances).toHaveLength(0);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(browser.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("remains closed if a delayed connect resolves after cleanup", async () => {
    let release!: () => void;
    FakeRoom.connectGate = new Promise((resolve) => {
      release = resolve;
    });
    const session = createSession();
    const connecting = session.connect();
    await flush();
    await session.disconnect();
    release();
    await connecting;
    expect(session.getState().connection).toBe("closed");
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledOnce();
    expect(browser.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("does not silently reopen capture after reconnect, mode change or visibility recovery", async () => {
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    FakeRoom.instances[0]?.emit("reconnecting");
    await flush();
    FakeRoom.instances[0]?.emit("reconnected");
    expect(session.getState()).toMatchObject({
      connection: "connected",
      microphone: "off",
    });
    session.updateSettings({ ...settings, mode: "original" });
    browser.document.visibilityState = "visible";
    browser.document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(browser.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(session.getState().microphone).toBe("off");
  });

  it("relaxes only format constraints once, and never adds voiceIsolation", async () => {
    browser.mediaDevices.getUserMedia.mockRejectedValueOnce(
      new DOMException("unsupported format", "OverconstrainedError"),
    );
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    expect(browser.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(browser.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    expect(
      JSON.stringify(browser.mediaDevices.getUserMedia.mock.calls),
    ).not.toContain("voiceIsolation");
  });

  it("does not mistake rejected audio unlock for connection failure", async () => {
    const session = createSession();
    await session.connect();
    FakeAudioContext.instances[0]!.state = "suspended";
    FakeAudioContext.instances[0]!.resume.mockRejectedValue(
      new DOMException("gesture", "NotAllowedError"),
    );
    await session.enableAudio();
    expect(session.getState().connection).toBe("connected");
    expect(["awaiting-gesture", "interrupted"]).toContain(
      session.getState().output,
    );
    expect(browser.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("does not hide blocked remote decoder playout behind an advancing AudioContext", async () => {
    const session = createSession();
    await session.connect();
    FakeRoom.instances[0]!.emit(
      "trackSubscribed",
      {
        kind: "audio",
        mediaStreamTrack: new FakeMediaTrack(),
        getRTCStatsReport: () => Promise.resolve(undefined),
      },
      { trackSid: "remote-track" },
      { identity: `v2:${otherId}:${deviceId}:1` },
    );
    const playback = FakeAudioElement.instances[0]!;
    playback.play.mockRejectedValue(
      new DOMException("gesture", "NotAllowedError"),
    );
    await session.enableAudio();
    FakeAudioContext.instances[0]!.currentTime += 1;
    await vi.advanceTimersByTimeAsync(250);
    expect(session.getState().connection).toBe("connected");
    expect(session.getState().output).toBe("awaiting-gesture");
    playback.play.mockResolvedValue(undefined);
    await session.enableAudio();
    expect(session.getState().output).toBe("running");
    expect(playback.muted && playback.volume === 0).toBe(true);
  });

  it("releases twenty room sessions without accumulating live contexts or locks", async () => {
    for (let index = 0; index < 20; index++) {
      const session = createSession();
      await session.connect();
      await session.openMicrophone();
      await session.disconnect();
    }
    expect(FakeAudioContext.instances).toHaveLength(20);
    expect(
      FakeAudioContext.instances.every(
        (context) =>
          context.state === "closed" && context.close.mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(
      FakeLocalAudioTrack.instances.every(
        (track) => track.raw.readyState === "ended",
      ),
    ).toBe(true);
    expect(browser.locks.held.size).toBe(0);
  });

  it("shares one disconnect completion until the room, graph and Web Lock are all released", async () => {
    const session = createSession();
    await session.connect();
    let finish!: () => void;
    FakeRoom.instances[0]!.disconnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = session.disconnect();
    const second = session.disconnect();
    expect(second).toBe(first);
    await flush();
    expect(browser.locks.held.size).toBe(1);
    expect(FakeAudioContext.instances[0]?.close).not.toHaveBeenCalled();
    finish();
    await second;
    expect(browser.locks.held.size).toBe(0);
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledOnce();
    expect(session.disconnect()).toBe(first);
  });

  it("silences remote output before waiting for slow microphone unpublish and RTC disconnect", async () => {
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    const room = FakeRoom.instances[0]!;
    let unpublish!: () => void;
    let disconnect!: () => void;
    room.localParticipant.unpublishTrack.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          unpublish = resolve;
        }),
    );
    room.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          disconnect = resolve;
        }),
    );
    const leaving = session.disconnect();
    expect(FakeAudioContext.instances[0]!.gains[1]!.gain.value).toBe(0);
    expect(FakeLocalAudioTrack.instances[0]!.raw.readyState).toBe("ended");
    await flush();
    expect(FakeAudioContext.instances[0]!.state).not.toBe("closed");
    expect(browser.locks.held.size).toBe(1);
    unpublish();
    await flush();
    expect(FakeAudioContext.instances[0]!.gains[1]!.gain.value).toBe(0);
    expect(browser.locks.held.size).toBe(1);
    disconnect();
    await leaving;
    expect(FakeAudioContext.instances[0]!.state).toBe("closed");
    expect(browser.locks.held.size).toBe(0);
  });

  it("retains the last confirmed input for an off microphone's remembered slider until selection changes", async () => {
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    await session.closeMicrophone();
    expect(session.getState()).toMatchObject({
      microphone: "off",
      activeInputDeviceId: "mic-one",
    });
    session.updateSettings({ ...settings, inputDeviceId: "mic-two" });
    expect(session.getState().activeInputDeviceId).toBe("");
  });

  it("public disconnect also waits for cleanup already started by an RTC disconnect event", async () => {
    const session = createSession();
    await session.connect();
    let finish!: () => void;
    FakeRoom.instances[0]!.disconnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    FakeRoom.instances[0]!.emit("disconnected");
    await flush();
    let finished = false;
    const disposing = session.disconnect().then(() => {
      finished = true;
    });
    await flush();
    expect(finished).toBe(false);
    expect(browser.locks.held.size).toBe(1);
    finish();
    await disposing;
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledOnce();
    expect(browser.locks.held.size).toBe(0);
  });

  it("forgets an unplugged remembered input even when not currently capturing", async () => {
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    await session.closeMicrophone();
    browser.mediaDevices.enumerateDevices.mockResolvedValue([]);
    browser.mediaDevices.dispatchEvent(new Event("devicechange"));
    await flush();
    expect(session.getState()).toMatchObject({
      microphone: "off",
      activeInputDeviceId: "",
    });
  });
});

describe("push-to-talk", () => {
  it("requires explicit arming; release mutes without reacquiring, blur fully stops capture", async () => {
    const session = createSession();
    await session.connect();
    session.setPushToTalkPressed(true);
    expect(browser.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await session.openMicrophone(true);
    expect(session.getState().microphone).toBe("armed");
    const track = FakeLocalAudioTrack.instances[0]!;
    expect(track.isMuted).toBe(true);
    session.setPushToTalkPressed(true);
    await flush();
    expect(session.getState().microphone).toBe("transmitting");
    session.setPushToTalkPressed(false);
    await flush();
    expect(session.getState().microphone).toBe("armed");
    expect(track.raw.readyState).toBe("live");
    expect(browser.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    browser.window.dispatchEvent(new Event("blur"));
    await flush();
    expect(track.raw.readyState).toBe("ended");
    expect(session.getState().microphone).toBe("off");
  });

  it("a delayed unmute cannot send after key release", async () => {
    const session = createSession();
    await session.connect();
    await session.openMicrophone(true);
    const track = FakeLocalAudioTrack.instances[0]!;
    let release!: (value: FakeLocalAudioTrack) => void;
    track.unmute.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    session.setPushToTalkPressed(true);
    await flush();
    session.setPushToTalkPressed(false);
    release(track);
    await flush();
    expect(session.getState().microphone).toBe("armed");
    expect(FakeAudioContext.instances[0]?.gains[3]?.gain.value).toBe(0);
    expect(track.isMuted).toBe(true);
  });
});

describe("room participant audio mapping and tab ownership", () => {
  it("keeps unrecognised audio muted, applies stable account preferences when admitted, removes graphs on unsubscribe", async () => {
    const session = createSession({
      members: [],
      settings: { ...settings, participantVolumes: { friend: 350 } },
    });
    await session.connect();
    const room = FakeRoom.instances[0]!;
    const track = {
      kind: "audio",
      mediaStreamTrack: new FakeMediaTrack(),
      getRTCStatsReport: () => Promise.resolve(undefined),
    };
    room.emit(
      "trackSubscribed",
      track,
      { trackSid: "remote-track" },
      { identity: `v2:${otherId}:${deviceId}:1` },
    );
    expect(FakeAudioContext.instances[0]?.gains[2]?.gain.value).toBe(0);
    session.updateMembers([
      { id: otherId, accountId: "friend", nickname: "Friend" },
    ]);
    expect(FakeAudioContext.instances[0]?.gains[2]?.gain.value).toBe(3.5);
    room.emit("trackUnsubscribed", track, { trackSid: "remote-track" });
    expect(session.getDiagnostics().receivedTrackCount).toBe(0);
    expect(
      FakeAudioContext.instances[0]?.sources[0]?.disconnect,
    ).toHaveBeenCalledOnce();
  });

  it("does not let an automatic second tab kick the owner, but supports explicit safe handoff", async () => {
    const first = createSession();
    const second = createSession();
    await first.connect();
    await first.openMicrophone();
    await second.connect();
    expect(first.getState().connection).toBe("connected");
    expect(second.getState().connection).toBe("other-tab");
    expect(FakeRoom.instances).toHaveLength(1);
    await second.takeOverTab();
    expect(first.getState()).toMatchObject({
      connection: "other-tab",
      microphone: "off",
    });
    expect(second.getState()).toMatchObject({
      connection: "connected",
      microphone: "off",
    });
    expect(FakeLocalAudioTrack.instances[0]?.raw.readyState).toBe("ended");
    expect(FakeRoom.instances).toHaveLength(2);
    expect(browser.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  });

  it("does not pretend BroadcastChannel alone provides a lock", async () => {
    vi.stubGlobal("navigator", { mediaDevices: browser.mediaDevices });
    const session = createSession();
    await session.connect();
    expect(session.getState().connection).toBe("unsupported");
    expect(FakeRoom.instances).toHaveLength(0);
  });

  it("exposes only aggregate safe diagnostics", async () => {
    const session = createSession();
    await session.connect();
    await session.openMicrophone();
    const diagnostics = JSON.stringify(session.getDiagnostics());
    for (const secret of [
      "private-token",
      "voice.invalid",
      "mic-one",
      memberId,
      deviceId,
      "friend",
    ])
      expect(diagnostics).not.toContain(secret);
  });
});
