import { describe, expect, it } from "vitest";

import type { LiveStatus } from "../src/api.js";
import {
  classifyViewerHealth,
  liveQualityExplanation,
  type LiveViewerStats,
} from "../src/pages/RoomPage.js";

const healthySource: LiveStatus = {
  state: "online",
  hasVideo: true,
  hasAudio: true,
  videoTrackCount: 1,
  audioTrackCount: 1,
  sourceBitrateMbps: 3,
  sourcePacketLossPercent: 0.2,
  sourceHealth: "good",
  checkedAt: new Date(0).toISOString(),
};

describe("live quality diagnosis", () => {
  it("classifies packet loss, latency and render frame rate", () => {
    expect(classifyViewerHealth(0.5, 80, 30)).toBe("good");
    expect(classifyViewerHealth(1.5, 80, 30)).toBe("degraded");
    expect(classifyViewerHealth(0.2, 450, 30)).toBe("poor");
    expect(classifyViewerHealth(0.2, 80, 18)).toBe("poor");
    expect(classifyViewerHealth(0.2, 80, 0)).toBe("good");
  });

  it("distinguishes OBS uplink, viewer downlink and terminal rendering", () => {
    const viewer = viewerStats();
    expect(
      liveQualityExplanation(
        { ...healthySource, sourceHealth: "poor" },
        viewer,
      ),
    ).toContain("OBS 到服务器");
    expect(
      liveQualityExplanation(healthySource, {
        ...viewer,
        packetLossPercent: 2,
      }),
    ).toContain("观看端下行");
    expect(
      liveQualityExplanation(healthySource, {
        ...viewer,
        framesPerSecond: 20,
      }),
    ).toContain("解码或渲染");
  });
});

function viewerStats(): LiveViewerStats {
  return {
    bitrateMbps: 3,
    packetLossPercent: 0,
    rttMs: 80,
    jitterMs: 5,
    jitterBufferMs: 100,
    framesPerSecond: 30,
    protocol: "UDP",
    health: "good",
  };
}
