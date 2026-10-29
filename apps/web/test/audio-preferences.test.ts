import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  audioPreferencesKey,
  clearAudioPreferences,
  createDefaultAudioPreferences,
  getMicrophoneGain,
  loadPreferences,
  programOutputVolume,
  purgeNonAudioStorage,
  savePreferences,
  subscribeAudioPreferences,
  subscribeAudioPreferenceResets,
  toggleParticipantVolume,
  withMicrophoneGain,
  withParticipantVolume,
  type AudioPreferences,
} from "../src/preferences.js";

const owner = "019f0000-0000-7000-8000-000000000001";
const otherOwner = "019f0000-0000-7000-8000-000000000002";
const member = "019f0000-0000-7000-8000-000000000003";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("window", new EventTarget());
  clearAudioPreferences();
});
afterEach(() => {
  clearAudioPreferences();
  vi.unstubAllGlobals();
});

function stored(preferences: AudioPreferences): string {
  return JSON.stringify({ version: 2, preferences });
}

describe("account-scoped audio preferences", () => {
  it("preserves voice ducking when program playback is unlocked again", () => {
    const preferences = { programVolume: 80, autoDuck: true };
    expect(programOutputVolume(preferences, true)).toBeCloseTo(0.32);
    expect(programOutputVolume(preferences, true)).toBeCloseTo(0.32);
    expect(programOutputVolume(preferences, false)).toBe(0.8);
    expect(programOutputVolume({ ...preferences, autoDuck: false }, true)).toBe(
      0.8,
    );
    expect(
      programOutputVolume({ ...preferences, programVolume: 0 }, true),
    ).toBe(0);
  });

  it("starts at 50% master and 100% input gain without a persisted open-mic flag", () => {
    const preferences = loadPreferences(owner);
    expect(preferences.callVolume).toBe(50);
    expect(preferences.programVolume).toBe(100);
    expect(preferences.mode).toBe("dialogue");
    expect(getMicrophoneGain(preferences)).toBe(100);
    expect(
      Object.keys(preferences).some((key) =>
        /enabled|armed|token|session/i.test(key),
      ),
    ).toBe(false);
  });

  it("does not inspect storage before authentication or adopt legacy shared data", () => {
    localStorage.setItem(
      "simplewatch.audio-preferences.v1",
      JSON.stringify({ callVolume: 99 }),
    );
    const spy = vi.spyOn(localStorage, "getItem");
    expect(loadPreferences(null).callVolume).toBe(50);
    savePreferences(
      { ...createDefaultAudioPreferences(), callVolume: 99 },
      null,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(loadPreferences(owner).callVolume).toBe(50);
    expect(localStorage.getItem("simplewatch.audio-preferences.v1")).toBeNull();
  });

  it("remembers stable account volume across rooms without leaking between owners", () => {
    const preferences = withParticipantVolume(
      { ...loadPreferences(owner), callVolume: 35 },
      member,
      420,
    );
    savePreferences(preferences, owner);
    expect(loadPreferences(owner).participantVolumes[member]).toBe(420);
    expect(loadPreferences(owner).callVolume).toBe(35);
    expect(loadPreferences(otherOwner).callVolume).toBe(50);
    expect(loadPreferences(otherOwner).participantVolumes).toEqual({});
    expect(audioPreferencesKey(owner)).not.toBe(
      audioPreferencesKey(otherOwner),
    );
  });

  it("remembers input gain per real device and starts a new device at unity", () => {
    let preferences = withMicrophoneGain(
      loadPreferences(owner),
      180,
      "microphone-a",
    );
    preferences = withMicrophoneGain(preferences, 70, "microphone-b");
    savePreferences(preferences, owner);
    expect(getMicrophoneGain(loadPreferences(owner), "microphone-a")).toBe(180);
    expect(getMicrophoneGain(loadPreferences(owner), "microphone-b")).toBe(70);
    expect(getMicrophoneGain(loadPreferences(owner), "microphone-c")).toBe(100);
  });

  it("never inherits default aliases when a different physical device appears", () => {
    let preferences: AudioPreferences = {
      ...loadPreferences(owner),
      microphoneGains: {
        "system-default": 180,
        default: 170,
        communications: 160,
      },
    };
    for (const alias of ["", "default", "communications", "system-default"]) {
      expect(getMicrophoneGain(preferences, alias)).toBe(100);
      expect(withMicrophoneGain(preferences, 200, alias)).toBe(preferences);
    }
    expect(getMicrophoneGain(preferences, "resolved-default-microphone")).toBe(
      100,
    );
    preferences = withMicrophoneGain(
      preferences,
      75,
      "resolved-default-microphone",
    );
    expect(getMicrophoneGain(preferences, "resolved-default-microphone")).toBe(
      75,
    );
    expect(
      getMicrophoneGain({
        ...preferences,
        inputDeviceId: "new-explicit-microphone",
      }),
    ).toBe(100);
    savePreferences(preferences, owner);
    expect(
      getMicrophoneGain(loadPreferences(owner), "another-default-microphone"),
    ).toBe(100);
    expect(
      getMicrophoneGain(
        loadPreferences(otherOwner),
        "resolved-default-microphone",
      ),
    ).toBe(100);
  });

  it("restores a person's previous nonzero gain when unmuting", () => {
    let preferences = withParticipantVolume(
      loadPreferences(owner),
      member,
      260,
    );
    preferences = toggleParticipantVolume(preferences, member);
    expect(preferences.participantVolumes[member]).toBe(0);
    savePreferences(preferences, owner);
    expect(
      toggleParticipantVolume(loadPreferences(owner), member)
        .participantVolumes[member],
    ).toBe(260);
  });

  it("clamps finite values, rejects unknown credential fields and prototype keys", () => {
    const values = {
      ...createDefaultAudioPreferences(),
      callVolume: 999,
      programVolume: -1,
      participantVolumes: { [member]: 900 },
      microphoneGains: { device: -100 },
    };
    localStorage.setItem(audioPreferencesKey(owner)!, stored(values));
    const preferences = loadPreferences(owner);
    expect(preferences.callVolume).toBe(100);
    expect(preferences.programVolume).toBe(0);
    expect(preferences.participantVolumes[member]).toBe(500);
    expect(preferences.microphoneGains.device).toBe(0);
    savePreferences(
      { ...preferences, token: "must-not-persist" } as AudioPreferences,
      owner,
    );
    expect(localStorage.getItem(audioPreferencesKey(owner)!)).not.toContain(
      "must-not-persist",
    );
    expect(withMicrophoneGain(preferences, 180, "__proto__")).toBe(preferences);
    expect(withParticipantVolume(preferences, "not-an-account", 300)).toBe(
      preferences,
    );
  });

  it.each([
    "{",
    "x".repeat(32_769),
    JSON.stringify({ version: 2, preferences: { callVolume: 80 } }),
  ])("rejects invalid or oversized persisted data", (input) => {
    localStorage.setItem(audioPreferencesKey(owner)!, input);
    expect(loadPreferences(owner)).toEqual(createDefaultAudioPreferences());
  });

  it("rejects excessive records and invalid scalar types", () => {
    const preferences = createDefaultAudioPreferences();
    preferences.microphoneGains = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`device-${index}`, 100]),
    );
    localStorage.setItem(audioPreferencesKey(owner)!, stored(preferences));
    expect(loadPreferences(owner).microphoneGains).toEqual({});
    savePreferences(
      { ...createDefaultAudioPreferences(), callVolume: Number.NaN },
      owner,
    );
    expect(loadPreferences(owner).callVolume).toBe(50);
  });

  it("keeps validated settings in memory when browser storage fails", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    savePreferences({ ...loadPreferences(owner), callVolume: 27 }, owner);
    expect(loadPreferences(owner).callVolume).toBe(27);
    expect(loadPreferences(otherOwner).callVolume).toBe(50);
  });

  it("updates other subscribers only with validated account data", () => {
    expect(loadPreferences(owner).callVolume).toBe(50);
    const listener = vi.fn();
    const unsubscribe = subscribeAudioPreferences(listener);
    localStorage.setItem(
      audioPreferencesKey(owner)!,
      stored({ ...createDefaultAudioPreferences(), callVolume: 65 }),
    );
    const event = new Event("storage");
    Object.assign(event, {
      key: audioPreferencesKey(owner),
      newValue: localStorage.getItem(audioPreferencesKey(owner)!),
    });
    window.dispatchEvent(event);
    expect(listener).toHaveBeenCalledOnce();
    expect(loadPreferences(owner).callVolume).toBe(65);
    unsubscribe();
  });

  it("logout preserves only valid audio records and removes diagnostic storage", () => {
    savePreferences(
      withParticipantVolume(loadPreferences(owner), member, 350),
      owner,
    );
    localStorage.setItem(
      "simplewatch.audio-preferences.v2:not-an-account",
      "unsafe",
    );
    localStorage.setItem(
      audioPreferencesKey(otherOwner)!,
      JSON.stringify({ token: "secret" }),
    );
    localStorage.setItem("simplewatch.token", "secret");
    localStorage.setItem("unrelated.app", "preserve");
    sessionStorage.setItem("simplewatch.room-state", "private");
    sessionStorage.setItem("simplewatch.playback-trace", "private");
    sessionStorage.setItem("unrelated.app", "preserve");
    purgeNonAudioStorage();
    expect(loadPreferences(owner).participantVolumes[member]).toBe(350);
    expect(localStorage.length).toBe(2);
    expect(localStorage.getItem("unrelated.app")).toBe("preserve");
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem("unrelated.app")).toBe("preserve");
  });

  it("reset clears every account and notifies microphone owners to stop capture", () => {
    savePreferences({ ...loadPreferences(owner), callVolume: 90 }, owner);
    savePreferences(
      { ...loadPreferences(otherOwner), callVolume: 75 },
      otherOwner,
    );
    const stopCapture = vi.fn();
    const unsubscribe = subscribeAudioPreferenceResets(stopCapture);
    clearAudioPreferences();
    expect(stopCapture).toHaveBeenCalledOnce();
    expect(loadPreferences(owner).callVolume).toBe(50);
    expect(loadPreferences(otherOwner).callVolume).toBe(50);
    expect(localStorage.length).toBe(0);
    unsubscribe();
  });
});
