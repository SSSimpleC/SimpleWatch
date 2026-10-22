import { describe, expect, it } from "vitest";

import { mediaErrorMessage, vodPhaseLabel } from "../src/player-ui.js";

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
