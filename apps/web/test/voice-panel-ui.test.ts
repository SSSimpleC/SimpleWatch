import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  VoicePanel,
  type VoicePanelProps,
} from "../src/components/VoicePanel.js";
import {
  createDefaultAudioPreferences,
  withMicrophoneGain,
} from "../src/preferences.js";

const noop = () => undefined;
const baseline: VoicePanelProps = {
  preferences: createDefaultAudioPreferences(),
  selfName: "Host",
  participants: [
    {
      id: "member-a",
      accountId: null,
      nickname: "Simple",
      volume: 175,
      connected: true,
      speaking: false,
      muted: false,
    },
  ],
  connection: "connected",
  output: "awaiting-gesture",
  microphone: "off",
  inputDevices: [],
  onPreferencesChange: noop,
  onEnableAudio: noop,
  onToggleMicrophone: noop,
  onRetry: noop,
  onPushToTalk: noop,
  onParticipantVolumeChange: noop,
};

function render(overrides: Partial<VoicePanelProps> = {}) {
  return renderToStaticMarkup(
    createElement(VoicePanel, { ...baseline, ...overrides }),
  );
}

describe("voice mixer UI contract", () => {
  it("separates channel connection, blocked output and an uncaptured microphone", () => {
    const html = render();
    expect(html).toContain("已加入语音频道");
    expect(html).toContain("启用语音声音");
    expect(html).toContain("麦克风关闭 · 未采集");
    expect(html).toContain("采集声道尚未确认");
    expect(html).not.toContain("麦克风已接通");
  });

  it("exposes accessible individual 500% and local sending 200% controls", () => {
    const html = render();
    expect(html).toMatch(/type="range" min="0" max="500"/);
    expect(html).toMatch(/type="range" min="0" max="200"/);
    expect(html).toContain("Simple 收听音量");
    expect(html).toContain("我的麦克风发送增益");
    expect(html).toContain("175%，增益区");
    expect(html).toContain("此成员的音量仅保留在本次房间");
    expect(html).toContain("不在本机回放自己的麦克风");
  });

  it("uses the captured real device gain rather than a different default-device gain", () => {
    let preferences = withMicrophoneGain(createDefaultAudioPreferences(), 50);
    preferences = withMicrophoneGain(preferences, 170, "real-microphone");
    const html = render({
      preferences,
      effectiveInputDeviceId: "real-microphone",
    });
    expect(html).toContain("170%，增益区");
    expect(html).not.toContain("real-microphone");
  });

  it("disables gain for an unidentified default device without requesting capture", () => {
    const html = render();
    expect(html).toContain("实际麦克风尚未确认");
    expect(html).toMatch(
      /disabled="" aria-label="我的麦克风发送增益"[^>]*value="100"/,
    );
    const identified = render({
      effectiveInputDeviceId: "physical-microphone",
    });
    expect(identified).not.toContain("实际麦克风尚未确认");
    expect(identified).not.toMatch(
      /disabled="" aria-label="我的麦克风发送增益"/,
    );
  });

  it("labels PTT armed capture honestly and does not call it off", () => {
    const html = render({
      preferences: { ...createDefaultAudioPreferences(), pushToTalk: true },
      microphone: "armed",
      output: "running",
    });
    expect(html).toContain("按键待命 · 麦克风仍在使用");
    expect(html).toContain("按住说话 · 松开发送停止");
    expect(html).toContain("关闭麦克风");
    expect(html).not.toContain("麦克风关闭 · 未采集");
  });

  it("does not pretend browser controls are Apple's system microphone modes", () => {
    const html = render({
      preferences: { ...createDefaultAudioPreferences(), mode: "original" },
      channels: 1,
    });
    expect(html).toContain("原声（建议佩戴耳机）");
    expect(html).toContain("系统处理不一定关闭");
    expect(html).toContain("网页不能替你选择或确认这些模式");
    expect(html).toContain("当前采集：单声道");
    expect(html).not.toContain('<option value="voice-isolation"');
    expect(html).toContain("96 kbps 目标");
  });

  it("keeps a distinct explicit cross-tab takeover action and a mobile dialog", () => {
    const html = render({ connection: "other-tab", onTakeover: noop });
    expect(html).toContain("语音由另一标签页使用");
    expect(html).toContain("在此标签页使用语音");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("<dialog");
    expect(html).toContain("收起语音设置");
  });

  it("separates a capture error and output overload from channel connectivity", () => {
    const html = render({
      microphoneError: "麦克风权限被拒绝",
      outputOverloaded: true,
    });
    expect(html).toContain("麦克风权限被拒绝；收听与影片播放不受影响。");
    expect(html).toContain("混音声音过强");
    expect(html).toContain("已加入语音频道");
    expect(html).not.toContain("语音连接待重试");
  });

  it("gives desktop and mobile controls unique ids and stable accessible slider names", () => {
    const html = render();
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const referenced = [
      ...html.matchAll(/(?:for|aria-labelledby)="([^"]+)"/g),
    ].map((match) => match[1]);
    for (const reference of referenced) expect(ids).toContain(reference);
    expect(html).toContain('aria-label="Simple 收听音量"');
    expect(html).toContain('aria-label="我的麦克风发送增益"');
  });

  it("keeps voice-specific layout guards against the global room and settings rules", () => {
    const css = readFileSync(
      new URL("../src/components/voice-panel.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(
      /\.screen-layout:has\(> \.audience-panel > \.voice-panel\)\s*\{\s*align-items: start;/,
    );
    expect(css).toMatch(
      /\.screen-layout > \.audience-panel:has\(> \.voice-panel\)\s*\{\s*min-width: 0;/,
    );
    expect(css).toMatch(
      /\.room-shell\.theater-mode \.audience-panel:has\(> \.voice-panel\)\s*\{\s*display: block;/,
    );
    expect(css).toMatch(
      /\.settings-panel\.voice-settings > \.voice-panel__check\s*\{\s*display: flex;/,
    );
    expect(css).toContain("body:has(.voice-panel__drawer[open])");
    expect(css).toContain("max-height: calc(100dvh - 9rem)");
    expect(css).toContain("scrollbar-gutter: stable");
    expect(css).toMatch(
      /\.voice-panel__desktop \.voice-panel__microphone-quick\s*\{\s*position: sticky;/,
    );
  });
});
