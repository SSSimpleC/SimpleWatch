export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (
    init.body !== undefined &&
    init.body !== null &&
    !headers.has("content-type")
  )
    headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "HTTP_ERROR",
      payload?.error?.message ?? `请求失败（${response.status}）`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface MediaItem {
  id: string;
  displayName: string;
  state: "scanning" | "compatible" | "incompatible" | "failed" | "published";
  bytes: number;
  compatibilityReasons: string[];
  durationMs: number | null;
  video: {
    codec: "h264" | "hevc" | null;
    playbackSupport: "broad" | "device-dependent" | "unsupported";
    width: number | null;
    height: number | null;
    fps: number | null;
    pixelFormat: string | null;
  };
  audio: {
    codec: string | null;
    channels: number | null;
    sampleRate: number | null;
  };
  subtitles: Array<{
    id: string;
    language: string;
    label: string;
    format: "webvtt";
  }>;
}

export interface RoomSnapshot {
  roomId: string;
  revision: number;
  status: "active" | "closed";
  mode: "idle" | "vod" | "live";
  media: { id: string; title: string; durationSec: number } | null;
  live: { state: "offline" | "connecting" | "online" } | null;
  transport: {
    state: "playing" | "paused";
    positionSec: number;
    rate: number;
    anchoredAtServerMs: number;
  } | null;
  hostMemberId: string;
  members: Array<{
    id: string;
    nickname: string;
    role: "host" | "member";
    online: boolean;
  }>;
  serverNowMs: number;
}

export interface LiveStatus {
  state: "offline" | "online" | "unknown";
  hasVideo: boolean;
  hasAudio: boolean;
  videoTrackCount: number;
  audioTrackCount: number;
  sourceBitrateMbps: number | null;
  sourcePacketLossPercent: number | null;
  sourceHealth: "good" | "degraded" | "poor" | "unknown";
  checkedAt: string;
}

export interface ActiveRoomSummary {
  id: string;
  createdAt: string;
  inviteUrl: string;
  memberCount: number;
  onlineCount: number;
  maxMembers: 5;
  host: { id: string; nickname: string; online: boolean } | null;
  mode: "idle" | "vod" | "live";
  content:
    | { kind: "vod"; id: string; title: string }
    | { kind: "live"; title: string }
    | null;
  live: LiveStatus;
}
