import { RoomServiceClient } from "livekit-server-sdk";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { installStableMicrophones } from "./capture-fixture.js";

const rtc = new RoomServiceClient(
  "http://127.0.0.1:17880",
  "local-voice-gate-key",
  "local-voice-gate-secret-not-production-32-bytes",
);
const mediaId = "d8b0483b-b1d2-49d4-8f3b-f16341734bd4";
interface CaptureObservation {
  calls: number;
  tracks: MediaStreamTrack[];
}
type InstrumentedWindow = Window & {
  voiceCaptureObservation: CaptureObservation;
  voicePeerObservations: RTCPeerConnection[];
  voiceContextObservations: AudioContext[];
  voiceAnalyserObservations: AnalyserNode[];
  voiceFixtureContextObservations: AudioContext[];
  voiceNativeAudioContext: typeof AudioContext;
};
interface SustainedPlaybackSample {
  renderedFrames: number;
  lastMediaTime: number;
  maximumFrameGapMs: number;
  remoteNonzeroTicks: Record<string, number>;
  remotePeaks: Record<string, number>;
}
type SustainedPlaybackWindow = Window & {
  voiceSustainedProbe?: {
    sample: SustainedPlaybackSample;
    stop(): void;
  };
};

test("actual browser DSP preserves gain, stereo separation and soft overload protection", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const moduleUrl = "/__test/voice-audio-gate.js";
    const harness = (await import(moduleUrl)) as {
      renderGain(input: {
        direction: string;
        volume: number;
        master?: number;
        channels?: number;
        voices?: number;
        amplitude?: number;
      }): Promise<{
        channels: Array<{ rms: number; peak: number; frequency: number }>;
      }>;
    };
    const receive = [];
    for (const volume of [0, 50, 100, 500])
      receive.push(await harness.renderGain({ direction: "receive", volume }));
    const send = [];
    for (const volume of [0, 100, 200])
      send.push(await harness.renderGain({ direction: "send", volume }));
    return {
      receive,
      send,
      stereo: await harness.renderGain({
        direction: "send",
        volume: 100,
        channels: 2,
      }),
      combined: await harness.renderGain({
        direction: "receive",
        volume: 200,
        master: 50,
      }),
      overload: await harness.renderGain({
        direction: "receive",
        volume: 500,
        voices: 4,
        amplitude: 0.2,
      }),
    };
  });
  const rms = (value: { channels: Array<{ rms: number }> } | undefined) =>
    value?.channels[0]?.rms ?? Number.NaN;
  expect(rms(result.receive[0])).toBe(0);
  expect(rms(result.send[0])).toBe(0);
  expect(rms(result.receive[1]) / rms(result.receive[2])).toBeCloseTo(0.5, 2);
  expect(rms(result.receive[3]) / rms(result.receive[2])).toBeCloseTo(5, 2);
  expect(rms(result.send[2]) / rms(result.send[1])).toBeCloseTo(2, 2);
  expect(rms(result.combined) / rms(result.receive[2])).toBeCloseTo(1, 2);
  expect(result.stereo.channels[0]?.frequency).toBeGreaterThan(325);
  expect(result.stereo.channels[0]?.frequency).toBeLessThan(335);
  expect(result.stereo.channels[1]?.frequency).toBeGreaterThan(545);
  expect(result.stereo.channels[1]?.frequency).toBeLessThan(555);
  expect(result.overload.channels[0]?.peak).toBeLessThan(2);
});

async function client(
  browser: Browser,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(viewport ? { viewport } : {}),
  });
  await context.addInitScript(() => {
    const state: CaptureObservation = { calls: 0, tracks: [] };
    (window as unknown as InstrumentedWindow).voiceCaptureObservation = state;
    const peers: RTCPeerConnection[] = [];
    (window as unknown as InstrumentedWindow).voicePeerObservations = peers;
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        peers.push(this);
      }
    };
    const contexts: AudioContext[] = [];
    const analysers: AnalyserNode[] = [];
    (window as unknown as InstrumentedWindow).voiceAnalyserObservations =
      analysers;
    (window as unknown as InstrumentedWindow).voiceContextObservations =
      contexts;
    const NativeContext = window.AudioContext;
    (window as unknown as InstrumentedWindow).voiceNativeAudioContext =
      NativeContext;
    (window as unknown as InstrumentedWindow).voiceFixtureContextObservations =
      [];
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
      override createAnalyser() {
        const analyser = super.createAnalyser();
        analysers.push(analyser);
        return analyser;
      }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.calls += 1;
      const stream = await capture(constraints);
      for (const track of stream.getTracks())
        if (!state.tracks.includes(track)) state.tracks.push(track);
      return stream;
    };
  });
  const page = await context.newPage();
  return { context, page };
}

async function login(page: Page, username: string) {
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

async function createRoom(page: Page): Promise<string> {
  await login(page, "Host");
  await expect(
    page.getByRole("heading", { name: "放映控制", exact: true }),
  ).toBeVisible();
  const close = page.getByRole("button", { name: "强制关闭房间" });
  const create = page.getByRole("button", { name: /开启放映室/ });
  await expect(create.or(close)).toBeVisible();
  if (await close.isVisible()) {
    page.once("dialog", (dialog) => dialog.accept());
    await close.click();
    await expect(create).toBeVisible();
  }
  await create.click();
  await page.getByRole("button", { name: "进入主持房间" }).click();
  await expect(page).toHaveURL(/\/room\//);
  const roomId = new URL(page.url()).pathname.split("/").at(-1);
  if (!roomId) throw new Error("Missing test room");
  await expect(
    page
      .locator(".voice-panel__desktop")
      .getByText("已加入语音频道", { exact: true }),
  ).toBeVisible();
  return roomId;
}

async function closeRoom(page: Page) {
  const close = page.getByRole("button", { name: "关闭房间", exact: true });
  if (await close.isVisible()) {
    page.once("dialog", (dialog) => dialog.accept());
    await close.click();
    await expect(page).toHaveURL(/\/admin$/);
  }
}

async function disposeClient(context: BrowserContext) {
  // Closing a tab does not log out its account or remove its lobby queue entry.
  // Revoke these isolated test sessions so the next test cannot inherit seats.
  try {
    const session = await context.request.get("/api/v1/auth/session");
    if (session.ok()) {
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const response = await context.request.post("/api/v1/auth/logout", {
        headers: {
          origin: "https://127.0.0.1:18443",
          "x-csrf-token": csrfToken,
        },
      });
      expect(response.status()).toBe(204);
    }
  } finally {
    await context.close();
  }
}

async function captureCount(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as InstrumentedWindow).voiceCaptureObservation.calls,
  );
}
async function liveCaptureCount(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as InstrumentedWindow
      ).voiceCaptureObservation.tracks.filter(
        (track) => track.readyState === "live",
      ).length,
  );
}

async function audioEvidence(page: Page) {
  return page.evaluate(async () => {
    let receivedBytes = 0;
    let sentBytes = 0;
    let audioReceivers = 0;
    let cap96k = false;
    let incomingEnergy: number | null = null;
    let sourceEnergy = 0;
    for (const peer of (window as unknown as InstrumentedWindow)
      .voicePeerObservations) {
      if (peer.connectionState === "closed") continue;
      for (const sender of peer.getSenders()) {
        if (sender.track?.kind === "audio") {
          cap96k ||= sender
            .getParameters()
            .encodings.some((encoding) => encoding.maxBitrate === 96_000);
        }
      }
      // Return only the encoding limit, never raw SDP, ICE or credentials.
      cap96k ||= /maxaveragebitrate=96000(?:;|\r?\n)/.test(
        peer.localDescription?.sdp ?? "",
      );
      const stats = await peer.getStats();
      stats.forEach((raw) => {
        const row = raw as {
          kind?: string;
          mediaType?: string;
          type: string;
          bytesReceived?: number;
          bytesSent?: number;
          totalAudioEnergy?: number;
        };
        if (row.kind !== "audio" && row.mediaType !== "audio") return;
        if (row.type === "inbound-rtp") {
          receivedBytes += Number(row.bytesReceived ?? 0);
          // LiveKit preallocates receive transceivers; only count real RTP media.
          if ((row.bytesReceived ?? 0) > 0) audioReceivers += 1;
        }
        if (row.type === "outbound-rtp")
          sentBytes += Number(row.bytesSent ?? 0);
        if (
          row.type === "inbound-rtp" &&
          typeof row.totalAudioEnergy === "number"
        )
          incomingEnergy = (incomingEnergy ?? 0) + row.totalAudioEnergy;
        if (row.type === "media-source")
          sourceEnergy += row.totalAudioEnergy ?? 0;
      });
    }
    return {
      receivedBytes,
      sentBytes,
      audioReceivers,
      cap96k,
      incomingEnergy,
      sourceEnergy,
      receivers: (window as unknown as InstrumentedWindow).voicePeerObservations
        .flatMap((peer) => peer.getReceivers())
        .filter((receiver) => receiver.track.kind === "audio")
        .map((receiver) => ({
          ready: receiver.track.readyState,
          enabled: receiver.track.enabled,
          muted: receiver.track.muted,
        })),
      captures: (
        window as unknown as InstrumentedWindow
      ).voiceCaptureObservation.tracks.map((track) => ({
        ready: track.readyState,
        enabled: track.enabled,
        muted: track.muted,
        channels: track.getSettings().channelCount ?? null,
      })),
      contexts: (
        window as unknown as InstrumentedWindow
      ).voiceContextObservations.map((context) => ({
        state: context.state,
        time: context.currentTime,
      })),
      levels: [
        ...document.querySelectorAll<HTMLMeterElement>(
          ".voice-panel__desktop meter",
        ),
      ].map((meter) => meter.value),
      analyserRms: (
        window as unknown as InstrumentedWindow
      ).voiceAnalyserObservations.map((analyser) => {
        const values = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(values);
        return Math.sqrt(
          values.reduce((total, value) => total + value * value, 0) /
            values.length,
        );
      }),
      activePeers: (
        window as unknown as InstrumentedWindow
      ).voicePeerObservations.filter(
        (peer) => peer.connectionState !== "closed",
      ).length,
      activeContexts: (
        window as unknown as InstrumentedWindow
      ).voiceContextObservations.filter((context) => context.state !== "closed")
        .length,
      activeFixtureContexts: (
        window as unknown as InstrumentedWindow
      ).voiceFixtureContextObservations.filter(
        (context) => context.state !== "closed",
      ).length,
      bridges: [
        ...document.querySelectorAll<HTMLAudioElement>(
          'audio[data-simplewatch-voice="playout-bridge"]',
        ),
      ].map((audio) => ({
        muted: audio.muted,
        volume: audio.volume,
        paused: audio.paused,
        readyState: audio.readyState,
        currentTime: audio.currentTime,
        error: audio.error?.code ?? null,
        trackCount:
          audio.srcObject instanceof MediaStream
            ? audio.srcObject.getAudioTracks().length
            : 0,
        matchesReceiver:
          audio.srcObject instanceof MediaStream &&
          audio.srcObject
            .getAudioTracks()
            .every((track) =>
              (
                window as unknown as InstrumentedWindow
              ).voicePeerObservations.some((peer) =>
                peer
                  .getReceivers()
                  .some((receiver) => receiver.track === track),
              ),
            ),
      })),
    };
  });
}

async function microphoneDeviceEvidence(page: Page) {
  return page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const concrete = (id: string | undefined) =>
      Boolean(id && id !== "default" && id !== "communications");
    const idType = (id: string | undefined) =>
      !id ? "missing" : concrete(id) ? "concrete" : id;
    return {
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      captureCalls: (window as unknown as InstrumentedWindow)
        .voiceCaptureObservation.calls,
      selectedInputAvailable: devices.some(
        (device) =>
          device.kind === "audioinput" &&
          device.deviceId ===
            document.querySelector<HTMLSelectElement>(
              '.voice-panel__desktop select[id$="-input"]',
            )?.value,
      ),
      tracks: (
        window as unknown as InstrumentedWindow
      ).voiceCaptureObservation.tracks.map((track) => {
        const settings = track.getSettings();
        return {
          ready: track.readyState,
          enabled: track.enabled,
          muted: track.muted,
          idType: idType(settings.deviceId),
          hasGroup: Boolean(settings.groupId),
          concreteGroupMatchCount: settings.groupId
            ? devices.filter(
                (device) =>
                  device.kind === "audioinput" &&
                  device.groupId === settings.groupId &&
                  concrete(device.deviceId),
              ).length
            : 0,
        };
      }),
      inputs: devices
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({
          idType: idType(device.deviceId),
          hasGroup: Boolean(device.groupId),
        })),
    };
  });
}

async function enableVoiceOutput(page: Page) {
  const button = page
    .locator(".voice-panel__desktop")
    .getByRole("button", { name: /^(启用|恢复)语音声音$/ });
  if (await button.isVisible()) await button.click();
}

async function expectSilentDecoderBridges(page: Page, count: number) {
  const elements = page.locator("audio");
  await expect(elements).toHaveCount(count);
  expect(
    await elements.evaluateAll((values) =>
      values.every((value) => {
        const audio = value as HTMLAudioElement;
        return (
          audio.dataset.simplewatchVoice === "playout-bridge" &&
          audio.muted &&
          audio.defaultMuted &&
          audio.volume === 0 &&
          audio.hidden &&
          audio.srcObject instanceof MediaStream
        );
      }),
    ),
  ).toBe(true);
}

async function observeSustainedPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as SustainedPlaybackWindow;
    target.voiceSustainedProbe?.stop();
    const video = document.querySelector("video");
    if (!video || !video.requestVideoFrameCallback)
      throw new Error("Real rendered-frame observation unavailable");
    const sample: SustainedPlaybackSample = {
      renderedFrames: 0,
      lastMediaTime: 0,
      maximumFrameGapMs: 0,
      remoteNonzeroTicks: {},
      remotePeaks: {},
    };
    let lastFrameAt: number | null = null;
    let frameHandle = 0;
    let stopped = false;
    const onFrame: VideoFrameRequestCallback = (now, metadata) => {
      if (stopped) return;
      sample.renderedFrames += 1;
      sample.lastMediaTime = metadata.mediaTime;
      if (lastFrameAt !== null)
        sample.maximumFrameGapMs = Math.max(
          sample.maximumFrameGapMs,
          now - lastFrameAt,
        );
      lastFrameAt = now;
      frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    frameHandle = video.requestVideoFrameCallback(onFrame);
    const timer = window.setInterval(() => {
      for (const meter of document.querySelectorAll<HTMLMeterElement>(
        '.voice-panel__desktop meter[aria-label$=" 收听电平"]',
      )) {
        const name = meter.getAttribute("aria-label")!;
        sample.remoteNonzeroTicks[name] ??= 0;
        sample.remotePeaks[name] ??= 0;
        if (meter.value > 0) sample.remoteNonzeroTicks[name] += 1;
        sample.remotePeaks[name] = Math.max(
          sample.remotePeaks[name],
          meter.value,
        );
      }
    }, 200);
    target.voiceSustainedProbe = {
      sample,
      stop() {
        stopped = true;
        window.clearInterval(timer);
        video.cancelVideoFrameCallback(frameHandle);
        delete target.voiceSustainedProbe;
      },
    };
  });
}

async function sustainedPlaybackSample(
  page: Page,
): Promise<SustainedPlaybackSample> {
  return page.evaluate(() => {
    const probe = (window as SustainedPlaybackWindow).voiceSustainedProbe;
    if (!probe) throw new Error("Sustained playback probe is missing");
    return probe.sample;
  });
}

async function stopSustainedPlayback(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as SustainedPlaybackWindow).voiceSustainedProbe?.stop(),
  );
}

async function slider(
  page: Page,
  label: string,
  value: number,
  maximum: number,
) {
  const control = page
    .locator(".voice-panel__desktop")
    .getByRole("slider", { name: label, exact: true });
  await control.focus();
  await control.press(value > maximum / 2 ? "End" : "Home");
  const difference = value > maximum / 2 ? maximum - value : value;
  for (let index = 0; index < difference; index += 1)
    await control.press(value > maximum / 2 ? "ArrowLeft" : "ArrowRight");
  await expect(control).toHaveValue(String(value));
}

test("five authenticated seats auto-join receive-only, then publish exactly one microphone and cleanly leave", async ({
  browser,
}, testInfo) => {
  const clients: Array<{ context: BrowserContext; page: Page }> = [];
  try {
    const host = await client(browser);
    clients.push(host);
    const roomId = await createRoom(host.page);
    for (const name of ["Simple", "FJ233", "Conflict", "Fpliy"]) {
      const viewer = await client(browser);
      clients.push(viewer);
      await login(viewer.page, name);
      await expect(
        viewer.page
          .locator(".voice-panel__desktop")
          .getByText("已加入语音频道", { exact: true }),
      ).toBeVisible();
    }
    await expect
      .poll(async () => (await rtc.listParticipants(`voice:${roomId}`)).length)
      .toBe(5);
    for (const { page } of clients) {
      expect(await captureCount(page)).toBe(0);
      await expect(
        page
          .locator(".voice-panel__desktop")
          .getByRole("slider", { name: "语音总音量", exact: true }),
      ).toHaveValue("50");
    }
    const participants = await rtc.listParticipants(`voice:${roomId}`);
    expect(
      participants.every(
        (participant) =>
          participant.identity.startsWith("v2:") &&
          participant.tracks.length === 0,
      ),
    ).toBe(true);
    await host.page
      .getByRole("button", { name: "打开麦克风", exact: true })
      .click();
    await expect(
      host.page
        .locator(".voice-panel__desktop")
        .getByText("麦克风开启 · 正在发送", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        (await rtc.listParticipants(`voice:${roomId}`)).reduce(
          (sum, p) => sum + p.tracks.length,
          0,
        ),
      )
      .toBe(1);
    expect(await captureCount(host.page)).toBe(1);
    for (const { page } of clients.slice(1)) {
      expect(await captureCount(page)).toBe(0);
      await enableVoiceOutput(page);
      await expect
        .poll(async () => (await audioEvidence(page)).receivedBytes)
        .toBeGreaterThan(0);
      await expect
        .poll(async () =>
          Number(
            await page
              .locator(".voice-panel__desktop")
              .getByLabel("Host 收听电平", { exact: true })
              .getAttribute("value"),
          ),
        )
        .toBeGreaterThan(0);
      await expectSilentDecoderBridges(page, 1);
    }
    await expect
      .poll(async () => (await audioEvidence(host.page)).cap96k)
      .toBe(true);
    await testInfo.attach("actual-rtc-audio-summary", {
      body: JSON.stringify(
        await Promise.all(clients.map(({ page }) => audioEvidence(page))),
      ),
      contentType: "application/json",
    });
    await host.page.screenshot({
      path: testInfo.outputPath("voice-desktop.png"),
      fullPage: true,
    });
    await host.page
      .getByRole("button", { name: "关闭麦克风", exact: true })
      .click();
    await expect.poll(() => liveCaptureCount(host.page)).toBe(0);
    await expect
      .poll(async () =>
        (await rtc.listParticipants(`voice:${roomId}`)).reduce(
          (sum, p) => sum + p.tracks.length,
          0,
        ),
      )
      .toBe(0);
    for (const { page } of clients) await expectSilentDecoderBridges(page, 0);
    await closeRoom(host.page);
    await expect
      .poll(async () =>
        (await rtc.listRooms())
          .filter((room) => room.name === `voice:${roomId}`)
          .reduce((sum, room) => sum + room.numParticipants, 0),
      )
      .toBe(0);
  } finally {
    await testInfo.attach("five-seat-final-audio-observations", {
      body: JSON.stringify(
        await Promise.all(
          clients.map(async ({ page }) => {
            try {
              return await audioEvidence(page);
            } catch {
              return null;
            }
          }),
        ),
      ),
      contentType: "application/json",
    });
    for (const { context } of [...clients].reverse())
      await disposeClient(context);
  }
});

test("volume restores for stable fixture devices after refresh, same-browser tab handoff is explicit and mobile mixer is usable", async ({
  browser,
}, testInfo) => {
  const host = await client(browser);
  const viewer = await client(browser);
  await installStableMicrophones(viewer.context);
  try {
    await createRoom(host.page);
    await login(viewer.page, "Simple");
    await expect(
      viewer.page
        .locator(".voice-panel__desktop")
        .getByText("已加入语音频道", { exact: true }),
    ).toBeVisible();
    await slider(viewer.page, "语音总音量", 0, 100);
    await slider(viewer.page, "Host 收听音量", 500, 500);
    const microphoneGain = viewer.page
      .locator(".voice-panel__desktop")
      .getByRole("slider", { name: "我的麦克风发送增益", exact: true });
    await expect(microphoneGain).toBeDisabled();
    await expect(microphoneGain).toHaveValue("100");
    await testInfo.attach("microphone-device-before-first-open", {
      body: JSON.stringify(await microphoneDeviceEvidence(viewer.page)),
      contentType: "application/json",
    });
    await viewer.page
      .getByRole("button", { name: "打开麦克风", exact: true })
      .click();
    await expect(
      viewer.page.getByRole("button", { name: "关闭麦克风", exact: true }),
    ).toBeVisible();
    await testInfo.attach("microphone-device-after-open", {
      body: JSON.stringify(await microphoneDeviceEvidence(viewer.page)),
      contentType: "application/json",
    });
    // Chromium's default fake device has a synthetic group with no matching
    // concrete microphone. Unknown must stay at 100%; select an actual fake
    // input to test hardware-keyed persistence without treating an alias as ID.
    await expect(microphoneGain).toBeDisabled();
    await expect(microphoneGain).toHaveValue("100");
    await viewer.page
      .getByRole("button", { name: "关闭麦克风", exact: true })
      .click();
    await expect.poll(() => liveCaptureCount(viewer.page)).toBe(0);
    const concreteDevice = await viewer.page.evaluate(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.find(
        (device) =>
          device.kind === "audioinput" &&
          device.deviceId &&
          !["default", "communications"].includes(device.deviceId),
      )?.deviceId;
    });
    expect(concreteDevice).toBeTruthy();
    await viewer.page
      .locator(".voice-panel__desktop")
      .getByLabel("输入设备", { exact: true })
      .selectOption(concreteDevice!);
    await viewer.page
      .getByRole("button", { name: "打开麦克风", exact: true })
      .click();
    await expect(microphoneGain).toBeEnabled();
    await slider(viewer.page, "我的麦克风发送增益", 175, 200);
    await viewer.page
      .getByRole("button", { name: "关闭麦克风", exact: true })
      .click();
    await expect.poll(() => liveCaptureCount(viewer.page)).toBe(0);
    await expect(microphoneGain).toHaveValue("175");
    await viewer.page.reload();
    await expect(
      viewer.page
        .locator(".voice-panel__desktop")
        .getByText("已加入语音频道", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.page
        .locator(".voice-panel__desktop")
        .getByRole("slider", { name: "语音总音量", exact: true }),
    ).toHaveValue("0");
    await expect(
      viewer.page
        .locator(".voice-panel__desktop")
        .getByRole("slider", { name: "Host 收听音量", exact: true }),
    ).toHaveValue("500");
    expect(await captureCount(viewer.page)).toBe(0);
    const restoredDevices = await microphoneDeviceEvidence(viewer.page);
    expect(restoredDevices.selectedInputAvailable).toBe(true);
    await testInfo.attach("microphone-device-after-refresh", {
      body: JSON.stringify(restoredDevices),
      contentType: "application/json",
    });
    // A reload cannot know which hardware the default route will choose. Do not
    // inherit its previous gain until a deliberate capture identifies it again.
    await expect(microphoneGain).toBeDisabled();
    await expect(microphoneGain).toHaveValue("100");
    await viewer.page
      .getByRole("button", { name: "打开麦克风", exact: true })
      .click();
    await expect(microphoneGain).toBeEnabled();
    await expect(microphoneGain).toHaveValue("175");
    await viewer.page
      .getByRole("button", { name: "关闭麦克风", exact: true })
      .click();
    await expect.poll(() => liveCaptureCount(viewer.page)).toBe(0);
    const second = await viewer.context.newPage();
    await second.goto(viewer.page.url());
    await expect(
      second
        .locator(".voice-panel__desktop")
        .getByText("语音由另一标签页使用", { exact: true }),
    ).toBeVisible();
    await second
      .getByRole("button", { name: "在此标签页使用语音", exact: true })
      .click();
    await expect(
      second
        .locator(".voice-panel__desktop")
        .getByText("已加入语音频道", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.page
        .locator(".voice-panel__desktop")
        .getByText("语音由另一标签页使用", { exact: true }),
    ).toBeVisible();
    await second.setViewportSize({ width: 390, height: 844 });
    await second.getByRole("button", { name: /同场声音/ }).click();
    const drawer = second.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("slider", { name: "Host 收听音量", exact: true }),
    ).toHaveValue("500");
    expect(
      await second.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await second.screenshot({
      path: testInfo.outputPath("voice-mobile.png"),
      fullPage: true,
    });
    await second.getByRole("button", { name: "收起语音设置" }).click();
    await expect(drawer).not.toBeVisible();
    await closeRoom(host.page);
  } finally {
    await testInfo.attach("microphone-device-before-cleanup", {
      body: JSON.stringify(await microphoneDeviceEvidence(viewer.page)),
      contentType: "application/json",
    });
    await disposeClient(viewer.context);
    await disposeClient(host.context);
  }
});

test("program playback and Host seek remain stable while a known-tone voice channel opens and closes", async ({
  browser,
}, testInfo) => {
  const host = await client(browser);
  const viewer = await client(browser);
  let currentCycle = 0;
  await installStableMicrophones(host.context, true);
  try {
    await createRoom(host.page);
    await host.page
      .getByLabel("选择点播影片")
      .selectOption({ label: "sync-player-fixture.mp4" });
    await login(viewer.page, "Simple");
    for (const { page } of [host, viewer]) {
      await expect(page.locator("video")).toHaveAttribute(
        "src",
        `/api/v1/media/${mediaId}/content`,
      );
      await page
        .getByRole("button", { name: "启用节目声音", exact: true })
        .click();
    }
    await host.page
      .getByRole("button", { name: "▶ 播放", exact: true })
      .click();
    await expect
      .poll(() =>
        viewer.page
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeGreaterThan(1);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      currentCycle = cycle;
      await host.page
        .getByRole("button", { name: "打开麦克风", exact: true })
        .click();
      await expect(
        host.page.getByRole("button", { name: "关闭麦克风", exact: true }),
      ).toBeVisible();
      await enableVoiceOutput(viewer.page);
      await expectSilentDecoderBridges(viewer.page, 1);
      await expect
        .poll(async () =>
          Number(
            await viewer.page
              .locator(".voice-panel__desktop")
              .getByLabel("Host 收听电平", { exact: true })
              .getAttribute("value"),
          ),
        )
        .toBeGreaterThan(0);
      await host.page
        .getByRole("button", { name: "关闭麦克风", exact: true })
        .click();
      await expect.poll(() => liveCaptureCount(host.page)).toBe(0);
      await expect
        .poll(
          async () => (await audioEvidence(host.page)).activeFixtureContexts,
        )
        .toBe(0);
      await expectSilentDecoderBridges(viewer.page, 0);
      // The SDK briefly creates silence-detection contexts and closes them.
      // Assert the settled owner count rather than sampling that 200 ms probe.
      await expect
        .poll(async () => (await audioEvidence(host.page)).activeContexts)
        .toBe(1);
    }
    expect(
      await viewer.page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => ({
          paused: video.paused,
          rate: video.playbackRate,
          muted: video.muted,
          error: video.error?.code ?? null,
        })),
    ).toEqual({ paused: false, rate: 1, muted: false, error: null });
    const progress = host.page.getByRole("slider", { name: "播放进度" });
    await progress.focus();
    await progress.press("Home");
    for (let index = 0; index < 20; index += 1)
      await progress.press("ArrowRight");
    await progress.press("Tab");
    await expect
      .poll(async () => {
        const a = await host.page
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.currentTime);
        const b = await viewer.page
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.currentTime);
        return Math.abs(a - b);
      })
      .toBeLessThan(0.5);
    await closeRoom(host.page);
    for (const { page } of [host, viewer]) {
      await expect
        .poll(async () => (await audioEvidence(page)).activeContexts)
        .toBe(0);
      await expect
        .poll(async () => (await audioEvidence(page)).activePeers)
        .toBe(0);
      await expect
        .poll(async () => (await audioEvidence(page)).activeFixtureContexts)
        .toBe(0);
      await expectSilentDecoderBridges(page, 0);
    }
  } finally {
    await testInfo.attach("microphone-cycle-before-cleanup", {
      body: JSON.stringify({
        cycle: currentCycle,
        host: await audioEvidence(host.page),
        viewer: await audioEvidence(viewer.page),
        devices: await microphoneDeviceEvidence(host.page),
      }),
      contentType: "application/json",
    });
    await disposeClient(viewer.context);
    await disposeClient(host.context);
  }
});

test("real stereo capture survives the production processor, Opus SFU and remote receiver", async ({
  browser,
}, testInfo) => {
  const host = await client(browser);
  const viewer = await client(browser);
  try {
    await createRoom(host.page);
    await login(viewer.page, "Simple");
    await expect(
      viewer.page
        .locator(".voice-panel__desktop")
        .getByText("已加入语音频道", { exact: true }),
    ).toBeVisible();
    const panel = host.page.locator(".voice-panel__desktop");
    await panel.getByText("声音与设备选项", { exact: true }).click();
    await panel
      .getByLabel("麦克风处理模式", { exact: true })
      .selectOption("original");
    // Replace only this test's fake capture with independent left/right test tones.
    // Neither microphone hardware nor a speaker is used to generate the fixture.
    await host.page.evaluate(() => {
      const nativeFakeCapture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const fake = await nativeFakeCapture(constraints);
        fake.getTracks().forEach((track) => track.stop());
        const fixture = window as unknown as InstrumentedWindow;
        const context = new fixture.voiceNativeAudioContext({
          sampleRate: 48_000,
        });
        fixture.voiceFixtureContextObservations.push(context);
        await context.resume();
        const merger = context.createChannelMerger(2);
        const destination = context.createMediaStreamDestination();
        destination.channelCount = 2;
        destination.channelCountMode = "explicit";
        merger.connect(destination);
        const tones = [330, 550].map((frequency, channel) => {
          const oscillator = context.createOscillator();
          oscillator.frequency.value = frequency;
          const gain = context.createGain();
          gain.gain.value = 0.03;
          oscillator.connect(gain).connect(merger, 0, channel);
          oscillator.start();
          return oscillator;
        });
        const track = destination.stream.getAudioTracks()[0]!;
        const stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => {
          if (stopped) return;
          stopped = true;
          stop();
          tones.forEach((tone) => tone.stop());
          void context.close();
        };
        (
          window as unknown as InstrumentedWindow
        ).voiceCaptureObservation.tracks.push(track);
        return destination.stream;
      };
    });
    await panel
      .getByRole("button", { name: "打开麦克风", exact: true })
      .click();
    await expect(panel.getByText(/当前采集：双声道/)).toBeVisible();
    await enableVoiceOutput(viewer.page);
    await expect
      .poll(async () => (await audioEvidence(viewer.page)).receivedBytes)
      .toBeGreaterThan(1_000);
    await testInfo.attach("stereo-published-track-state", {
      body: JSON.stringify(
        (await rtc.listRooms()).length
          ? (
              await rtc.listParticipants(
                `voice:${new URL(host.page.url()).pathname.split("/").at(-1)}`,
              )
            ).map((participant) => ({
              tracks: participant.tracks.map((track) => ({
                muted: track.muted,
                type: track.type,
                stereo: track.stereo,
              })),
            }))
          : [],
      ),
      contentType: "application/json",
    });
    await expectSilentDecoderBridges(viewer.page, 1);
    const result = await viewer.page.evaluate(async () => {
      const candidates = (
        window as unknown as InstrumentedWindow
      ).voicePeerObservations
        .flatMap((peer) => peer.getReceivers())
        .filter(
          (value) =>
            value.track.kind === "audio" && value.track.readyState === "live",
        );
      let receiver: RTCRtpReceiver | undefined;
      for (const candidate of candidates) {
        const stats = await candidate.getStats();
        let hasAudio = false;
        stats.forEach((raw) => {
          const row = raw as { type: string; bytesReceived?: number };
          if (row.type === "inbound-rtp" && (row.bytesReceived ?? 0) > 0)
            hasAudio = true;
        });
        if (hasAudio) {
          receiver = candidate;
          break;
        }
      }
      if (!receiver) throw new Error("No real audio receiver");
      const context = new AudioContext({ sampleRate: 48_000 });
      await context.resume();
      const source = context.createMediaStreamSource(
        new MediaStream([receiver.track]),
      );
      const splitter = context.createChannelSplitter(2);
      source.connect(splitter);
      const meters = [0, 1].map((channel) => {
        const analyser = context.createAnalyser();
        analyser.fftSize = 16384;
        analyser.smoothingTimeConstant = 0;
        splitter.connect(analyser, channel);
        return analyser;
      });
      const frequencies: number[][] = [[], []];
      const levels: number[][] = [[], []];
      const separations: number[][] = [[], []];
      try {
        // Fill a whole FFT window after starting the independent observation
        // graph. The production graph must already be decoding on its own.
        await new Promise((resolve) => setTimeout(resolve, 400));
        for (let iteration = 0; iteration < 20; iteration += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          for (const [channel, meter] of meters.entries()) {
            const samples = new Float32Array(meter.fftSize);
            meter.getFloatTimeDomainData(samples);
            let sum = 0;
            for (const sample of samples) sum += sample ** 2;
            const spectrum = new Float32Array(meter.frequencyBinCount);
            meter.getFloatFrequencyData(spectrum);
            const binHz = context.sampleRate / meter.fftSize;
            let dominantBin = Math.ceil(200 / binHz);
            for (
              let bin = dominantBin;
              bin <= Math.floor(700 / binHz);
              bin += 1
            )
              if (spectrum[bin]! > spectrum[dominantBin]!) dominantBin = bin;
            const tonePeak = (frequency: number) => {
              const center = Math.round(frequency / binHz);
              return Math.max(...spectrum.slice(center - 2, center + 3));
            };
            frequencies[channel]!.push(dominantBin * binHz);
            separations[channel]!.push(
              tonePeak(channel === 0 ? 330 : 550) -
                tonePeak(channel === 0 ? 550 : 330),
            );
            levels[channel]!.push(Math.sqrt(sum / samples.length));
          }
        }
        const average = (values: number[]) =>
          values.reduce((total, value) => total + value, 0) / values.length;
        return {
          frequencies: frequencies.map(average),
          rms: levels.map(average),
          separationDb: separations.map(average),
        };
      } finally {
        source.disconnect();
        splitter.disconnect();
        meters.forEach((meter) => meter.disconnect());
        await context.close();
      }
    });
    await testInfo.attach("real-stereo-rtc-spectrum", {
      body: JSON.stringify({
        result,
        sender: await audioEvidence(host.page),
        receiver: await audioEvidence(viewer.page),
      }),
      contentType: "application/json",
    });
    expect(result.frequencies[0]).toBeGreaterThan(324);
    expect(result.frequencies[0]).toBeLessThan(336);
    expect(result.frequencies[1]).toBeGreaterThan(544);
    expect(result.frequencies[1]).toBeLessThan(556);
    expect(result.rms.every((value) => value > 0.01)).toBe(true);
    expect(result.separationDb.every((value) => value > 10)).toBe(true);
    expect((await audioEvidence(host.page)).cap96k).toBe(true);
    await closeRoom(host.page);
  } finally {
    await disposeClient(viewer.context);
    await disposeClient(host.context);
  }
});

test("optional sustained five-seat voice and VOD capacity gate", async ({
  browser,
}, testInfo) => {
  const seconds = Number(process.env.VOICE_SOAK_SECONDS ?? 0);
  test.skip(
    !Number.isFinite(seconds) || seconds < 60,
    "Set VOICE_SOAK_SECONDS=1800 for the explicit 30-minute local soak",
  );
  test.setTimeout(seconds * 1_000 + 180_000);
  const clients: Array<{ context: BrowserContext; page: Page }> = [];
  const observations: Array<{
    elapsedSec: number;
    clients: Awaited<ReturnType<typeof audioEvidence>>[];
    playback: SustainedPlaybackSample[];
  }> = [];
  try {
    const host = await client(browser);
    clients.push(host);
    const roomId = await createRoom(host.page);
    await host.page
      .getByLabel("选择点播影片")
      .selectOption({ label: "sync-player-fixture.mp4" });
    for (const username of ["Simple", "FJ233", "Conflict", "Fpliy"]) {
      const viewer = await client(browser);
      clients.push(viewer);
      await login(viewer.page, username);
      await expect(
        viewer.page
          .locator(".voice-panel__desktop")
          .getByText("已加入语音频道", { exact: true }),
      ).toBeVisible();
    }
    for (const { page } of clients) {
      await page
        .getByRole("button", { name: "启用节目声音", exact: true })
        .click();
      await page
        .getByRole("button", { name: "打开麦克风", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "关闭麦克风", exact: true }),
      ).toBeVisible();
    }
    await expect
      .poll(async () =>
        (await rtc.listParticipants(`voice:${roomId}`)).reduce(
          (count, participant) => count + participant.tracks.length,
          0,
        ),
      )
      .toBe(5);
    for (const { page } of clients) {
      await enableVoiceOutput(page);
      await expectSilentDecoderBridges(page, 4);
      await observeSustainedPlayback(page);
    }
    await host.page
      .getByRole("button", { name: "▶ 播放", exact: true })
      .click();
    const startedAt = Date.now();
    let previous: Awaited<ReturnType<typeof audioEvidence>>[] | undefined;
    let previousPlayback: SustainedPlaybackSample[] | undefined;
    while (Date.now() - startedAt < seconds * 1_000) {
      await host.page.waitForTimeout(10_000);
      const current = await Promise.all(
        clients.map(({ page }) => audioEvidence(page)),
      );
      const playback = await Promise.all(
        clients.map(({ page }) => sustainedPlaybackSample(page)),
      );
      for (const [index, observation] of current.entries()) {
        expect(observation.audioReceivers).toBe(4);
        expect(observation.activeContexts).toBe(1);
        expect(observation.cap96k).toBe(true);
        await expectSilentDecoderBridges(clients[index]!.page, 4);
        expect(await liveCaptureCount(clients[index]!.page)).toBe(1);
        const rendered = playback[index]!;
        expect(
          rendered.renderedFrames -
            (previousPlayback?.[index]?.renderedFrames ?? 0),
        ).toBeGreaterThan(30);
        expect(rendered.maximumFrameGapMs).toBeLessThan(2_000);
        expect(Object.keys(rendered.remoteNonzeroTicks)).toHaveLength(4);
        for (const [name, ticks] of Object.entries(
          rendered.remoteNonzeroTicks,
        )) {
          expect(ticks).toBeGreaterThan(
            previousPlayback?.[index]?.remoteNonzeroTicks[name] ?? 0,
          );
          expect(rendered.remotePeaks[name]).toBeGreaterThan(0);
        }
        if (previous) {
          expect(observation.receivedBytes).toBeGreaterThan(
            previous[index]!.receivedBytes,
          );
          expect(observation.sentBytes).toBeGreaterThan(
            previous[index]!.sentBytes,
          );
        }
        expect(
          await clients[index]!.page.locator("video").evaluate(
            (video: HTMLVideoElement) => ({
              paused: video.paused,
              rate: video.playbackRate,
              error: video.error?.code ?? null,
            }),
          ),
        ).toEqual({ paused: false, rate: 1, error: null });
      }
      observations.push({
        elapsedSec: Math.round((Date.now() - startedAt) / 1_000),
        clients: current,
        playback,
      });
      previous = current;
      previousPlayback = playback;
      if (
        await host.page
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.currentTime > 40)
      ) {
        const progress = host.page.getByRole("slider", { name: "播放进度" });
        await progress.focus();
        await progress.press("Home");
        for (let index = 0; index < 5; index += 1)
          await progress.press("ArrowRight");
        await progress.press("Tab");
      }
    }
    await closeRoom(host.page);
    for (const { page } of clients) {
      await stopSustainedPlayback(page);
      expect(
        await page.evaluate(
          () =>
            (window as SustainedPlaybackWindow).voiceSustainedProbe ===
            undefined,
        ),
      ).toBe(true);
      await expect.poll(() => liveCaptureCount(page)).toBe(0);
      await expect
        .poll(async () => (await audioEvidence(page)).activeContexts)
        .toBe(0);
      await expectSilentDecoderBridges(page, 0);
    }
  } finally {
    await testInfo.attach("sustained-local-rtc-samples", {
      body: JSON.stringify({ requestedSeconds: seconds, observations }),
      contentType: "application/json",
    });
    for (const { context } of [...clients].reverse())
      await disposeClient(context);
  }
});
