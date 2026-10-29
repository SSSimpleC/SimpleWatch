export type VoiceMode = "dialogue" | "original";

export interface VoiceSettings {
  masterVolume: number;
  participantVolumes: Readonly<Record<string, number>>;
  microphoneGain: number;
  inputDeviceId: string;
  mode: VoiceMode;
}

export interface VoiceMember {
  id: string;
  accountId: string | null;
  nickname: string;
}

export type VoiceConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "other-tab"
  | "unsupported"
  | "error"
  | "closed";
export type VoiceOutputState =
  | "awaiting-gesture"
  | "running"
  | "interrupted"
  | "failed";
export type VoiceMicrophoneState =
  | "off"
  | "requesting"
  | "armed"
  | "transmitting"
  | "error";

export interface VoiceParticipantState {
  memberId: string;
  accountId: string | null;
  nickname: string;
  connected: boolean;
  subscribed: boolean;
  muted: boolean;
  speaking: boolean;
  level: number;
}

export interface VoiceSessionState {
  connection: VoiceConnectionState;
  output: VoiceOutputState;
  microphone: VoiceMicrophoneState;
  participants: readonly VoiceParticipantState[];
  inputLevel: number;
  inputOverloaded: boolean;
  outputOverloaded: boolean;
  captureChannels: 1 | 2 | null;
  captureChannelsConfirmed: boolean;
  activeInputDeviceId: string;
  error: string | null;
  microphoneError: string | null;
}

export interface VoiceCredentials {
  url: string;
  token: string;
}

export interface VoiceDiagnostics {
  version: 1;
  connection: VoiceConnectionState;
  output: VoiceOutputState;
  microphone: VoiceMicrophoneState;
  mode: VoiceMode;
  targetBitrateKbps: 96;
  captureChannels: 1 | 2 | null;
  captureChannelsConfirmed: boolean;
  contextState: string;
  inputLevel: number;
  inputOverloaded: boolean;
  outputOverloaded: boolean;
  sendBitrateKbps: number | null;
  receiveBitrateKbps: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  concealedSamples: number | null;
  roundTripTimeMs: number | null;
  receivedTrackCount: number;
  sampledAtMs: number | null;
}

export const initialVoiceState: VoiceSessionState = {
  connection: "idle",
  output: "awaiting-gesture",
  microphone: "off",
  participants: [],
  inputLevel: 0,
  inputOverloaded: false,
  outputOverloaded: false,
  captureChannels: null,
  captureChannelsConfirmed: false,
  activeInputDeviceId: "",
  error: null,
  microphoneError: null,
};
