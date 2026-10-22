import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { RoomSnapshot } from "../../packages/contracts/src/index.js";

const origin = "https://127.0.0.1:18443";
const mediaId = "d8b0483b-b1d2-49d4-8f3b-f16341734bd4";
const hostPassword = "player-host-test-password-24-characters";
const viewerPassword = "player-viewer-test-password-24-characters";

interface PresentedFrame {
  mediaTime: number;
  presentedFrames: number;
  observedAtMs: number;
  paused: boolean;
}

interface Evidence {
  snapshots: Array<{ receivedAtMs: number; snapshot: RoomSnapshot }>;
  mediaResponses: Array<{
    path: string;
    status: number;
    contentRange: string | undefined;
    mime: string | undefined;
  }>;
  pageErrors: string[];
}

test("real HTTPS content authorization preserves signed redirect, Range, HEAD and rejection", async ({
  page,
}) => {
  await login(page, "Host");
  const entry = await page.request.get(`/api/v1/media/${mediaId}/content`, {
    maxRedirects: 0,
  });
  expect(entry.status()).toBe(307);
  const signed = entry.headers().location;
  expect(signed).toMatch(/^\/media-files\/[^?]+\?e=\d+&s=/);
  if (!signed) throw new Error("Missing signed content redirect");
  const partial = await page.request.get(signed, {
    headers: { Range: "bytes=0-99" },
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
  expect(partial.headers()["content-type"]).toContain("video/mp4");
  expect((await partial.body()).length).toBe(100);
  expect(partial.headers()["accept-ranges"]).toBe("bytes");
  const etag = partial.headers().etag;
  expect(etag).toBeTruthy();
  expect(
    (
      await page.request.get(signed, {
        headers: { Range: "bytes=100-199", "If-Range": etag! },
      })
    ).status(),
  ).toBe(206);
  expect(
    (
      await page.request.get(signed, {
        headers: { Range: "bytes=100-199", "If-Range": '"different"' },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.get(signed, { headers: { Range: "bytes=999999999-" } })
    ).status(),
  ).toBe(416);
  expect(
    (
      await page.request.get(signed, { headers: { Range: "bytes=0-1,4-5" } })
    ).status(),
  ).toBe(416);

  const headEntry = await page.request.head(
    `/api/v1/media/${mediaId}/content`,
    { maxRedirects: 0 },
  );
  expect(headEntry.status()).toBe(307);
  const head = await page.request.head(headEntry.headers().location!);
  expect(head.status()).toBe(200);
  expect(Number(head.headers()["content-length"])).toBeGreaterThan(1_000_000);
  expect((await head.body()).length).toBe(0);
  const invalid = new URL(signed, origin);
  invalid.searchParams.set("s", "tampered");
  expect((await page.request.get(invalid.href)).status()).toBe(401);
  invalid.searchParams.set("e", "1");
  expect((await page.request.get(invalid.href)).status()).toBe(401);
  await page.context().clearCookies();
  expect((await page.request.get(signed)).status()).toBe(401);
});

test("Host seek, pause, rapid final target and page recovery reach actual presented frames", async ({
  browser,
}, testInfo) => {
  const host = await createClient(browser);
  const viewer = await createClient(browser);
  let roomId: string | undefined;
  try {
    await login(host.page, "Host");
    await closeExistingRoom(host.page);
    await host.page.getByRole("button", { name: /开启放映室/ }).click();
    await host.page.getByRole("button", { name: "进入主持房间" }).click();
    await expect(host.page).toHaveURL(/\/room\//);
    roomId = new URL(host.page.url()).pathname.split("/").at(-1);
    await host.page
      .getByLabel("选择点播影片")
      .selectOption({ label: "sync-player-fixture.mp4" });
    await login(viewer.page, "Simple");
    await expect(viewer.page).toHaveURL(/\/room\//);
    for (const page of [host.page, viewer.page]) {
      await expect(page.locator("video")).toHaveAttribute(
        "src",
        `/api/v1/media/${mediaId}/content`,
      );
      await page
        .getByRole("button", { name: "启用节目声音", exact: true })
        .click();
      expect(
        await page
          .locator("video")
          .evaluate(
            (video) =>
              typeof (video as HTMLVideoElement).requestVideoFrameCallback,
          ),
      ).toBe("function");
    }

    // Exercise the user's real Host control. No media src override, mocked route,
    // disabled autoplay policy, direct currentTime assignment or fake seek event.
    await host.page
      .getByRole("button", { name: "▶ 播放", exact: true })
      .click();
    await expect
      .poll(async () => (await latestFrame(viewer.page))?.mediaTime ?? -1)
      .toBeGreaterThan(0.2);
    await expect
      .poll(async () => await driftFromAuthority(viewer.page, viewer.evidence))
      .toBeLessThan(0.5);

    await seekWithKeyboard(host.page, 22);
    await expect
      .poll(async () => (await latestFrame(viewer.page))?.mediaTime ?? -1)
      .toBeGreaterThan(21.5);
    await expect
      .poll(async () => await driftFromAuthority(viewer.page, viewer.evidence))
      .toBeLessThan(0.5);
    await seekWithKeyboard(host.page, 5);
    await expect
      .poll(async () => {
        const frame = await latestFrame(viewer.page);
        return Boolean(frame && frame.mediaTime >= 4.8 && frame.mediaTime < 10);
      })
      .toBe(true);

    await host.page
      .getByRole("button", { name: "Ⅱ 暂停", exact: true })
      .click();
    await expect
      .poll(() =>
        viewer.page
          .locator("video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(true);
    const beforePausedSeek = Date.now();
    await seekWithKeyboard(host.page, 16);
    await expect
      .poll(async () => {
        const frame = await latestFrame(viewer.page);
        // The controller pauses inside its own frame subscriber. Subscriber
        // ordering is not evidence of the final pause state; check the actual
        // element as well as the independent target-frame metadata.
        const paused = await viewer.page
          .locator("video")
          .evaluate((video) => (video as HTMLVideoElement).paused);
        return Boolean(
          frame &&
          frame.observedAtMs >= beforePausedSeek &&
          Math.abs(frame.mediaTime - 16) <= 0.15 &&
          paused,
        );
      })
      .toBe(true);

    for (const target of [35, 9, 42]) await seekWithPointer(host.page, target);
    await expect
      .poll(async () =>
        Math.abs(((await latestFrame(viewer.page))?.mediaTime ?? -100) - 42),
      )
      .toBeLessThan(0.3);
    await expect(viewer.page.locator("video")).toHaveJSProperty("paused", true);

    // Exercise a real document/connection recreation and focus recovery. This is
    // desktop automation evidence, not an assertion about actual iPad suspension.
    await viewer.page.reload();
    await expect(viewer.page.locator("video")).toHaveAttribute(
      "src",
      `/api/v1/media/${mediaId}/content`,
    );
    const enable = viewer.page.getByRole("button", {
      name: "启用节目声音",
      exact: true,
    });
    if (await enable.isVisible()) await enable.click();
    await viewer.page.bringToFront();
    await expect
      .poll(async () =>
        Math.abs(((await latestFrame(viewer.page))?.mediaTime ?? -100) - 42),
      )
      .toBeLessThan(0.3);
    await expect(viewer.page.locator("video")).toHaveJSProperty("paused", true);
    await expect(viewer.page.locator("video")).toHaveJSProperty("muted", false);
    await expect(
      viewer.page.getByText("同步未完成，请重试", { exact: true }),
    ).not.toBeVisible();
    await viewer.page.screenshot({
      path: testInfo.outputPath("viewer-recovered-paused.png"),
    });
    await host.page
      .getByRole("button", { name: "▶ 播放", exact: true })
      .click();
    await expect
      .poll(async () => (await latestFrame(viewer.page))?.mediaTime ?? -1)
      .toBeGreaterThan(42.3);
    await expect
      .poll(async () => await driftFromAuthority(viewer.page, viewer.evidence))
      .toBeLessThan(0.5);

    for (const client of [host, viewer]) {
      expect(client.evidence.pageErrors).toEqual([]);
      expect(
        client.evidence.mediaResponses.some(
          (response) =>
            response.path.includes("/content") && response.status === 307,
        ),
      ).toBe(true);
      expect(
        client.evidence.mediaResponses.some(
          (response) =>
            response.path.startsWith("/media-files/") &&
            response.status === 206 &&
            response.contentRange,
        ),
      ).toBe(true);
    }
    await viewer.page.screenshot({
      path: testInfo.outputPath("viewer-final.png"),
    });
  } finally {
    await attachEvidence(testInfo, "host", host);
    await attachEvidence(testInfo, "viewer", viewer);
    if (roomId) await closeExistingRoom(host.page).catch(() => undefined);
    await host.context.close();
    await viewer.context.close();
  }
});

async function login(page: Page, username: "Host" | "Simple"): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("账户名称").fill(username);
  await page
    .getByLabel("账户密码")
    .fill(username === "Host" ? hostPassword : viewerPassword);
  await page.getByRole("button", { name: /凭证入场/ }).click();
  await expect(page.getByLabel("账户密码")).not.toBeVisible();
}

async function closeExistingRoom(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const session = await fetch("/api/v1/auth/session", {
      credentials: "same-origin",
    });
    if (!session.ok) return;
    const body = (await session.json()) as { csrfToken: string };
    const active = await fetch("/api/v1/admin/active-room", {
      credentials: "same-origin",
    });
    if (!active.ok || !(await active.json())) return;
    const response = await fetch("/api/v1/admin/active-room", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "x-csrf-token": body.csrfToken },
    });
    if (!response.ok)
      throw new Error(`Local fixture room cleanup: ${response.status}`);
  });
  // A fresh reload aligns the UI's CSRF token with the local cleanup operation.
  await page.goto("/admin");
}

async function seekWithKeyboard(page: Page, position: number): Promise<void> {
  const slider = page.getByRole("slider", { name: "播放进度" });
  await slider.fill(String(position));
  // End a supported keyboard gesture without shifting the selected target.
  await slider.press("ArrowRight");
  await slider.press("ArrowLeft");
}

async function seekWithPointer(page: Page, position: number): Promise<void> {
  const slider = page.getByRole("slider", { name: "播放进度" });
  const box = await slider.boundingBox();
  if (!box) throw new Error("Playback slider is not visible");
  const metrics = await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    const style = getComputedStyle(input);
    const thumbWidths = ["::-webkit-slider-thumb", "::-moz-range-thumb"].map(
      (pseudo) => Number.parseFloat(getComputedStyle(input, pseudo).width),
    );
    return {
      min: Number(input.min),
      max: Number(input.max),
      step: Number(input.step),
      leftInset:
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.paddingLeft),
      rightInset:
        Number.parseFloat(style.borderRightWidth) +
        Number.parseFloat(style.paddingRight),
      // Some engines report the input's width for an unsupported pseudo-element.
      thumbWidth: thumbWidths.find((width) => width > 0 && width <= 64) ?? 16,
    };
  });
  const trackStart = box.x + metrics.leftInset + metrics.thumbWidth / 2;
  const trackWidth =
    box.width - metrics.leftInset - metrics.rightInset - metrics.thumbWidth;
  // Native pointer coordinates are quantized to physical pixels; one pixel can
  // represent more than the input's 0.1s step. This bounds only the gesture, not
  // the unchanged 0.3s actual-frame or 0.5s synchronization assertions.
  const pointerTolerance = Math.max(
    metrics.step / 2 + 0.001,
    (metrics.max - metrics.min) / trackWidth,
  );
  let pixelsPerSecond = trackWidth / (metrics.max - metrics.min);
  let x = trackStart + (position - metrics.min) * pixelsPerSecond;
  const samples: Array<{ x: number; value: number }> = [];
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  try {
    // Native range geometry differs across engines. Calibrate only with real
    // pointer movement while held down; do not assign a value or fake an event.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const value = Number(await slider.inputValue());
      samples.push({ x, value });
      if (Math.abs(value - position) <= pointerTolerance) break;
      const previous = samples.at(-2);
      if (previous && Math.abs(value - previous.value) >= metrics.step) {
        const measured = (x - previous.x) / (value - previous.value);
        if (Number.isFinite(measured) && measured > 0)
          pixelsPerSecond = measured;
      }
      x = Math.max(
        box.x + metrics.leftInset,
        Math.min(
          box.x + box.width - metrics.rightInset,
          x + (position - value) * pixelsPerSecond,
        ),
      );
      await page.mouse.move(x, box.y + box.height / 2);
    }
    expect(
      Math.abs(Number(await slider.inputValue()) - position),
      `Pointer must select the intended time before commit: ${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(pointerTolerance);
  } finally {
    await page.mouse.up();
    await test.info().attach(`pointer-target-${position}`, {
      body: JSON.stringify(
        { position, metrics, pointerTolerance, samples },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
}

async function createClient(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page; evidence: Evidence }> {
  const context = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const evidence: Evidence = {
    snapshots: [],
    mediaResponses: [],
    pageErrors: [],
  };
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/media-files/") || path.endsWith("/content")) {
      const headers = response.headers();
      evidence.mediaResponses.push({
        path,
        status: response.status(),
        contentRange: headers["content-range"],
        mime: headers["content-type"],
      });
    }
  });
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as {
          type: string;
          payload: RoomSnapshot | { currentSnapshot: RoomSnapshot };
        };
        const snapshot =
          message.type === "room.snapshot"
            ? (message.payload as RoomSnapshot)
            : message.type === "room.command.applied"
              ? (message.payload as { currentSnapshot: RoomSnapshot })
                  .currentSnapshot
              : undefined;
        if (snapshot)
          evidence.snapshots.push({ receivedAtMs: Date.now(), snapshot });
      } catch {
        /* Non-JSON frames cannot create playback evidence. */
      }
    }),
  );
  await page.addInitScript(() => {
    const observed = new WeakSet<HTMLVideoElement>();
    const frames: Array<{
      mediaTime: number;
      presentedFrames: number;
      observedAtMs: number;
      paused: boolean;
    }> = [];
    Object.assign(window, { __playerGateFrames: frames });
    const scan = () => {
      for (const video of document.querySelectorAll("video")) {
        if (
          observed.has(video) ||
          typeof video.requestVideoFrameCallback !== "function"
        )
          continue;
        observed.add(video);
        const frame = (now: number, metadata: VideoFrameCallbackMetadata) => {
          frames.push({
            mediaTime: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
            observedAtMs: performance.timeOrigin + now,
            paused: video.paused,
          });
          if (frames.length > 2000) frames.splice(0, frames.length - 2000);
          if (video.isConnected) video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame);
      }
    };
    new MutationObserver(scan).observe(document, {
      childList: true,
      subtree: true,
    });
    scan();
  });
  return { context, page, evidence };
}

async function latestFrame(page: Page): Promise<PresentedFrame | null> {
  return page.evaluate(() => {
    const frameWindow = window as unknown as {
      __playerGateFrames?: PresentedFrame[];
    };
    return frameWindow.__playerGateFrames?.at(-1) ?? null;
  });
}

async function driftFromAuthority(
  page: Page,
  evidence: Evidence,
): Promise<number> {
  const frame = await latestFrame(page);
  const latest = evidence.snapshots.at(-1);
  const transport = latest?.snapshot.transport;
  if (!frame || !latest || !transport) return Number.POSITIVE_INFINITY;
  const serverFrameTime =
    frame.observedAtMs + latest.snapshot.serverNowMs - latest.receivedAtMs;
  if (serverFrameTime < transport.anchoredAtServerMs)
    return Number.POSITIVE_INFINITY;
  const target =
    transport.positionSec +
    (transport.state === "playing"
      ? ((serverFrameTime - transport.anchoredAtServerMs) * transport.rate) /
        1000
      : 0);
  return Math.abs(frame.mediaTime - target);
}

async function attachEvidence(
  testInfo: TestInfo,
  name: string,
  client: Awaited<ReturnType<typeof createClient>>,
): Promise<void> {
  const frames = await client.page
    .evaluate(
      () =>
        (window as unknown as { __playerGateFrames?: PresentedFrame[] })
          .__playerGateFrames ?? [],
    )
    .catch(() => []);
  const playerState = await client.page
    .evaluate(() => {
      const video = document.querySelector("video");
      const stored = (key: string): unknown => {
        try {
          const value = sessionStorage.getItem(key);
          return value ? (JSON.parse(value) as unknown) : null;
        } catch {
          return null;
        }
      };
      const ranges = (value: TimeRanges) =>
        Array.from({ length: value.length }, (_, index) => [
          value.start(index),
          value.end(index),
        ]);
      return {
        visibility: document.visibilityState,
        video: video
          ? {
              currentTime: video.currentTime,
              duration: video.duration,
              paused: video.paused,
              seeking: video.seeking,
              readyState: video.readyState,
              networkState: video.networkState,
              playbackRate: video.playbackRate,
              buffered: ranges(video.buffered),
              seekable: ranges(video.seekable),
              error: video.error
                ? { code: video.error.code, message: video.error.message }
                : null,
            }
          : null,
        playbackTrace: stored("simplewatch.playback-trace"),
        programDiagnostics: stored("simplewatch.program-diagnostics"),
      };
    })
    .catch(() => null);
  await testInfo.attach(`${name}-player-evidence`, {
    body: JSON.stringify({ ...client.evidence, frames, playerState }, null, 2),
    contentType: "application/json",
  });
  // The test status is finalized only after finally returns. Always capture the
  // current page here so a failed assertion is not illustrated by room cleanup.
  const screenshot = await client.page.screenshot({
    path: testInfo.outputPath(`${name}-before-cleanup.png`),
  });
  await testInfo.attach(`${name}-before-cleanup`, {
    body: screenshot,
    contentType: "image/png",
  });
}
