import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { promisify } from "node:util";

import { z } from "zod";

const execFileAsync = promisify(execFile);

export interface MoveFileOperations {
  readonly rename: (source: string, destination: string) => void;
  readonly copy: (source: string, destination: string) => void;
  readonly unlink: (path: string) => void;
  readonly remove: (path: string) => void;
}

const defaultMoveFileOperations: MoveFileOperations = {
  rename: renameSync,
  copy: copyFileSync,
  unlink: unlinkSync,
  remove: (path) => rmSync(path, { force: true }),
};

/**
 * Move a file without exposing a partially copied destination. Docker bind
 * mounts can share the same host filesystem while still returning EXDEV, so
 * callers must not rely on rename(2) alone.
 */
export function moveFile(
  source: string,
  destination: string,
  operations: MoveFileOperations = defaultMoveFileOperations,
): void {
  try {
    operations.rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }

  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    operations.copy(source, temporary);
    operations.rename(temporary, destination);
    operations.unlink(source);
  } catch (error) {
    operations.remove(temporary);
    throw error;
  }
}

const streamSchema = z.object({
  codec_type: z.enum(["video", "audio", "subtitle"]).or(z.string()),
  codec_name: z.string().optional(),
  codec_tag_string: z.string().optional(),
  pix_fmt: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  avg_frame_rate: z.string().optional(),
  sample_rate: z.string().optional(),
  channels: z.number().int().optional(),
  channel_layout: z.string().optional(),
});

const probeSchema = z.object({
  streams: z.array(streamSchema),
  format: z.object({
    duration: z.string().optional(),
    size: z.string().optional(),
    format_name: z.string().optional(),
  }),
});

export type ProbeDocument = z.infer<typeof probeSchema>;

export interface MediaCompatibility {
  readonly compatible: boolean;
  readonly playbackSupport: "broad" | "device-dependent" | "unsupported";
  readonly fastStart: boolean;
  readonly reasons: readonly string[];
  readonly durationMs: number | null;
  readonly bytes: number | null;
  readonly container: string | null;
  readonly video: {
    readonly codec: string | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly fps: number | null;
    readonly pixelFormat: string | null;
    readonly codecTag: string | null;
  };
  readonly audio: {
    readonly codec: string | null;
    readonly channels: number | null;
    readonly sampleRate: number | null;
  };
}

export async function probeFile(
  filePath: string,
  ffprobePath = "ffprobe",
): Promise<{
  readonly probe: ProbeDocument;
  readonly compatibility: MediaCompatibility;
}> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const probe = probeSchema.parse(JSON.parse(stdout) as unknown);
  const base = evaluateCompatibility(probe);
  const fastStart = hasFastStart(filePath);
  return {
    probe,
    compatibility: { ...base, fastStart },
  };
}

export function hasFastStart(filePath: string): boolean {
  const descriptor = openSync(filePath, "r");
  try {
    const size = fstatSync(descriptor).size;
    let offset = 0;
    let sawMdat = false;
    const header = Buffer.alloc(16);
    while (offset + 8 <= size) {
      if (readSync(descriptor, header, 0, 8, offset) !== 8) return false;
      let atomSize = header.readUInt32BE(0);
      const atomType = header.toString("ascii", 4, 8);
      let headerBytes = 8;
      if (atomSize === 1) {
        if (readSync(descriptor, header, 8, 8, offset + 8) !== 8) return false;
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        atomSize = Number(extended);
        headerBytes = 16;
      } else if (atomSize === 0) {
        atomSize = size - offset;
      }
      if (atomSize < headerBytes || offset + atomSize > size) return false;
      if (atomType === "moov") return !sawMdat;
      if (atomType === "mdat") sawMdat = true;
      offset += atomSize;
    }
    return false;
  } finally {
    closeSync(descriptor);
  }
}

export function evaluateCompatibility(probeInput: unknown): MediaCompatibility {
  const probe = probeSchema.parse(probeInput);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const fps = parseRate(video?.avg_frame_rate);
  const sampleRate = parseOptionalNumber(audio?.sample_rate);
  const durationSeconds = parseOptionalNumber(probe.format.duration);
  const bytes = parseOptionalNumber(probe.format.size);
  const reasons: string[] = [];

  if (!video) reasons.push("缺少视频轨");
  else {
    if (!new Set(["h264", "hevc"]).has(video.codec_name ?? ""))
      reasons.push("视频编码必须为 H.264 或 H.265/HEVC");
  }

  return {
    compatible: reasons.length === 0,
    playbackSupport:
      reasons.length > 0
        ? "unsupported"
        : video?.codec_name === "hevc" ||
            video?.pix_fmt !== "yuv420p" ||
            (video.width ?? 0) > 1920 ||
            (video.height ?? 0) > 1080 ||
            (fps ?? 0) > 30.5
          ? "device-dependent"
          : "broad",
    fastStart: true,
    reasons,
    container: probe.format.format_name ?? null,
    durationMs:
      durationSeconds === null ? null : Math.round(durationSeconds * 1000),
    bytes,
    video: {
      codec: video?.codec_name ?? null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps,
      pixelFormat: video?.pix_fmt ?? null,
      codecTag: video?.codec_tag_string ?? null,
    },
    audio: {
      codec: audio?.codec_name ?? null,
      channels: audio?.channels ?? null,
      sampleRate,
    },
  };
}

export function validateWebVtt(input: string): string {
  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.startsWith("WEBVTT"))
    throw new Error("字幕必须以 WEBVTT 开头");
  if (normalized.includes("\u0000")) throw new Error("字幕不得包含 NUL 字符");
  if (Buffer.byteLength(normalized, "utf8") > 2 * 1024 * 1024) {
    throw new Error("字幕不得超过 2 MiB");
  }
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export function sanitizeDisplayName(input: string): string {
  const normalized = input.trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    hasUnsafeFilenameCharacter(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new Error("文件名无效");
  }
  return normalized;
}

function hasUnsafeFilenameCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 31 ||
      codePoint === 127 ||
      character === "/" ||
      character === "\\"
    );
  });
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [numeratorText, denominatorText] = rate.split("/", 2);
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? "1");
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  return numerator / denominator;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
