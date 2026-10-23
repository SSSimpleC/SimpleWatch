/** Local, bounded diagnostic export. Unknown keys and arbitrary text are
 * discarded, not copied and subsequently redacted. Never send this remotely. */
type SafeValue = string | number | boolean | null;
type SafeRecord = Record<string, SafeValue>;
type UnknownRecord = Record<string, unknown>;

const phases = [
  "disabled",
  "preparing",
  "seeking",
  "buffering",
  "playing",
  "paused",
  "autoplay-blocked",
  "error",
];
const reasons = [
  "explicit",
  "automatic",
  "alignment",
  "transport",
  "drift",
  "buffering",
  "settled",
  "reset",
  "recovery",
  "rendezvous",
  "resync",
];
const kinds = ["seek", "rate", "pause", "play", "hold", "release"];
const modes = ["normal", "native", "host-only"];
const events = new Set([
  "controller-action",
  "seek-requested",
  "rate-requested",
  "rate-observed",
  "command-submitted",
  "command-applied",
  "command-rejected",
  "command-unknown",
  "command-cancelled",
  "snapshot-refresh-timeout",
  "snapshot-received",
  "snapshot-stale",
  "snapshot-accepted",
  "live-recovery",
  "live-recovery-stopped",
  "media-stalled",
  ...[
    "loadedmetadata",
    "canplay",
    "canplaythrough",
    "playing",
    "pause",
    "waiting",
    "seeking",
    "seeked",
    "ended",
    "error",
    "timeupdate",
    "progress",
    "ratechange",
    "suspend",
    "emptied",
  ].map((event) => `media-${event}`),
  ...modes.map((mode) => `comparison-${mode}`),
  ...phases.flatMap((phase) =>
    ["verified", "pending", "unavailable"].map(
      (evidence) => `vod-${phase}-${evidence}`,
    ),
  ),
]);
const record = (value: unknown): UnknownRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15
    ? value
    : null;
const choice = (value: unknown, values: readonly string[]): string | null =>
  typeof value === "string" && value.length <= 64 && values.includes(value)
    ? value
    : null;
const flag = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;
const numbers = (value: UnknownRecord, keys: readonly string[]): SafeRecord =>
  Object.fromEntries(keys.map((key) => [key, numeric(value[key])]));

function action(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const [kind, reason, extra] = value.split(":");
  return extra === undefined && choice(kind, kinds) && choice(reason, reasons)
    ? value
    : null;
}

function effects(value: unknown): SafeRecord {
  const data = record(value);
  return {
    ...numbers(data, [
      "seekWrites",
      "rateWrites",
      "explicitSeeks",
      "automaticSeeks",
      "alignmentSeeks",
    ]),
    lastAction: action(data.lastAction),
  };
}

function controller(value: unknown): SafeRecord {
  const data = record(value);
  return {
    ...numbers(data, [
      "activeRevision",
      "targetSec",
      "driftSec",
      "intentId",
      "seekAttempts",
      "presentedTimeSec",
    ]),
    phase: choice(data.phase, phases),
    frameEvidence: choice(data.frameEvidence, [
      "verified",
      "pending",
      "unavailable",
    ]),
    // Only controller-owned fixed codes are exportable. Arbitrary error text
    // can contain paths, URLs or credentials and must remain excluded.
    errorCode: choice(data.error, [
      "media-playback-error",
      "seek-no-progress",
      "seek-target-not-reached",
      "seek-request-failed",
      "sync-recovery-budget-exhausted",
    ]),
    hasError: typeof data.error === "string" && data.error.length > 0,
  };
}

function traceEntry(value: unknown): SafeRecord {
  const data = record(value);
  return {
    ...numbers(data, [
      "serverAtMs",
      "revision",
      "positionSec",
      "targetSec",
      "presentedTimeSec",
      "connectionGeneration",
      "playbackRate",
      "bufferedAheadSec",
      "readyState",
      "presentedFrames",
      "frameAgeMs",
      "actionAtMs",
      "requestedTargetSec",
      "requestedRate",
      "previousRate",
    ]),
    event:
      typeof data.event === "string" &&
      data.event.length <= 64 &&
      events.has(data.event)
        ? data.event
        : "other",
    comparisonMode: choice(data.comparisonMode, modes),
    actionKind: choice(data.actionKind, kinds),
    actionReason: choice(data.actionReason, reasons),
  };
}

export interface PlayerReportInput {
  readonly buildId: string;
  readonly latestBuildId?: string | null;
  readonly online?: boolean;
  readonly visibility?: string;
  readonly room?: unknown;
  readonly program?: unknown;
  readonly live?: unknown;
  readonly trace?: unknown;
  readonly controller?: unknown;
}

export function buildPlayerReport(input: PlayerReportInput, at = new Date()) {
  const room = record(input.room);
  const program = record(input.program);
  const live = record(input.live);
  const build = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
      ? value
      : "unavailable";
  return {
    schemaVersion: 1,
    generatedAt: at.toISOString(),
    buildId: build(input.buildId),
    latestBuildId: input.latestBuildId ? build(input.latestBuildId) : null,
    environment: {
      online: flag(input.online),
      visibility: choice(input.visibility, ["visible", "hidden"]),
    },
    room: {
      ...numbers(room, ["revision"]),
      connected: flag(room.connected),
      voiceState: choice(room.voiceState, [
        "idle",
        "connecting",
        "connected",
        "error",
      ]),
    },
    program: {
      ...numbers(program, [
        "currentTimeSec",
        "durationSec",
        "bufferedAheadSec",
        "readyState",
        "networkState",
        "volume",
        "playbackRate",
        "positionDriftSec",
        "presentedTimeSec",
        "frameAgeMs",
        "stalls",
        "droppedFrames",
        "totalFrames",
        "syncDeltaMs",
        "clockRttMs",
        "averageBitrateMbps",
      ]),
      mode: choice(program.mode, ["idle", "vod", "live"]),
      comparisonMode: choice(program.comparisonMode, modes),
      codec: choice(program.codec, [
        "h264",
        "hevc",
        "av1",
        "vp8",
        "vp9",
        "mpeg4",
        "unknown",
      ]),
      muted: flag(program.muted),
      paused: flag(program.paused),
      seeking: flag(program.seeking),
      effects: effects(program.effects),
    },
    controller: controller(input.controller),
    live: {
      ...numbers(live, [
        "bitrateMbps",
        "packetLossPercent",
        "rttMs",
        "jitterMs",
        "jitterBufferMs",
        "framesPerSecond",
        "receivedFramesPerSecond",
        "decodedFramesPerSecond",
        "droppedFramesPerSecond",
        "renderedFramesPerSecond",
        "videoBytesReceived",
      ]),
      videoDataGrowing: flag(live.videoDataGrowing),
      protocol: choice(live.protocol, ["udp", "tcp", "unknown"]),
      health: choice(live.health, ["good", "degraded", "poor", "unknown"]),
    },
    trace: Array.isArray(input.trace)
      ? input.trace.slice(-120).map(traceEntry)
      : [],
  };
}

export function serializePlayerReport(input: PlayerReportInput): string {
  const report = buildPlayerReport(input);
  let serialized = JSON.stringify(report, null, 2);
  while (serialized.length > 64 * 1024 && report.trace.length > 0) {
    report.trace.shift();
    serialized = JSON.stringify(report, null, 2);
  }
  return serialized;
}

type ReportStorage = Pick<Storage, "getItem">;
export function readPlayerReportStorage(
  storage: ReportStorage | null,
): Pick<PlayerReportInput, "room" | "program" | "live" | "trace"> {
  const read = (key: string): unknown => {
    try {
      const text = storage?.getItem(key);
      return text && text.length <= 128 * 1024
        ? (JSON.parse(text) as unknown)
        : null;
    } catch {
      return null;
    }
  };
  return {
    room: read("simplewatch.room-state"),
    program: read("simplewatch.program-diagnostics"),
    live: read("simplewatch.live-diagnostics"),
    trace: read("simplewatch.playback-trace"),
  };
}

export function browserReportStorage(): ReportStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
