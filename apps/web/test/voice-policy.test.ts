import { describe, expect, it } from "vitest";
import {
  captureChannels,
  captureConstraints,
  concreteInputDeviceId,
  memberForIdentity,
  normalizeVoiceSettings,
  voicePublishOptions,
  volumeGain,
} from "../src/voice/policy.js";

describe("voice policy", () => {
  it("clamps finite gains and prevents NaN or negative output", () => {
    expect(volumeGain(500, 500)).toBe(5);
    expect(volumeGain(200, 200)).toBe(2);
    expect(volumeGain(-4, 500)).toBe(0);
    expect(volumeGain(Infinity, 500)).toBe(1);
    expect(
      normalizeVoiceSettings({
        masterVolume: NaN,
        participantVolumes: { one: 900 },
        microphoneGain: -10,
        inputDeviceId: "",
        mode: "dialogue",
      }),
    ).toMatchObject({
      masterVolume: 50,
      participantVolumes: { one: 500 },
      microphoneGain: 0,
    });
  });

  it("explicitly controls capture DSP without adding experimental voiceIsolation", () => {
    const dialogue = captureConstraints({
      mode: "dialogue",
      inputDeviceId: "mic",
    });
    expect(dialogue).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: { exact: "mic" },
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    });
    expect(dialogue).not.toHaveProperty("voiceIsolation");
    expect(
      captureConstraints({ mode: "original", inputDeviceId: "" }, true),
    ).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it("does not turn unknown or mono capture into pretend stereo", () => {
    expect(captureChannels({})).toEqual({ channels: 1, confirmed: false });
    expect(captureChannels({ channelCount: 1 })).toEqual({
      channels: 1,
      confirmed: true,
    });
    expect(captureChannels({ channelCount: 2 })).toEqual({
      channels: 2,
      confirmed: true,
    });
    expect(voicePublishOptions("dialogue", 1)).toMatchObject({
      audioPreset: { maxBitrate: 96000 },
      forceStereo: false,
      dtx: true,
      red: true,
    });
    expect(voicePublishOptions("dialogue", 2)).toMatchObject({
      forceStereo: true,
      dtx: false,
      red: true,
    });
    expect(voicePublishOptions("original", 2)).toMatchObject({
      audioPreset: { maxBitrate: 96000 },
      forceStereo: true,
      dtx: false,
      red: false,
    });
  });

  it("resolves default routes only to a unique physical microphone group", () => {
    const devices = [
      { kind: "audioinput" as const, deviceId: "default", groupId: "group-a" },
      { kind: "audioinput" as const, deviceId: "usb-mic", groupId: "group-a" },
      { kind: "audiooutput" as const, deviceId: "speaker", groupId: "group-a" },
    ];
    expect(concreteInputDeviceId({ deviceId: "known" })).toBe("known");
    expect(concreteInputDeviceId({ deviceId: "default" }, devices)).toBe("");
    expect(
      concreteInputDeviceId(
        { deviceId: "default", groupId: "group-a" },
        devices,
      ),
    ).toBe("usb-mic");
    expect(
      concreteInputDeviceId(
        { deviceId: "communications", groupId: "group-a" },
        devices,
      ),
    ).toBe("usb-mic");
    expect(
      concreteInputDeviceId({ groupId: "group-a" }, [
        ...devices,
        { kind: "audioinput", deviceId: "other-mic", groupId: "group-a" },
      ]),
    ).toBe("");
    expect(concreteInputDeviceId({ groupId: "missing" }, devices)).toBe("");
  });

  it("maps only an admitted member, never trusts participant metadata or a display name", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const device = "00000000-0000-4000-8000-000000000002";
    const member = { id, accountId: "account-one", nickname: "Friend" };
    expect(memberForIdentity(`v2:${id}:${device}:100`, [member])).toBe(member);
    expect(memberForIdentity(id, [member])).toBe(member);
    expect(
      memberForIdentity(`v2:${id}:${device}:NaN`, [member]),
    ).toBeUndefined();
    expect(memberForIdentity("Friend", [member])).toBeUndefined();
    expect(memberForIdentity(`v2:${id}:${device}:100`, [])).toBeUndefined();
  });
});
