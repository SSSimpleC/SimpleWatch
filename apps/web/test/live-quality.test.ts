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
    expect(classifyViewerHealth(0.2, 80, 24)).toBe("good");
    expect(classifyViewerHealth(0.2, 80, 0)).toBe("poor");
    expect(classifyViewerHealth(null, null, null)).toBe("unknown");
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
        framesPerSecond: 0,
        renderedFramesPerSecond: 0,
        decodedFramesPerSecond: 30,
        health: "poor",
      }),
    ).toContain("解码或渲染");
  });

  it("does not describe an unmeasured OBS uplink as healthy", () => {
    const explanation = liveQualityExplanation(
      {
        ...healthySource,
        sourceHealth: "unknown",
        sourcePacketLossPercent: null,
        sourceBitrateMbps: null,
      },
      { ...viewerStats(), packetLossPercent: 2, health: "degraded" },
    );
    expect(explanation).toContain("观看端下行");
    expect(explanation).not.toMatch(/上行正常|OBS 上行正常/);
  });

  it("reports insufficient evidence when source or viewer measurements are unknown", () => {
    expect(
      liveQualityExplanation(
        {
          ...healthySource,
          sourceHealth: "unknown",
          sourcePacketLossPercent: null,
          sourceBitrateMbps: null,
        },
        viewerStats(),
      ),
    ).toContain("指标不足");
    expect(liveQualityExplanation(healthySource, null)).toContain("指标不足");
    expect(
      liveQualityExplanation(healthySource, {
        ...viewerStats(),
        packetLossPercent: null,
        framesPerSecond: null,
        renderedFramesPerSecond: null,
        decodedFramesPerSecond: null,
        health: "unknown",
      }),
    ).toContain("指标不足");
  });

  it("does not mistake healthy 24fps content for a browser decoder failure", () => {
    const viewer = {
      ...viewerStats(),
      framesPerSecond: 24,
      receivedFramesPerSecond: 24,
      decodedFramesPerSecond: 24,
      renderedFramesPerSecond: 24,
    };
    expect(
      classifyViewerHealth(
        viewer.packetLossPercent,
        viewer.rttMs,
        viewer.framesPerSecond,
      ),
    ).toBe("good");
    expect(liveQualityExplanation(healthySource, viewer)).not.toMatch(
      /解码或渲染|帧率不足/,
    );
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
    receivedFramesPerSecond: 30,
    decodedFramesPerSecond: 30,
    droppedFramesPerSecond: 0,
    renderedFramesPerSecond: 30,
    videoBytesReceived: 1000,
    videoDataGrowing: true,
    protocol: "UDP",
    health: "good",
  };
}
