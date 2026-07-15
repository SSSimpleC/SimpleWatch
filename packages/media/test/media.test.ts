import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateCompatibility,
  hasFastStart,
  sanitizeDisplayName,
  validateWebVtt,
} from "../src/index.js";

const compatibleProbe = {
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      pix_fmt: "yuv420p",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30/1",
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      channels: 2,
      channel_layout: "stereo",
      sample_rate: "48000",
    },
  ],
  format: {
    duration: "10.0",
    size: "123456",
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
  },
};

describe("media compatibility", () => {
  it("requires the moov atom before mdat", () => {
    const root = mkdtempSync(resolve("tmp/media-atoms-"));
    const fast = join(root, "fast.mp4");
    const slow = join(root, "slow.mp4");
    const atom = (name: string) => {
      const bytes = Buffer.alloc(8);
      bytes.writeUInt32BE(8, 0);
      bytes.write(name, 4, 4, "ascii");
      return bytes;
    };
    try {
      writeFileSync(
        fast,
        Buffer.concat([atom("ftyp"), atom("moov"), atom("mdat")]),
      );
      writeFileSync(
        slow,
        Buffer.concat([atom("ftyp"), atom("mdat"), atom("moov")]),
      );
      expect(hasFastStart(fast)).toBe(true);
      expect(hasFastStart(slow)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed, truncated, extended, and missing moov atoms", () => {
    const root = mkdtempSync(resolve("tmp/media-malformed-atoms-"));
    try {
      const empty = join(root, "empty.mp4");
      const zeroSized = join(root, "zero.mp4");
      const invalidSize = join(root, "invalid.mp4");
      const truncatedExtended = join(root, "truncated-extended.mp4");
      const hugeExtended = join(root, "huge-extended.mp4");
      writeFileSync(empty, Buffer.alloc(0));
      const zero = Buffer.alloc(8);
      zero.write("mdat", 4, 4, "ascii");
      writeFileSync(zeroSized, zero);
      const invalid = Buffer.alloc(8);
      invalid.writeUInt32BE(4, 0);
      invalid.write("moov", 4, 4, "ascii");
      writeFileSync(invalidSize, invalid);
      const extended = Buffer.alloc(8);
      extended.writeUInt32BE(1, 0);
      extended.write("moov", 4, 4, "ascii");
      writeFileSync(truncatedExtended, extended);
      const huge = Buffer.alloc(16);
      huge.writeUInt32BE(1, 0);
      huge.write("moov", 4, 4, "ascii");
      huge.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
      writeFileSync(hugeExtended, huge);

      for (const file of [
        empty,
        zeroSized,
        invalidSize,
        truncatedExtended,
        hugeExtended,
      ]) {
        expect(hasFastStart(file)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the locked H.264/AAC stereo profile", () => {
    expect(evaluateCompatibility(compatibleProbe)).toMatchObject({
      compatible: true,
      reasons: [],
      durationMs: 10_000,
      bytes: 123_456,
    });
  });

  it("accepts H.265 MP4 for device-dependent direct playback", () => {
    const result = evaluateCompatibility({
      ...compatibleProbe,
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          codec_tag_string: "hvc1",
          pix_fmt: "yuv420p10le",
          width: 1920,
          height: 1080,
          avg_frame_rate: "24/1",
        },
        compatibleProbe.streams[1],
      ],
    });
    expect(result).toMatchObject({
      compatible: true,
      playbackSupport: "device-dependent",
      reasons: [],
      video: { codec: "hevc", codecTag: "hvc1", fps: 24 },
    });
  });

  it("reports every incompatible codec constraint", () => {
    const result = evaluateCompatibility({
      ...compatibleProbe,
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          pix_fmt: "yuv420p10le",
          width: 3840,
          height: 2160,
          avg_frame_rate: "60/1",
        },
        {
          codec_type: "audio",
          codec_name: "dts",
          channels: 6,
          sample_rate: "44100",
        },
      ],
    });
    expect(result.compatible).toBe(false);
    expect(result.reasons).toEqual([
      "视频分辨率必须不高于 1920×1080",
      "视频帧率必须不高于 30 fps",
      "音频编码必须为 AAC-LC",
      "节目音频必须为双声道",
      "节目音频采样率必须为 48 kHz",
    ]);
  });

  it("reports missing tracks, malformed rates, unknown sizes and non-MP4", () => {
    const result = evaluateCompatibility({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          pix_fmt: "yuv420p",
          width: 640,
          height: 360,
          avg_frame_rate: "not-a-rate/0",
        },
      ],
      format: {
        duration: "not-a-number",
        size: undefined,
        format_name: "matroska",
      },
    });
    expect(result.compatible).toBe(false);
    expect(result.durationMs).toBeNull();
    expect(result.bytes).toBeNull();
    expect(result.audio).toEqual({
      codec: null,
      channels: null,
      sampleRate: null,
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "视频帧率必须不高于 30 fps",
        "缺少音频轨",
        "容器必须为 MP4",
      ]),
    );
    const noTracks = evaluateCompatibility({
      streams: [],
      format: {},
    });
    expect(noTracks.reasons).toEqual(
      expect.arrayContaining(["缺少视频轨", "缺少音频轨", "容器必须为 MP4"]),
    );
  });
});

describe("media input validation", () => {
  it("normalizes WebVTT line endings", () => {
    expect(
      validateWebVtt("WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nHello"),
    ).toBe("WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n");
  });

  it("rejects malformed and oversized WebVTT while preserving a final newline", () => {
    expect(() => validateWebVtt("not-vtt")).toThrow("WEBVTT");
    expect(() => validateWebVtt("WEBVTT\n\u0000")).toThrow("NUL");
    expect(() =>
      validateWebVtt(`WEBVTT\n${"x".repeat(2 * 1024 * 1024)}`),
    ).toThrow("2 MiB");
    expect(validateWebVtt("WEBVTT\n")).toBe("WEBVTT\n");
  });

  it("rejects traversal and path separators in display names", () => {
    expect(() => sanitizeDisplayName("../movie.mp4")).toThrow("文件名无效");
    expect(() => sanitizeDisplayName("folder\\movie.mp4")).toThrow(
      "文件名无效",
    );
  });

  it("normalizes safe names and rejects blank, reserved, control and long names", () => {
    expect(sanitizeDisplayName("  movie.mp4  ")).toBe("movie.mp4");
    for (const invalid of ["", ".", "..", "bad\u0000name", "x".repeat(256)]) {
      expect(() => sanitizeDisplayName(invalid)).toThrow("文件名无效");
    }
  });
});
