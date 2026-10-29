export type VoiceMode = "dialogue" | "original";

export interface AudioPreferences {
  programVolume: number;
  callVolume: number;
  inputDeviceId: string;
  pushToTalk: boolean;
  autoDuck: boolean;
  mode: VoiceMode;
  participantVolumes: Record<string, number>;
  participantPreviousVolumes: Record<string, number>;
  microphoneGains: Record<string, number>;
}

const legacyKey = "simplewatch.audio-preferences.v1";
const prefix = "simplewatch.audio-preferences.v2:";
const maximumStoredLength = 32_768;
const maximumEntries = 64;
const accountPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const listeners = new Set<() => void>();
const resetListeners = new Set<() => void>();
const memory = new Map<string, AudioPreferences>();
const anonymousDefaults = createDefaultAudioPreferences();
let listeningForStorage = false;

export function createDefaultAudioPreferences(): AudioPreferences {
  return {
    programVolume: 100,
    callVolume: 50,
    inputDeviceId: "",
    pushToTalk: false,
    autoDuck: false,
    mode: "dialogue",
    participantVolumes: {},
    participantPreviousVolumes: {},
    microphoneGains: {},
  };
}

/** Shared by reactive updates and explicit playback-unlock gestures. */
export function programOutputVolume(
  preferences: Pick<AudioPreferences, "programVolume" | "autoDuck">,
  anyoneSpeaking: boolean,
): number {
  const level = Number.isFinite(preferences.programVolume)
    ? clamp(preferences.programVolume, 100) / 100
    : 1;
  return level * (preferences.autoDuck && anyoneSpeaking ? 0.4 : 1);
}

export function audioPreferencesKey(accountId: string): string | null {
  return accountPattern.test(accountId) ? `${prefix}${accountId}` : null;
}

/** This module never searches storage for an account; identity comes from auth. */
export function loadPreferences(accountId?: string | null): AudioPreferences {
  const key = accountId ? audioPreferencesKey(accountId) : null;
  if (!key) return anonymousDefaults;
  const cached = memory.get(key);
  if (cached) return cached;
  let next = createDefaultAudioPreferences();
  try {
    // The old shared record cannot be attributed to the current person.
    localStorage.removeItem(legacyKey);
    next = decodeStoredPreferences(localStorage.getItem(key)) ?? next;
  } catch {
    // Private mode / blocked storage still supports this page's settings.
  }
  memory.set(key, next);
  return next;
}

export function savePreferences(
  preferences: AudioPreferences,
  accountId?: string | null,
): void {
  const key = accountId ? audioPreferencesKey(accountId) : null;
  if (!key) return;
  const next = validatePreferences(preferences);
  if (!next) return;
  memory.set(key, next);
  try {
    localStorage.removeItem(legacyKey);
    const serialized = JSON.stringify({ version: 2, preferences: next });
    if (serialized.length <= maximumStoredLength)
      localStorage.setItem(key, serialized);
  } catch {
    // Keep the validated in-memory copy when persistence is unavailable.
  }
  notifyListeners();
}

export function subscribeAudioPreferences(listener: () => void): () => void {
  listeners.add(listener);
  if (!listeningForStorage && typeof window !== "undefined") {
    window.addEventListener("storage", receiveStorageChange);
    listeningForStorage = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && listeningForStorage) {
      window.removeEventListener("storage", receiveStorageChange);
      listeningForStorage = false;
    }
  };
}

function receiveStorageChange(event: StorageEvent): void {
  if (event.key === null) memory.clear();
  else if (event.key.startsWith(prefix)) memory.delete(event.key);
  else return;
  if (event.newValue === null) notifyResetListeners();
  notifyListeners();
}

/** A reset must also stop an active microphone; ordinary slider changes do not. */
export function subscribeAudioPreferenceResets(
  listener: () => void,
): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

function notifyResetListeners(): void {
  for (const listener of resetListeners) listener();
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

/** Clear all accounts' local sound settings without displaying their identities. */
export function clearAudioPreferences(): void {
  memory.clear();
  try {
    for (const key of storageKeys(localStorage)) {
      if (key === legacyKey || key.startsWith(prefix))
        localStorage.removeItem(key);
    }
  } catch {
    // Clearing memory remains useful if browser storage is unavailable.
  }
  notifyResetListeners();
  notifyListeners();
}

/** Called only after successful server logout; auth state is cleared by caller. */
export function purgeNonAudioStorage(): void {
  try {
    for (const key of storageKeys(localStorage)) {
      if (!key.startsWith("simplewatch.")) continue;
      const accountId = key.startsWith(prefix) ? key.slice(prefix.length) : "";
      const safe = accountPattern.test(accountId)
        ? decodeStoredPreferences(localStorage.getItem(key))
        : null;
      if (safe) {
        localStorage.setItem(
          key,
          JSON.stringify({ version: 2, preferences: safe }),
        );
      } else {
        localStorage.removeItem(key);
        memory.delete(key);
      }
    }
  } catch {
    // Storage restrictions must not prevent logout and media teardown.
  }
  try {
    for (const key of storageKeys(sessionStorage)) {
      if (key.startsWith("simplewatch.")) sessionStorage.removeItem(key);
    }
  } catch {
    // In-memory credentials are cleared independently by the auth owner.
  }
  notifyListeners();
}

function storageKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

export function getMicrophoneGain(
  preferences: AudioPreferences,
  deviceId = preferences.inputDeviceId,
): number {
  // A default alias can point at a different physical microphone tomorrow.
  // Never reuse its gain for a newly discovered or unidentified device.
  if (!isRememberableMicrophoneDevice(deviceId)) return 100;
  return preferences.microphoneGains[deviceId] ?? 100;
}

export function isRememberableMicrophoneDevice(deviceId: string): boolean {
  return (
    validDeviceKey(deviceId) &&
    !["system-default", "default", "communications"].includes(deviceId)
  );
}

export function withMicrophoneGain(
  preferences: AudioPreferences,
  gain: number,
  deviceId = preferences.inputDeviceId,
): AudioPreferences {
  if (!isRememberableMicrophoneDevice(deviceId) || !Number.isFinite(gain))
    return preferences;
  return {
    ...preferences,
    microphoneGains: {
      ...preferences.microphoneGains,
      [deviceId]: clamp(gain, 200),
    },
  };
}

export function withParticipantVolume(
  preferences: AudioPreferences,
  accountId: string,
  volume: number,
): AudioPreferences {
  if (!accountPattern.test(accountId) || !Number.isFinite(volume))
    return preferences;
  const next = clamp(volume, 500);
  const previous = preferences.participantVolumes[accountId] ?? 100;
  return {
    ...preferences,
    participantVolumes: {
      ...preferences.participantVolumes,
      [accountId]: next,
    },
    participantPreviousVolumes: {
      ...preferences.participantPreviousVolumes,
      [accountId]:
        next > 0
          ? next
          : previous > 0
            ? previous
            : (preferences.participantPreviousVolumes[accountId] ?? 100),
    },
  };
}

export function toggleParticipantVolume(
  preferences: AudioPreferences,
  accountId: string,
): AudioPreferences {
  const current = preferences.participantVolumes[accountId] ?? 100;
  const previous = preferences.participantPreviousVolumes[accountId] ?? 100;
  return withParticipantVolume(
    preferences,
    accountId,
    current > 0 ? 0 : previous > 0 ? previous : 100,
  );
}

function decodeStoredPreferences(
  value: string | null,
): AudioPreferences | null {
  if (!value || value.length > maximumStoredLength) return null;
  try {
    const envelope: unknown = JSON.parse(value);
    if (
      !isRecord(envelope) ||
      !hasOnlyKeys(envelope, ["version", "preferences"])
    )
      return null;
    if (envelope.version !== 2) return null;
    return validatePreferences(envelope.preferences);
  } catch {
    return null;
  }
}

function validatePreferences(value: unknown): AudioPreferences | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "programVolume",
      "callVolume",
      "inputDeviceId",
      "pushToTalk",
      "autoDuck",
      "mode",
      "participantVolumes",
      "participantPreviousVolumes",
      "microphoneGains",
    ])
  )
    return null;
  if (
    !isFiniteNumber(value.programVolume) ||
    !isFiniteNumber(value.callVolume) ||
    typeof value.inputDeviceId !== "string" ||
    (value.inputDeviceId !== "" && !validDeviceKey(value.inputDeviceId)) ||
    typeof value.pushToTalk !== "boolean" ||
    typeof value.autoDuck !== "boolean" ||
    (value.mode !== "dialogue" && value.mode !== "original")
  )
    return null;
  const participantVolumes = validateLevels(
    value.participantVolumes,
    500,
    (key) => accountPattern.test(key),
  );
  const participantPreviousVolumes = validateLevels(
    value.participantPreviousVolumes,
    500,
    (key) => accountPattern.test(key),
  );
  const microphoneGains = validateLevels(
    value.microphoneGains,
    200,
    validDeviceKey,
  );
  if (!participantVolumes || !participantPreviousVolumes || !microphoneGains)
    return null;
  return {
    programVolume: clamp(value.programVolume, 100),
    callVolume: clamp(value.callVolume, 100),
    inputDeviceId: value.inputDeviceId,
    pushToTalk: value.pushToTalk,
    autoDuck: value.autoDuck,
    mode: value.mode,
    participantVolumes,
    participantPreviousVolumes,
    microphoneGains,
  };
}

function validateLevels(
  value: unknown,
  maximum: number,
  validKey: (key: string) => boolean,
): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > maximumEntries) return null;
  const result: Record<string, number> = {};
  for (const [key, level] of entries) {
    if (!validKey(key) || !isFiniteNumber(level)) return null;
    result[key] = clamp(level, maximum);
  }
  return result;
}

function validDeviceKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }) &&
    !["__proto__", "constructor", "prototype"].includes(value)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, maximum: number): number {
  return Math.round(Math.min(maximum, Math.max(0, value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
