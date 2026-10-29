import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { RoomServiceClient } from "livekit-server-sdk";
import {
  closeFixtureRoom,
  logoutFixtureSession,
  stopFixturePageActivity,
} from "./cleanup.js";

// All endpoints and credentials below belong to the loopback-only voice gate.
const origin = "https://127.0.0.1:18443";
const hostPassword = "player-host-test-password-24-characters";
const viewerPassword = "player-viewer-test-password-24-characters";
const inputA = "voice-lifecycle-fake-input-a";
const inputB = "voice-lifecycle-fake-input-b";
const rtc = new RoomServiceClient(
  "http://127.0.0.1:17880",
  "local-voice-gate-key",
  "local-voice-gate-secret-not-production-32-bytes",
);

interface Observations {
  documentId: string;
  requests: string[];
  tracks: MediaStreamTrack[];
  contexts: AudioContext[];
  fixtureContexts: AudioContext[];
  peers: RTCPeerConnection[];
  elements: HTMLAudioElement[];
}

interface LifecycleWindow extends Window {
  voiceLifecycle: Observations;
}

interface Client {
  context: BrowserContext;
  page: Page;
  username: "Host" | "Simple";
  documentId?: string;
}

async function client(browser: Browser, username: Client["username"]) {
  const context = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(
    ({ first, second }) => {
      const state: Observations = {
        documentId: crypto.randomUUID(),
        requests: [],
        tracks: [],
        contexts: [],
        fixtureContexts: [],
        peers: [],
        elements: [],
      };
      (window as unknown as LifecycleWindow).voiceLifecycle = state;
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(configuration?: RTCConfiguration) {
          super(configuration);
          state.peers.push(this);
        }
      };
      const NativeContext = window.AudioContext;
      window.AudioContext = class extends NativeContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          state.contexts.push(this);
        }
      };
      const createElement = document.createElement.bind(document);
      document.createElement = ((
        name: string,
        options?: ElementCreationOptions,
      ) => {
        const element = createElement(name, options);
        if (name.toLowerCase() === "audio")
          state.elements.push(element as HTMLAudioElement);
        return element;
      }) as Document["createElement"];

      // Chromium's runner uses --use-fake-device-for-media-stream. Acquire and
      // release that fake device, then supply a known 0.03-amplitude test tone.
      // This avoids treating the browser's low/intermittent default fake signal
      // as a decoder failure. Only capture is synthetic; the production audio
      // processor, browser encoder/decoder, application API and SFU remain real.
      const nativeCapture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      const inputs = [first, second].map((deviceId, index) => ({
        kind: "audioinput" as const,
        deviceId,
        groupId: `voice-lifecycle-fake-group-${index}`,
        label: `Lifecycle fake microphone ${index === 0 ? "A" : "B"}`,
        toJSON() {
          return {
            kind: this.kind,
            deviceId: this.deviceId,
            groupId: this.groupId,
            label: this.label,
          };
        },
      }));
      navigator.mediaDevices.enumerateDevices = () => Promise.resolve(inputs);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints?.audio || constraints.video)
          throw new Error("Lifecycle gate permits fake audio capture only");
        const audio =
          typeof constraints.audio === "object" ? constraints.audio : {};
        const constraint = audio.deviceId;
        const requested =
          typeof constraint === "string"
            ? constraint
            : constraint && !Array.isArray(constraint)
              ? (constraint.exact ?? constraint.ideal)
              : undefined;
        const id = typeof requested === "string" ? requested : first;
        const input = inputs.find((device) => device.deviceId === id);
        if (!input) throw new Error("Unexpected non-fixture input device");
        const nativeAudio = { ...audio };
        delete nativeAudio.deviceId;
        state.requests.push(id);
        const fake = await nativeCapture({
          audio: nativeAudio,
          video: false,
        });
        fake.getTracks().forEach((track) => track.stop());
        // Fixture donors are separate from application/SDK AudioContexts, but
        // must also close whenever the owned track ends.
        const donor = new NativeContext({ sampleRate: 48_000 });
        state.fixtureContexts.push(donor);
        await donor.resume();
        const destination = new MediaStreamAudioDestinationNode(donor, {
          channelCount: 1,
          channelCountMode: "explicit",
        });
        const tone = donor.createOscillator();
        tone.frequency.value = id === first ? 330 : 550;
        const gain = donor.createGain();
        gain.gain.value = 0.03;
        tone.connect(gain).connect(destination);
        tone.start();
        const track = destination.stream.getAudioTracks()[0]!;
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({
          ...settings(),
          deviceId: input.deviceId,
          groupId: input.groupId,
        });
        const stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => {
          if (stopped) return;
          stopped = true;
          tone.stop();
          tone.disconnect();
          gain.disconnect();
          stop();
          void donor.close();
        };
        state.tracks.push(track);
        return destination.stream;
      };
    },
    { first: inputA, second: inputB },
  );
  return { context, page: await context.newPage(), username } satisfies Client;
}

async function login(current: Client) {
  await current.page.goto("/");
  await current.page.getByLabel("账户名称").fill(current.username);
  await current.page
    .getByLabel("账户密码")
    .fill(current.username === "Host" ? hostPassword : viewerPassword);
  await current.page.getByRole("button", { name: /凭证入场/ }).click();
  current.documentId = await current.page.evaluate(
    () => (window as unknown as LifecycleWindow).voiceLifecycle.documentId,
  );
}

async function resources(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as LifecycleWindow).voiceLifecycle;
    const bridges = state.elements.filter(
      (element) => element.dataset.simplewatchVoice === "playout-bridge",
    );
    return {
      documentId: state.documentId,
      calls: state.requests.length,
      lastInput: state.requests.at(-1) ?? null,
      liveTracks: state.tracks.filter((track) => track.readyState === "live")
        .length,
      endedTracks: state.tracks.filter((track) => track.readyState === "ended")
        .length,
      activeContexts: state.contexts.filter(
        (context) => context.state !== "closed",
      ).length,
      activeFixtureContexts: state.fixtureContexts.filter(
        (context) => context.state !== "closed",
      ).length,
      activePeers: state.peers.filter(
        (peer) => peer.connectionState !== "closed",
      ).length,
      connectedBridges: bridges.filter((element) => element.isConnected).length,
      retainedBridgeStreams: bridges.filter(
        (element) => element.srcObject !== null,
      ).length,
      allBridgesSilent: bridges.every(
        (element) =>
          element.muted && element.defaultMuted && element.volume === 0,
      ),
      allDetachedBridgesReleased: bridges.every(
        (element) =>
          element.isConnected || (element.paused && element.srcObject === null),
      ),
    };
  });
}

async function participants(roomId: string) {
  try {
    return await rtc.listParticipants(`voice:${roomId}`);
  } catch (error) {
    if (
      error instanceof Error &&
      /room.+(?:does not exist|not found)|not found/i.test(error.message)
    )
      return [];
    throw error;
  }
}

async function voiceJoined(
  current: Client,
  roomId: string,
  expectedCalls: number,
) {
  await expect(current.page).toHaveURL(`${origin}/room/${roomId}`);
  const panel = current.page.locator(".voice-panel__desktop");
  await expect(
    panel.getByText("已加入语音频道", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("麦克风关闭 · 未采集", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await resources(current.page)).activeContexts)
    .toBe(1);
  const state = await resources(current.page);
  expect(state.documentId).toBe(current.documentId);
  expect(state.calls).toBe(expectedCalls);
  expect(state.liveTracks).toBe(0);
  expect(state.activeFixtureContexts).toBe(0);
  expect(state.allBridgesSilent).toBe(true);
}

async function enableOutput(page: Page) {
  const button = page
    .locator(".voice-panel__desktop")
    .getByRole("button", { name: /^(启用|恢复)语音声音$/ });
  if (await button.isVisible()) await button.click();
}

async function receivedAudio(listener: Client, speaker: Client) {
  await enableOutput(listener.page);
  const panel = listener.page.locator(".voice-panel__desktop");
  await expect
    .poll(async () =>
      Number(
        await panel
          .getByLabel(`${speaker.username} 收听电平`, { exact: true })
          .getAttribute("value"),
      ),
    )
    .toBeGreaterThan(0);
  const bridge = listener.page.locator(
    'audio[data-simplewatch-voice="playout-bridge"]',
  );
  await expect(bridge).toHaveCount(1);
  // Inspect actual decoded samples using the existing application context and
  // a zero-gain probe, never a second audible output or another AudioContext.
  const evidence = await listener.page.evaluate(async () => {
    const state = (window as unknown as LifecycleWindow).voiceLifecycle;
    const context = state.contexts.find((entry) => entry.state === "running");
    const bridge = document.querySelector<HTMLAudioElement>(
      'audio[data-simplewatch-voice="playout-bridge"]',
    );
    if (!context || !(bridge?.srcObject instanceof MediaStream))
      throw new Error("Missing active received-audio path");
    const source = context.createMediaStreamSource(bridge.srcObject);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(analyser).connect(silence).connect(context.destination);
    try {
      let rms = 0;
      const samples = new Float32Array(analyser.fftSize);
      for (let sample = 0; sample < 5; sample += 1) {
        await new Promise((resolveSample) => setTimeout(resolveSample, 50));
        analyser.getFloatTimeDomainData(samples);
        rms = Math.max(
          rms,
          Math.sqrt(
            samples.reduce((sum, value) => sum + value * value, 0) /
              samples.length,
          ),
        );
      }
      let receivedBytes = 0;
      for (const peer of state.peers) {
        if (peer.connectionState === "closed") continue;
        const stats = await peer.getStats();
        stats.forEach((entry) => {
          const row = entry as {
            type: string;
            kind?: string;
            bytesReceived?: number;
          };
          if (row.type === "inbound-rtp" && row.kind === "audio")
            receivedBytes += row.bytesReceived ?? 0;
        });
      }
      return {
        rms,
        receivedBytes,
        silentBridge:
          bridge.muted && bridge.defaultMuted && bridge.volume === 0,
      };
    } finally {
      source.disconnect();
      analyser.disconnect();
      silence.disconnect();
    }
  });
  expect(evidence.rms).toBeGreaterThan(0.001);
  expect(evidence.receivedBytes).toBeGreaterThan(0);
  expect(evidence.silentBridge).toBe(true);
  return evidence;
}

async function openMicrophone(
  current: Client,
  input: string,
  expectedCalls: number,
) {
  await current.page
    .getByRole("button", { name: "打开麦克风", exact: true })
    .click();
  await expect(
    current.page.getByRole("button", { name: "关闭麦克风", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await resources(current.page)).activeContexts)
    .toBe(1);
  const state = await resources(current.page);
  expect(state.calls).toBe(expectedCalls);
  expect(state.liveTracks).toBe(1);
  expect(state.activeFixtureContexts).toBe(1);
  expect(state.lastInput).toBe(input);
}

async function released(current: Client, expectedCalls: number) {
  await expect
    .poll(async () => {
      const state = await resources(current.page);
      return {
        tracks: state.liveTracks,
        contexts: state.activeContexts,
        fixtureContexts: state.activeFixtureContexts,
        peers: state.activePeers,
        bridges: state.connectedBridges,
        retainedStreams: state.retainedBridgeStreams,
      };
    })
    .toEqual({
      tracks: 0,
      contexts: 0,
      fixtureContexts: 0,
      peers: 0,
      bridges: 0,
      retainedStreams: 0,
    });
  const state = await resources(current.page);
  expect(state.documentId).toBe(current.documentId);
  expect(state.calls).toBe(expectedCalls);
  expect(state.endedTracks).toBe(expectedCalls);
  expect(state.allBridgesSilent).toBe(true);
  expect(state.allDetachedBridgesReleased).toBe(true);
}

async function cleanup(clients: Client[], roomId?: string) {
  const failures: unknown[] = [];
  try {
    await stopFixturePageActivity(clients.map((current) => current.context));
  } catch (error) {
    failures.push(error);
  }
  const host = clients.find((current) => current.username === "Host");
  if (host && roomId) {
    try {
      await closeFixtureRoom(host.context, roomId);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const current of [...clients].reverse()) {
    try {
      await logoutFixtureSession(current.context);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await current.context.close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  return failures;
}

test("twenty distinct room lifecycles keep auto-join silent, switch fake inputs explicitly and release every owned resource", async ({
  browser,
}, testInfo) => {
  test.setTimeout(20 * 45_000 + 90_000);
  const host: Client = await client(browser, "Host");
  const viewer: Client = await client(browser, "Simple");
  const clients = [host, viewer];
  const calls = new Map<Client, number>(clients.map((current) => [current, 0]));
  const rooms = new Set<string>();
  const observations: unknown[] = [];
  let roomId: string | undefined;
  let cleanupFailures: unknown[] = [];
  try {
    await login(host);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await test.step(`room ${cycle + 1}: receive-only → input A → input B → mute → leave`, async () => {
        await expect(
          host.page.getByRole("button", { name: /开启放映室/ }),
        ).toBeVisible();
        await host.page.getByRole("button", { name: /开启放映室/ }).click();
        await host.page
          .getByRole("button", { name: "进入主持房间", exact: true })
          .click();
        await expect(host.page).toHaveURL(/\/room\//);
        const createdRoom = new URL(host.page.url()).pathname.split("/").at(-1);
        if (!createdRoom) throw new Error("Missing isolated room id");
        roomId = createdRoom;
        expect(rooms.has(roomId)).toBe(false);
        rooms.add(roomId);
        if (cycle === 0) await login(viewer);
        for (const current of clients)
          await voiceJoined(current, createdRoom, calls.get(current)!);
        await expect
          .poll(async () => (await participants(createdRoom)).length)
          .toBe(2);
        expect(
          (await participants(createdRoom)).every(
            (entry) => entry.tracks.length === 0,
          ),
        ).toBe(true);

        const speaker = cycle % 2 === 0 ? host : viewer;
        const listener = speaker === host ? viewer : host;
        const panel = speaker.page.locator(".voice-panel__desktop");
        await panel.getByText("声音与设备选项", { exact: true }).click();
        await panel
          .getByLabel("输入设备", { exact: true })
          .selectOption(inputA);
        calls.set(speaker, calls.get(speaker)! + 1);
        await openMicrophone(speaker, inputA, calls.get(speaker)!);
        const first = await receivedAudio(listener, speaker);

        // A selected-device change must close the previous raw track and must
        // not issue another permission/capture request until a fresh gesture.
        await panel
          .getByLabel("输入设备", { exact: true })
          .selectOption(inputB);
        await expect(
          speaker.page.getByRole("button", { name: "打开麦克风", exact: true }),
        ).toBeVisible();
        await expect
          .poll(async () => (await resources(speaker.page)).liveTracks)
          .toBe(0);
        expect((await resources(speaker.page)).calls).toBe(calls.get(speaker));
        expect((await resources(speaker.page)).endedTracks).toBe(
          calls.get(speaker),
        );
        calls.set(speaker, calls.get(speaker)! + 1);
        await openMicrophone(speaker, inputB, calls.get(speaker)!);
        const second = await receivedAudio(listener, speaker);

        await speaker.page
          .getByRole("button", { name: "关闭麦克风", exact: true })
          .click();
        await expect
          .poll(async () => (await resources(speaker.page)).liveTracks)
          .toBe(0);
        await expect(
          listener.page.locator(
            'audio[data-simplewatch-voice="playout-bridge"]',
          ),
        ).toHaveCount(0);
        calls.set(speaker, calls.get(speaker)! + 1);
        await openMicrophone(speaker, inputB, calls.get(speaker)!);
        const third = await receivedAudio(listener, speaker);
        expect((await resources(listener.page)).calls).toBe(
          calls.get(listener),
        );

        // Leave while capture is live: this exercises room teardown, rather
        // than hiding a cleanup defect by always muting before departure.
        host.page.once("dialog", (dialog) => dialog.accept());
        await host.page
          .getByRole("button", { name: "关闭房间", exact: true })
          .click();
        await expect(host.page).toHaveURL(`${origin}/admin`);
        await expect(viewer.page).toHaveURL(`${origin}/`);
        for (const current of clients)
          await released(current, calls.get(current)!);
        await expect
          .poll(async () => (await participants(createdRoom)).length)
          .toBe(0);
        observations.push({
          cycle: cycle + 1,
          speaker: speaker.username,
          audio: [first, second, third],
          resources: await Promise.all(
            clients.map((current) => resources(current.page)),
          ),
        });
        roomId = undefined;
      });
    }
    expect(rooms.size).toBe(20);
    expect([...calls.values()].reduce((sum, value) => sum + value, 0)).toBe(60);
  } finally {
    await testInfo.attach("twenty-room-lifecycle-evidence", {
      body: JSON.stringify({
        completedCycles: observations.length,
        observations,
        finalResources: await Promise.all(
          clients.map(async (current) => ({
            username: current.username,
            state: await resources(current.page).catch((error: unknown) => ({
              unavailable:
                error instanceof Error ? error.message : String(error),
            })),
          })),
        ),
      }),
      contentType: "application/json",
    });
    cleanupFailures = await cleanup(clients, roomId);
    if (cleanupFailures.length) {
      await testInfo.attach("lifecycle-cleanup-failures", {
        body: JSON.stringify(
          cleanupFailures.map((error) =>
            error instanceof Error ? error.message : String(error),
          ),
        ),
        contentType: "application/json",
      });
    }
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, "Lifecycle gate cleanup failed");
});
