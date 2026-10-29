import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { RoomServiceClient } from "livekit-server-sdk";
import {
  closeFixtureRoom,
  logoutFixtureSession,
  stopFixturePageActivity,
} from "./cleanup.js";

const origin = "https://127.0.0.1:18443";
const rtc = new RoomServiceClient(
  "http://127.0.0.1:17880",
  "local-voice-gate-key",
  "local-voice-gate-secret-not-production-32-bytes",
);

interface CaptureEvidence {
  channels: number | null;
  sampleRate: number | null;
  source: "native-fake" | "generated-stereo";
  error?: string;
}

interface NegotiationWindow extends Window {
  voiceNegotiation: {
    peers: RTCPeerConnection[];
    captures: CaptureEvidence[];
    setSilent(silent: boolean): void;
  };
}

async function instrument(context: BrowserContext, channels: 1 | 2) {
  await context.addInitScript(
    ({ channels }) => {
      const peers: RTCPeerConnection[] = [];
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(configuration?: RTCConfiguration) {
          super(configuration);
          peers.push(this);
        }
      };
      const controls = new Set<(silent: boolean) => void>();
      const captures: CaptureEvidence[] = [];
      (window as unknown as NegotiationWindow).voiceNegotiation = {
        peers,
        captures,
        setSilent(silent) {
          for (const control of controls) control(silent);
        },
      };
      const nativeCapture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints?.audio || constraints.video)
          throw new Error("Negotiation gate permits fake audio only");
        if (channels === 1) {
          const requested =
            typeof constraints.audio === "object" ? constraints.audio : {};
          let stream: MediaStream;
          try {
            stream = await nativeCapture({
              audio: { ...requested, channelCount: { exact: 1 } },
              video: false,
            });
          } catch (error) {
            captures.push({
              channels: null,
              sampleRate: null,
              source: "native-fake",
              error:
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : String(error),
            });
            throw error;
          }
          const raw = stream.getAudioTracks()[0]!;
          const actual = raw.getSettings();
          captures.push({
            channels: actual.channelCount ?? null,
            sampleRate: actual.sampleRate ?? null,
            source: "native-fake",
          });
          if (actual.channelCount !== 1) {
            stream.getTracks().forEach((track) => track.stop());
            throw new Error(
              "Native fake exact:1 capture did not expose actual mono settings",
            );
          }
          // Test-source zero input, not SDK mute: the processed sender remains
          // enabled and the SFU publication must remain unmuted during silence.
          controls.add((silent) => {
            raw.enabled = !silent;
          });
          return stream;
        }
        // Native capture is the runner's Chromium fake device, never hardware.
        // Replace its signal with known independent channels so codec policy is
        // exercised through the real processor, browser encoder and local SFU.
        const fake = await nativeCapture(constraints);
        fake.getTracks().forEach((track) => track.stop());
        const donor = new AudioContext({ sampleRate: 48_000 });
        await donor.resume();
        const destination = new MediaStreamAudioDestinationNode(donor, {
          channelCount: channels,
          channelCountMode: "explicit",
        });
        const merger = donor.createChannelMerger(channels);
        merger.connect(destination);
        const gains: GainNode[] = [];
        const tones = Array.from({ length: channels }, (_, channel) => {
          const tone = donor.createOscillator();
          tone.frequency.value = channel === 0 ? 330 : 550;
          const gain = donor.createGain();
          gain.gain.value = 0.03;
          gains.push(gain);
          tone.connect(gain).connect(merger, 0, channel);
          tone.start();
          return tone;
        });
        const control = (silent: boolean) => {
          for (const gain of gains)
            gain.gain.setValueAtTime(silent ? 0 : 0.03, donor.currentTime);
        };
        controls.add(control);
        const track = destination.stream.getAudioTracks()[0]!;
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({
          ...settings(),
          deviceId: `voice-negotiation-${channels}-channel`,
        });
        const stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => {
          if (stopped) return;
          stopped = true;
          controls.delete(control);
          tones.forEach((tone) => {
            tone.stop();
            tone.disconnect();
          });
          gains.forEach((gain) => gain.disconnect());
          merger.disconnect();
          stop();
          void donor.close();
        };
        const actual = track.getSettings();
        captures.push({
          channels: actual.channelCount ?? null,
          sampleRate: actual.sampleRate ?? null,
          source: "generated-stereo",
        });
        if (actual.channelCount !== channels) {
          track.stop();
          throw new Error(
            `Synthetic capture fixture did not expose ${channels} actual channels`,
          );
        }
        return destination.stream;
      };
    },
    { channels },
  );
}

async function login(page: Page, username: "Host" | "Simple") {
  await page.goto("/");
  await page.getByLabel("账户名称").fill(username);
  await page
    .getByLabel("账户密码")
    .fill(
      username === "Host"
        ? "player-host-test-password-24-characters"
        : "player-viewer-test-password-24-characters",
    );
  await page.getByRole("button", { name: /凭证入场/ }).click();
}

async function encodingEvidence(page: Page) {
  return page.evaluate(async () => {
    const state = (window as unknown as NegotiationWindow).voiceNegotiation;
    const rows: Array<{
      codec: string;
      packets: number;
      bytes: number;
      at: number;
      senderMaxBitrate: number | null;
      senderEnabled: boolean;
      answerDtx: boolean;
      answerStereo: boolean;
      answerContainsRed: boolean;
      answerOpusMaximum: number | null;
    }> = [];
    for (const peer of state.peers) {
      if (peer.connectionState === "closed") continue;
      const reports = await peer.getStats();
      const audioSections = (peer.remoteDescription?.sdp ?? "")
        .split(/(?=^m=)/m)
        .filter((section) => section.startsWith("m=audio "));
      reports.forEach((entry) => {
        const row = entry as {
          type: string;
          kind?: string;
          bytesSent?: number;
          packetsSent?: number;
          timestamp: number;
          codecId?: string;
          mid?: string;
        };
        if (
          row.type !== "outbound-rtp" ||
          row.kind !== "audio" ||
          !row.bytesSent ||
          row.mid === undefined
        )
          return;
        const transceiver = peer
          .getTransceivers()
          .find((value) => value.mid === row.mid);
        if (transceiver?.sender.track?.kind !== "audio") return;
        const section = audioSections.find((value) =>
          value.split(/\r?\n/).includes(`a=mid:${row.mid}`),
        );
        if (!section) return;
        const opusPayload = /^a=rtpmap:(\d+) opus\/48000(?:\/2)?\r?$/im.exec(
          section,
        )?.[1];
        const fmtp = opusPayload
          ? (new RegExp(`^a=fmtp:${opusPayload} (.*)$`, "mi").exec(
              section,
            )?.[1] ?? "")
          : "";
        const parameters: Record<string, string> = {};
        for (const part of fmtp.trim().split(";")) {
          const [key, value] = part.trim().split("=", 2);
          if (key && value !== undefined) parameters[key] = value;
        }
        const codec = row.codecId
          ? (reports.get(row.codecId) as { mimeType?: string } | undefined)
          : undefined;
        rows.push({
          codec: codec?.mimeType?.toLowerCase() ?? "unknown",
          packets: row.packetsSent ?? 0,
          bytes: row.bytesSent,
          at: row.timestamp,
          senderMaxBitrate:
            transceiver.sender.getParameters().encodings[0]?.maxBitrate ?? null,
          senderEnabled: transceiver.sender.track.enabled,
          answerDtx: parameters.usedtx === "1",
          answerStereo: parameters.stereo === "1",
          answerContainsRed: /^a=rtpmap:\d+ red\/48000/im.test(section),
          answerOpusMaximum: parameters.maxaveragebitrate
            ? Number(parameters.maxaveragebitrate)
            : null,
        });
      });
    }
    // Return only parsed audio facts; never store SDP, ICE addresses or tokens.
    return rows;
  });
}

async function sample(page: Page) {
  const values = await encodingEvidence(page);
  expect(values).toHaveLength(1);
  return values[0]!;
}

function rates(
  before: Awaited<ReturnType<typeof sample>>,
  after: Awaited<ReturnType<typeof sample>>,
) {
  const seconds = (after.at - before.at) / 1000;
  expect(seconds).toBeGreaterThan(0);
  return {
    packetsPerSecond: (after.packets - before.packets) / seconds,
    kbps: ((after.bytes - before.bytes) * 8) / seconds / 1000,
  };
}

const matrix = [
  { mode: "dialogue", channels: 1, dtx: true, red: true },
  { mode: "dialogue", channels: 2, dtx: false, red: true },
  { mode: "original", channels: 1, dtx: false, red: false },
  { mode: "original", channels: 2, dtx: false, red: false },
] as const;

for (const scenario of matrix) {
  test(`actual Opus negotiation: ${scenario.mode}/${scenario.channels}ch, DTX=${scenario.dtx}, RED requested=${scenario.red} with existing Opus-only SFU fallback`, async ({
    browser,
  }, testInfo) => {
    const contexts: BrowserContext[] = [];
    let host: Page | undefined;
    let roomId: string | undefined;
    const cleanupFailures: unknown[] = [];
    try {
      const hostContext = await browser.newContext({
        baseURL: origin,
        ignoreHTTPSErrors: true,
      });
      contexts.push(hostContext);
      await instrument(hostContext, scenario.channels);
      host = await hostContext.newPage();
      await login(host, "Host");
      await host.getByRole("button", { name: /开启放映室/ }).click();
      await host
        .getByRole("button", { name: "进入主持房间", exact: true })
        .click();
      await expect(host).toHaveURL(/\/room\//);
      roomId = new URL(host.url()).pathname.split("/").at(-1);
      if (!roomId) throw new Error("Missing isolated negotiation room");
      const currentRoom = roomId;
      const viewerContext = await browser.newContext({
        baseURL: origin,
        ignoreHTTPSErrors: true,
      });
      contexts.push(viewerContext);
      const viewer = await viewerContext.newPage();
      await login(viewer, "Simple");
      const hostPanel = host.locator(".voice-panel__desktop");
      const viewerPanel = viewer.locator(".voice-panel__desktop");
      for (const panel of [hostPanel, viewerPanel])
        await expect(
          panel.getByText("已加入语音频道", { exact: true }),
        ).toBeVisible();
      await hostPanel.getByText("声音与设备选项", { exact: true }).click();
      await hostPanel
        .getByLabel("麦克风处理模式", { exact: true })
        .selectOption(scenario.mode);
      await host
        .getByRole("button", { name: "打开麦克风", exact: true })
        .click();
      await expect
        .poll(async () =>
          host!.evaluate(
            () =>
              (window as unknown as NegotiationWindow).voiceNegotiation.captures
                .length,
          ),
        )
        .toBeGreaterThan(0);
      const initialCapture = await host.evaluate(
        () =>
          (window as unknown as NegotiationWindow).voiceNegotiation.captures,
      );
      expect(initialCapture[0]?.channels, JSON.stringify(initialCapture)).toBe(
        scenario.channels,
      );
      await expect(
        host.getByRole("button", { name: "关闭麦克风", exact: true }),
      ).toBeVisible();
      const unlock = viewerPanel.getByRole("button", {
        name: /^(启用|恢复)语音声音$/,
      });
      if (await unlock.isVisible()) await unlock.click();
      await expect
        .poll(async () =>
          Number(
            await viewerPanel
              .getByLabel("Host 收听电平", { exact: true })
              .getAttribute("value"),
          ),
        )
        .toBeGreaterThan(0);
      await expect
        .poll(async () => (await encodingEvidence(host!)).length)
        .toBe(1);
      // DTX is checked against the accepted SFU answer and live packet behavior,
      // not merely the application's publish options or a muted sender.
      const beforeSpeech = await sample(host);
      await host.waitForTimeout(3000);
      const afterSpeech = await sample(host);
      await host.evaluate(() =>
        (window as unknown as NegotiationWindow).voiceNegotiation.setSilent(
          true,
        ),
      );
      await host.waitForTimeout(2000);
      const beforeSilence = await sample(host);
      await host.waitForTimeout(3000);
      const afterSilence = await sample(host);
      const speech = rates(beforeSpeech, afterSpeech);
      const silence = rates(beforeSilence, afterSilence);
      const active = await sample(host);
      const published = (
        await rtc.listParticipants(`voice:${currentRoom}`)
      ).find((entry) => entry.name === "Host")?.tracks;
      expect(published).toHaveLength(1);
      const track = published![0]!;
      const effectiveMode = await hostPanel
        .getByLabel("麦克风处理模式", { exact: true })
        .inputValue();
      const captures = await host.evaluate(
        () =>
          (window as unknown as NegotiationWindow).voiceNegotiation.captures,
      );
      await testInfo.attach("negotiated-audio-policy", {
        body: JSON.stringify({
          scenario,
          effectiveMode,
          captures,
          accepted: active,
          published: {
            disableDtx: track.disableDtx,
            disableRed: track.disableRed,
            stereo: track.stereo,
            muted: track.muted,
          },
          speech,
          silence,
          redStatus:
            "Existing SFU enabled_codecs is Opus-only: client RED request is retained, but negotiated and active RTP fallback must be Opus. This is not a RED-enabled pass.",
          caveat:
            "Local Chromium/SFU only. Mono uses native fake exact:1, without overriding getSettings; raw.enabled=false supplies digital zero while processed sender stays enabled and SFU publication unmuted. Stereo uses known tones. 96k is an encoder cap, not constant traffic; DTX accepted flags and silence packet behavior are distinct from SDP hints.",
        }),
        contentType: "application/json",
      });
      expect(effectiveMode).toBe(scenario.mode);
      expect(captures).toHaveLength(1);
      expect(captures[0]?.channels).toBe(scenario.channels);
      expect(active.senderMaxBitrate).toBe(96_000);
      expect(active.senderEnabled).toBe(true);
      expect(track.muted).toBe(false);
      expect(active.answerStereo).toBe(scenario.channels === 2);
      expect(active.answerContainsRed).toBe(false);
      expect(active.codec).toBe("audio/opus");
      expect(track.disableDtx).toBe(!scenario.dtx);
      expect(track.disableRed).toBe(!scenario.red);
      expect(track.stereo).toBe(scenario.channels === 2);
      expect(speech.packetsPerSecond).toBeGreaterThan(20);
      if (scenario.dtx)
        expect(silence.packetsPerSecond).toBeLessThan(
          speech.packetsPerSecond * 0.5,
        );
      else
        expect(silence.packetsPerSecond).toBeGreaterThan(
          speech.packetsPerSecond * 0.75,
        );
    } finally {
      if (host && !host.isClosed()) {
        const captureEvidence = await host
          .evaluate(
            () =>
              (window as unknown as NegotiationWindow).voiceNegotiation
                .captures,
          )
          .catch((error: unknown) => ({
            unavailable: error instanceof Error ? error.message : String(error),
          }));
        await testInfo.attach("actual-capture-precondition", {
          body: JSON.stringify({ scenario, captures: captureEvidence }),
          contentType: "application/json",
        });
      }
      // Stop the closing room's SPA/lobby from rotating CSRF in parallel with
      // test cleanup. This does not disable authentication on any endpoint.
      try {
        await stopFixturePageActivity(contexts);
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (host && roomId) {
        try {
          await closeFixtureRoom(host.context(), roomId);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      for (const context of contexts.reverse()) {
        try {
          await logoutFixtureSession(context);
        } catch (error) {
          cleanupFailures.push(error);
        }
        try {
          await context.close();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (cleanupFailures.length)
        await testInfo.attach("negotiation-cleanup-failures", {
          body: JSON.stringify(
            cleanupFailures.map((error) =>
              error instanceof Error ? error.message : String(error),
            ),
          ),
          contentType: "application/json",
        });
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        cleanupFailures,
        "Negotiation gate cleanup failed",
      );
  });
}
