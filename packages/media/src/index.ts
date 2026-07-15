import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { promisify } from "node:util";

import { z } from "zod";

const execFileAsync = promisify(execFile);

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
    if (
      !video.width ||
      !video.height ||
      video.width > 1920 ||
      video.height > 1080
    ) {
      reasons.push("视频分辨率必须不高于 1920×1080");
    }
    if (fps === null || fps > 30.5) reasons.push("视频帧率必须不高于 30 fps");
    if (video.codec_name === "h264" && video.pix_fmt !== "yuv420p") {
      reasons.push("H.264 视频像素格式必须为 yuv420p 8-bit SDR");
    }
    if (
      video.codec_name === "hevc" &&
      !new Set(["yuv420p", "yuv420p10le"]).has(video.pix_fmt ?? "")
    ) {
      reasons.push("H.265 视频像素格式必须为 yuv420p 或 yuv420p10le");
    }
  }

  if (!audio) reasons.push("缺少音频轨");
  else {
    if (audio.codec_name !== "aac") reasons.push("音频编码必须为 AAC-LC");
    if (audio.channels !== 2) reasons.push("节目音频必须为双声道");
    if (sampleRate !== 48_000) reasons.push("节目音频采样率必须为 48 kHz");
  }

  if (!probe.format.format_name?.split(",").includes("mp4")) {
    reasons.push("容器必须为 MP4");
  }

  return {
    compatible: reasons.length === 0,
    playbackSupport:
      reasons.length > 0
        ? "unsupported"
        : video?.codec_name === "hevc"
          ? "device-dependent"
          : "broad",
    fastStart: true,
    reasons,
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
