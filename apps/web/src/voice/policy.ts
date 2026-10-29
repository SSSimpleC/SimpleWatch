import type { TrackPublishOptions } from "livekit-client";
import type { VoiceMember, VoiceMode, VoiceSettings } from "./types.js";

export function volumeGain(
  value: number,
  maximum: number,
  fallback = 100,
): number {
  return (
    Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : fallback)) /
    100
  );
}

export function normalizeVoiceSettings(settings: VoiceSettings): VoiceSettings {
  const participantVolumes: Record<string, number> = {};
  for (const [id, value] of Object.entries(settings.participantVolumes)) {
    participantVolumes[id] = volumeGain(value, 500) * 100;
  }
  return {
    masterVolume: volumeGain(settings.masterVolume, 100, 50) * 100,
    participantVolumes,
    microphoneGain: volumeGain(settings.microphoneGain, 200) * 100,
    inputDeviceId: settings.inputDeviceId,
    mode: settings.mode === "original" ? "original" : "dialogue",
  };
}

export function captureConstraints(
  settings: Pick<VoiceSettings, "mode" | "inputDeviceId">,
  relaxed = false,
): MediaTrackConstraints {
  const dialogue = settings.mode === "dialogue";
  return {
    echoCancellation: dialogue,
    noiseSuppression: dialogue,
    autoGainControl: dialogue,
    ...(settings.inputDeviceId
      ? { deviceId: { exact: settings.inputDeviceId } }
      : {}),
    ...(!relaxed
      ? { channelCount: { ideal: 2 }, sampleRate: { ideal: 48_000 } }
      : {}),
  };
}

export function captureChannels(settings: MediaTrackSettings): {
  channels: 1 | 2;
  confirmed: boolean;
} {
  return {
    channels: settings.channelCount === 2 ? 2 : 1,
    confirmed: settings.channelCount === 1 || settings.channelCount === 2,
  };
}

/** Browser aliases are routes, not stable identities for per-microphone gain. */
export function concreteInputDeviceId(
  settings: MediaTrackSettings,
  devices: ReadonlyArray<
    Pick<MediaDeviceInfo, "kind" | "deviceId" | "groupId">
  > = [],
): string {
  const concrete = (id: string | undefined): id is string =>
    Boolean(id && id !== "default" && id !== "communications");
  if (concrete(settings.deviceId)) return settings.deviceId;
  if (!settings.groupId) return "";
  const matches = new Set(
    devices
      .filter(
        (device) =>
          device.kind === "audioinput" &&
          device.groupId === settings.groupId &&
          concrete(device.deviceId),
      )
      .map((device) => device.deviceId),
  );
  // Some drivers expose several microphones in one group; do not guess.
  return matches.size === 1 ? [...matches][0]! : "";
}

export function voicePublishOptions(
  mode: VoiceMode,
  channels: 1 | 2,
): TrackPublishOptions {
  return {
    audioPreset: { maxBitrate: 96_000, priority: "high" },
    forceStereo: channels === 2,
    dtx: mode === "dialogue" && channels === 1,
    red: mode === "dialogue",
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Presentation mapping only. Server membership remains the authority. */
export function memberForIdentity(
  identity: string,
  members: readonly VoiceMember[],
): VoiceMember | undefined {
  const parts = identity.split(":");
  const memberId =
    parts.length === 4 &&
    parts[0] === "v2" &&
    uuid.test(parts[1] ?? "") &&
    uuid.test(parts[2] ?? "") &&
    /^\d+$/.test(parts[3] ?? "")
      ? parts[1]
      : uuid.test(identity)
        ? identity
        : undefined;
  return memberId
    ? members.find((member) => member.id === memberId)
    : undefined;
}

export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["NotAllowedError", "SecurityError"].includes(error.name)
  );
}

export function isRelaxableCaptureError(error: unknown): boolean {
  return error instanceof Error && error.name === "OverconstrainedError";
}
