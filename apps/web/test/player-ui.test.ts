import { describe, expect, it } from "vitest";

import { mediaErrorMessage, vodPhaseLabel } from "../src/player-ui.js";
import {
  allowsVodControl,
  DiagnosticsWriteGate,
  playbackComparisonLabel,
  vodSyncSummary,
} from "../src/vod-diagnostics.js";

describe("player error explanations", () => {
  it.each([
    { code: 1, expected: /加载已中止/, absent: /解码失败|网络请求失败/ },
    { code: 2, expected: /网络请求失败/, absent: /解码失败|格式不受支持/ },
    { code: 3, expected: /解码失败/, absent: /网络请求失败|加载已中止/ },
    { code: 4, expected: /格式不受支持或媒体地址不可用/, absent: /解码失败/ },
  ])(
    "explains MediaError $code without conflating causes",
    ({ code, expected, absent }) => {
      const message = mediaErrorMessage(code, "hevc");
      expect(message).toMatch(expected);
      expect(message).not.toMatch(absent);
      if (code === 3 || code === 4) expect(message).toContain("服务器不会转码");
      if (code === 2 || code === 4) expect(message).toContain("访问权限");
    },
  );

  it.each([null, 0, 99])("keeps unknown code %s inconclusive", (code) => {
    expect(mediaErrorMessage(code, "hevc")).toBe(
      "节目暂不可用，请检查网络、访问权限和文件状态",
    );
  });

  it("only adds supplied codec detail to the actual decode error", () => {
    expect(mediaErrorMessage(3, "h264")).toContain("（h264）");
    expect(mediaErrorMessage(3, null)).not.toMatch(/null|undefined|（/);
    expect(mediaErrorMessage(3)).not.toMatch(/null|undefined|（/);
    expect(mediaErrorMessage(2, "hevc")).not.toContain("hevc");
  });

  it("distinguishes gesture recovery, seeking, buffering, and final failure", () => {
    const labels = [
      "autoplay-blocked",
      "seeking",
      "buffering",
      "error",
    ] as const;
    expect(new Set(labels.map(vodPhaseLabel)).size).toBe(labels.length);
    expect(vodPhaseLabel("autoplay-blocked")).toContain("点击");
    expect(vodPhaseLabel("seeking")).toContain("同步");
    expect(vodPhaseLabel("buffering")).toContain("缓冲");
    expect(vodPhaseLabel("error")).toContain("重试");
  });
});

describe("VOD synchronization diagnostics", () => {
  it("distinguishes every page-local comparison and fences native control", () => {
    expect(playbackComparisonLabel("normal")).toBe("正常同步");
    expect(playbackComparisonLabel("native")).toContain("不参与同步");
    expect(playbackComparisonLabel("host-only")).toContain("固定1×");
    expect(allowsVodControl("normal")).toBe(true);
    expect(allowsVodControl("host-only")).toBe(true);
    expect(allowsVodControl("native")).toBe(false);
  });

  it("reports lag and lead instead of equating playback with synchronized frames", () => {
    expect(vodSyncSummary(1.234)).toBe("落后权威进度 1.23s，尚未同步");
    expect(vodSyncSummary(-2.456)).toBe("超前权威进度 2.46s，尚未同步");
    expect(vodSyncSummary(0.5)).toBe("播放位置偏差 500 ms");
    expect(vodSyncSummary(-0.109)).toBe("播放位置偏差 -109 ms");
    expect(vodSyncSummary(0)).not.toMatch(/成功|已同步|帧/);
    expect(vodSyncSummary(null)).toContain("待测");
    expect(vodSyncSummary(Number.NaN)).toContain("待测");
  });

  it("bounds diagnostic persistence to one write per second even at frame cadence", () => {
    const gate = new DiagnosticsWriteGate();
    let writes = 0;
    for (let time = 0; time < 5000; time += 10)
      if (gate.shouldWrite(time)) writes += 1;
    expect(writes).toBe(5);
    expect(gate.shouldWrite(Number.NaN)).toBe(false);
    expect(gate.shouldWrite(5000)).toBe(true);
    expect(gate.shouldWrite(5000)).toBe(false);
  });
});
