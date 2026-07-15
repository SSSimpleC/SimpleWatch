import { describe, expect, it } from "vitest";

import type { MediaItem } from "../src/api.js";
import { averageBitrateMbps, isHighLoadVod } from "../src/media-performance.js";

describe("VOD performance classification", () => {
  it("flags a high bitrate HEVC original without changing its bitrate", () => {
    const media: MediaItem = {
      id: "019f6555-77a3-753c-bbfd-7c27c1d70f52",
      displayName: "DJI original.MP4",
      state: "published",
      bytes: 156_336_480,
      compatibilityReasons: [],
      durationMs: 35_926,
      video: {
        codec: "hevc",
        playbackSupport: "device-dependent",
        width: 2688,
        height: 1512,
        fps: 29.97,
        pixelFormat: "yuv420p10le",
      },
      audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
      subtitles: [],
    };

    expect(averageBitrateMbps(media)).toBeCloseTo(34.81, 1);
    expect(isHighLoadVod(media)).toBe(true);
    expect(media.bytes).toBe(156_336_480);
  });
});
