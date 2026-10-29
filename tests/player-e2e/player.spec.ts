import {
  devices,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RoomSnapshot } from "../../packages/contracts/src/index.js";

const origin = "https://127.0.0.1:18443";
const mediaId = "d8b0483b-b1d2-49d4-8f3b-f16341734bd4";
const hostPassword = "player-host-test-password-24-characters";
const viewerPassword = "player-viewer-test-password-24-characters";

interface PresentedFrame {
  mediaTime: number;
  presentedFrames: number;
  observedAtMs: number;
  expectedDisplayAtMs: number;
  paused: boolean;
}

interface MediaEventObservation {
  event: string;
  observedAtMs: number;
  mediaTime: number;
  playbackRate: number;
}

interface Evidence {
  snapshots: Array<{ receivedAtMs: number; snapshot: RoomSnapshot }>;
  clocks: Array<{ offsetMs: number; roundTripMs: number }>;
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

test("page-local comparisons preserve authenticated media and can return to normal sync", async ({
  browser,
}, testInfo) => {
  const host = await createClient(browser);
  const viewer = await createClient(browser);
  try {
    await login(host.page, "Host");
    await closeExistingRoom(host.page);
    await host.page.getByRole("button", { name: /开启放映室/ }).click();
    await host.page.getByRole("button", { name: "进入主持房间" }).click();
    await host.page
      .getByLabel("选择点播影片")
      .selectOption({ label: "sync-player-fixture.mp4" });
    await login(viewer.page, "Simple");
    await expect(viewer.page.locator("video")).toHaveAttribute(
      "src",
      `/api/v1/media/${mediaId}/content`,
    );
    await viewer.page.getByText("播放诊断", { exact: true }).click();
    const comparison = viewer.page.getByLabel("当前页面对照模式");
    await comparison.selectOption("native");
    await expect(viewer.page.locator("video")).toHaveJSProperty(
      "controls",
      true,
    );
    await expect(viewer.page.locator("video")).toHaveAttribute(
      "data-comparison-mode",
      "native",
    );
    await host.page
      .getByRole("button", { name: "启用节目声音", exact: true })
      .click();
    await host.page
      .getByRole("button", { name: "▶ 播放", exact: true })
      .click();
    await viewer.page
      .getByRole("button", { name: "启用节目声音", exact: true })
      .click();
    await expect
      .poll(async () => (await latestFrame(viewer.page))?.mediaTime ?? -1)
      .toBeGreaterThan(5);
    await seekWithKeyboard(host.page, 35);
    await expect
      .poll(async () => (await latestFrame(host.page))?.mediaTime ?? -1)
      .toBeGreaterThan(34.8);
    const nativePosition = (await latestFrame(viewer.page))?.mediaTime ?? -1;
    expect(nativePosition).toBeGreaterThan(0);
    expect(nativePosition).toBeLessThan(15);
    await expect(viewer.page.locator("video")).toHaveJSProperty(
      "playbackRate",
      1,
    );
    await expect(viewer.page.locator("video")).toHaveJSProperty("muted", false);
    expect(viewer.evidence.mediaResponses.some((r) => r.status === 307)).toBe(
      true,
    );
    expect(
      viewer.evidence.mediaResponses.some(
        (r) => r.status === 206 && r.mime?.includes("video/mp4"),
      ),
    ).toBe(true);
    await viewer.page.screenshot({
      path: testInfo.outputPath("native-comparison.png"),
    });

    await comparison.selectOption("host-only");
    await expect(viewer.page.locator("video")).toHaveJSProperty(
      "controls",
      false,
    );
    await viewer.page
      .getByRole("button", { name: "启用节目声音", exact: true })
      .click();
    await seekWithKeyboard(host.page, 10);
    await expect
      .poll(async () => {
        const t = (await latestFrame(viewer.page))?.mediaTime ?? -1;
        return t > 9.8 && t < 18;
      })
      .toBe(true);
    await expect(viewer.page.locator("video")).toHaveJSProperty(
      "playbackRate",
      1,
    );
    await expect(viewer.page.locator("video")).toHaveJSProperty("muted", false);
    await host.page
      .getByRole("button", { name: "Ⅱ 暂停", exact: true })
      .click();
    await expect(viewer.page.locator("video")).toHaveJSProperty("paused", true);
    await host.page
      .getByRole("button", { name: "▶ 播放", exact: true })
      .click();
    await expect(viewer.page.locator("video")).toHaveJSProperty(
      "paused",
      false,
    );
    await viewer.page.screenshot({
      path: testInfo.outputPath("host-only-comparison.png"),
    });
    await viewer.page.reload();
    await expect(viewer.page.locator("video")).toHaveAttribute(
      "data-comparison-mode",
      "normal",
    );
    await expect(viewer.page.locator("video")).toHaveJSProperty(
      "controls",
      false,
    );
    expect(viewer.evidence.pageErrors).toEqual([]);
    expect(host.evidence.pageErrors).toEqual([]);
    await viewer.context.clearCookies();
    expect(
      (
        await viewer.page.request.get(`/api/v1/media/${mediaId}/content`, {
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(401);
  } finally {
    await attachEvidence(testInfo, "comparison-host", host);
    await attachEvidence(testInfo, "comparison-viewer", viewer);
    await closeExistingRoom(host.page).catch(() => undefined);
    await host.context.close();
    await viewer.context.close();
  }
});

test("in-room reports and update notices preserve continuous playback and exact build identity", async ({
  browser,
}, testInfo) => {
  expect(
    testInfo.config.workers,
    "The generated identity fixture requires exclusive local-stack ownership",
  ).toBe(1);
  const host = await createClient(browser);
  const viewer = await createClient(browser);
  let browserVersionRequests = 0;
  const versionPath = resolve(
    process.env.PLAYER_GATE_WEB_ROOT ?? "dist/web",
    "player-version.json",
  );
  const originalVersion = await readFile(versionPath);
  let versionReplaced = false;
  viewer.page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/player-version.json")
      browserVersionRequests += 1;
  });
  try {
    await login(host.page, "Host");
    await closeExistingRoom(host.page);
    await host.page.getByRole("button", { name: /开启放映室/ }).click();
    await host.page.getByRole("button", { name: "进入主持房间" }).click();
    await host.page
      .getByLabel("选择点播影片")
      .selectOption({ label: "sync-player-fixture.mp4" });
    await login(viewer.page, "Simple");
    for (const page of [host.page, viewer.page]) {
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
    // A historical first frame is not evidence that presentation is still
    // advancing when we copy the report. Establish a fresh steady-state frame
    // after startup, while retaining the strict playing/continuity assertions.
    await expect
      .poll(async () => {
        const frame = await latestFrame(viewer.page);
        return Boolean(
          frame && frame.mediaTime > 3 && Date.now() - frame.observedAtMs < 250,
        );
      })
      .toBe(true);
    await expect(
      viewer.page.getByRole("status").filter({ hasText: /^正在播放/ }),
    ).toBeVisible();
    await expect
      .poll(async () => await driftFromAuthority(viewer.page, viewer.evidence))
      .toBeLessThanOrEqual(0.25);
    await expect(viewer.page.locator("video")).toHaveJSProperty(
      "seeking",
      false,
    );

    const versionResponse = await viewer.page.request.get(
      "/player-version.json",
    );
    expect(versionResponse.status()).toBe(200);
    expect(versionResponse.headers()["cache-control"]).toContain("no-store");
    const manifest = (await versionResponse.json()) as {
      schemaVersion: number;
      buildId: string;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.buildId).toMatch(/^[a-f0-9]{64}$/);
    await expect.poll(() => browserVersionRequests).toBeGreaterThan(0);
    await expect(
      viewer.page.getByRole("status", { name: "播放器版本" }),
    ).toContainText(manifest.buildId.slice(0, 12));
    const roomUrl = viewer.page.url();
    const video = await viewer.page.locator("video").elementHandle();
    if (!video) throw new Error("Missing continuous playback video");
    const baseline = await video.evaluate((element) => ({
      atMs: performance.timeOrigin + performance.now(),
      currentTime: (element as HTMLVideoElement).currentTime,
    }));
    let documentNavigations = 0;
    viewer.page.on("framenavigated", (frame) => {
      if (frame === viewer.page.mainFrame()) documentNavigations += 1;
    });

    // Only the clipboard sink is substituted. The player, media requests,
    // clocks, currentTime, seek events and presented frames stay real.
    await viewer.page.evaluate(() => {
      const capture = window as unknown as { __copiedPlayerReport?: string };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (value: string) => {
            capture.__copiedPlayerReport = value;
            return Promise.resolve();
          },
        },
      });
    });
    await viewer.page.getByText("播放诊断", { exact: true }).click();
    const copy = viewer.page.getByRole("button", {
      name: "复制当前播放报告（不离开房间）",
      exact: true,
    });
    await copy.click();
    await expect(
      viewer.page.getByText("已复制脱敏播放报告（含最近事件），播放未中断。", {
        exact: true,
      }),
    ).toBeVisible();
    const copied = await viewer.page.evaluate(
      () =>
        (window as unknown as { __copiedPlayerReport?: string })
          .__copiedPlayerReport,
    );
    expect(copied).toBeTruthy();
    const report = JSON.parse(copied!) as {
      schemaVersion: number;
      buildId: string;
      latestBuildId: string | null;
      program: { playbackRate: number; currentTimeSec: number };
      controller: {
        phase: string;
        frameEvidence: string;
        intentId: number | null;
      };
      trace: unknown[];
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.buildId).toBe(manifest.buildId);
    expect(report.latestBuildId).toBe(manifest.buildId);
    expect(report.program.playbackRate).toBe(1);
    expect(report.program.currentTimeSec).toBeGreaterThan(0);
    expect(report.controller).toMatchObject({
      phase: "playing",
      frameEvidence: "verified",
      intentId: null,
    });
    expect(report.trace.length).toBeGreaterThan(0);
    expect(report.trace.length).toBeLessThanOrEqual(120);
    expect(copied!.length).toBeLessThanOrEqual(64 * 1024);
    expect(copied).not.toContain(mediaId);
    expect(copied).not.toContain(roomUrl.split("/").at(-1));
    expect(copied).not.toMatch(
      /https?:\/\/|Bearer |__Host-sw_session|csrfToken/,
    );

    await viewer.page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () =>
            Promise.reject(
              new DOMException(
                "Local test clipboard denied",
                "NotAllowedError",
              ),
            ),
        },
      });
    });
    await copy.click();
    const fallback = viewer.page.getByRole("textbox", { name: "脱敏播放报告" });
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveJSProperty("readOnly", true);
    const fallbackReport = JSON.parse(await fallback.inputValue()) as {
      buildId: string;
      program: { currentTimeSec: number };
    };
    expect(fallbackReport.buildId).toBe(manifest.buildId);
    expect(fallbackReport.program.currentTimeSec).toBeGreaterThanOrEqual(
      report.program.currentTimeSec,
    );
    await expect
      .poll(async () => (await latestFrame(viewer.page))?.mediaTime ?? -1)
      .toBeGreaterThan(baseline.currentTime + 1);
    await viewer.page.screenshot({
      path: testInfo.outputPath("in-room-report-fallback.png"),
      fullPage: true,
    });

    const nextBuild =
      manifest.buildId === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    // The isolated local stack serves the actual generated identity file. Use
    // a real server-side update rather than page.route: WebKit service-worker
    // controlled pages can bypass that interception. Keep the worker enabled,
    // preserve every media request and restore the original bytes in finally.
    versionReplaced = true;
    await writeFile(
      versionPath,
      JSON.stringify({ schemaVersion: 1, buildId: nextBuild }),
    );
    // Respect the real 15-second version-check throttle. This does not replace
    // timers or alter the player clock; pageshow only asks for a fresh identity.
    await viewer.page.waitForTimeout(16_000);
    await viewer.page.evaluate(() =>
      window.dispatchEvent(new Event("pageshow")),
    );
    await expect(
      viewer.page.getByRole("status", { name: "播放器版本" }),
    ).toContainText(`已有新版 ${nextBuild.slice(0, 12)}`);
    await expect(
      viewer.page.getByRole("button", {
        name: "刷新更新播放器",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(async () => (await latestFrame(viewer.page))?.mediaTime ?? -1)
      .toBeGreaterThan(baseline.currentTime + 16);
    expect(viewer.page.url()).toBe(roomUrl);
    expect(documentNavigations).toBe(0);
    expect(
      await video.evaluate(
        (element) =>
          element.isConnected && element === document.querySelector("video"),
      ),
    ).toBe(true);
    const final = await video.evaluate((element) => ({
      atMs: performance.timeOrigin + performance.now(),
      currentTime: (element as HTMLVideoElement).currentTime,
      paused: (element as HTMLVideoElement).paused,
      playbackRate: (element as HTMLVideoElement).playbackRate,
    }));
    const disruptiveEvents = await viewer.page.evaluate(
      (sinceMs) =>
        (
          (
            window as unknown as {
              __playerGateMediaEvents?: MediaEventObservation[];
            }
          ).__playerGateMediaEvents ?? []
        ).filter(
          (event) =>
            event.observedAtMs >= sinceMs &&
            ["seeking", "pause", "ratechange"].includes(event.event),
        ),
      baseline.atMs,
    );
    // Preserve the measurements before asserting: an actual restart or seek
    // must retain its evidence, not just a later frame after it has recovered.
    await testInfo.attach("in-room-report", {
      body: copied!,
      contentType: "application/json",
    });
    await testInfo.attach("report-update-continuity", {
      body: JSON.stringify(
        {
          manifest,
          nextBuild,
          baseline,
          final,
          documentNavigations,
          disruptiveEvents,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(final.paused).toBe(false);
    expect(final.playbackRate).toBe(1);
    expect(
      Math.abs(
        final.currentTime -
          baseline.currentTime -
          (final.atMs - baseline.atMs) / 1000,
      ),
    ).toBeLessThan(0.5);
    expect(disruptiveEvents).toEqual([]);
    expect(viewer.evidence.pageErrors).toEqual([]);
    await viewer.page.screenshot({
      path: testInfo.outputPath("in-room-update-notice.png"),
      fullPage: true,
    });
  } finally {
    if (versionReplaced) await writeFile(versionPath, originalVersion);
    await attachEvidence(testInfo, "report-host", host);
    await attachEvidence(testInfo, "report-viewer", viewer);
    await closeExistingRoom(host.page).catch(() => undefined);
    await host.context.close();
    await viewer.context.close();
  }
});

test("mobile WebKit keeps a continuous 35-second playback window stable", async ({
  browser,
  browserName,
}, testInfo) => {
  // Device emulation exercises the real touch/mobile page path, not iOS's
  // AVFoundation pipeline. The deterministic controller gate and real-device
  // acceptance remain separate requirements.
  test.skip(
    browserName !== "webkit",
    "This gate explicitly exercises mobile WebKit",
  );
  const host = await createClient(browser);
  const viewer = await createClient(browser, { ...devices["iPhone 13"] });
  try {
    await login(host.page, "Host");
    await closeExistingRoom(host.page);
    await host.page.getByRole("button", { name: /开启放映室/ }).click();
    await host.page.getByRole("button", { name: "进入主持房间" }).click();
    await host.page
      .getByLabel("选择点播影片")
      .selectOption({ label: "sync-player-fixture.mp4" });
    await login(viewer.page, "Simple");
    for (const page of [host.page, viewer.page]) {
      await expect(page.locator("video")).toHaveAttribute(
        "src",
        `/api/v1/media/${mediaId}/content`,
      );
      await page
        .getByRole("button", { name: "启用节目声音", exact: true })
        .click();
    }
    await seekWithKeyboard(host.page, 5);
    await expect
      .poll(async () =>
        Math.abs(((await latestFrame(viewer.page))?.mediaTime ?? -100) - 5),
      )
      .toBeLessThan(0.15);
    await host.page
      .getByRole("button", { name: "▶ 播放", exact: true })
      .click();
    // Exclude initial decoding and the explicit test seek. Once this window
    // starts, no command, media assignment or recovery action is injected.
    await expect
      .poll(async () => (await latestFrame(viewer.page))?.mediaTime ?? -1)
      .toBeGreaterThan(6);
    await expect(viewer.page.locator("video")).toHaveJSProperty(
      "seeking",
      false,
    );
    const authoritative = viewer.evidence.snapshots.at(-1)?.snapshot;
    expect(authoritative?.transport?.state).toBe("playing");
    if (!authoritative?.transport) throw new Error("Missing playing authority");
    await expect.poll(() => viewer.evidence.clocks.length).toBeGreaterThan(0);
    const clockSamples = viewer.evidence.clocks
      .filter(
        (sample) => Number.isFinite(sample.offsetMs) && sample.roundTripMs >= 0,
      )
      .sort((left, right) => left.roundTripMs - right.roundTripMs)
      .slice(0, 3);
    const offsetMs = quantile(
      clockSamples.map((sample) => sample.offsetMs),
      0.5,
    );
    expect(Number.isFinite(offsetMs)).toBe(true);

    const observation = await viewer.page.evaluate(async () => {
      const video = document.querySelector("video");
      if (!video) throw new Error("Missing video in mobile steady-state gate");
      const beganMonotonicMs = performance.now();
      const beganAtMs = performance.timeOrigin + beganMonotonicMs;
      const deadlineMs = beganMonotonicMs + 35_000;
      const samples: Array<{
        observedAtMs: number;
        currentTime: number;
        playbackRate: number;
        paused: boolean;
        seeking: boolean;
        readyState: number;
        bufferedAheadSec: number;
        visibility: string;
      }> = [];
      const sample = () => {
        let bufferedAheadSec = 0;
        for (let i = 0; i < video.buffered.length; i += 1) {
          if (
            video.buffered.start(i) <= video.currentTime &&
            video.buffered.end(i) >= video.currentTime
          )
            bufferedAheadSec = video.buffered.end(i) - video.currentTime;
        }
        samples.push({
          observedAtMs: performance.timeOrigin + performance.now(),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
          paused: video.paused,
          seeking: video.seeking,
          readyState: video.readyState,
          bufferedAheadSec,
          visibility: document.visibilityState,
        });
      };
      sample();
      await new Promise<void>((resolve) => {
        const interval = window.setInterval(sample, 250);
        const finish = () => {
          const remainingMs = deadlineMs - performance.now();
          if (remainingMs > 0) {
            // Timers can fire just before their nominal delay after coarse
            // clock quantization. Extend the measurement; never reduce the
            // required 35-second observation or its playback assertions.
            window.setTimeout(finish, Math.ceil(remainingMs) + 1);
            return;
          }
          window.clearInterval(interval);
          sample();
          resolve();
        };
        window.setTimeout(
          finish,
          Math.ceil(deadlineMs - performance.now()) + 1,
        );
      });
      const endedAtMs = performance.timeOrigin + performance.now();
      const observed = window as unknown as {
        __playerGateFrames?: PresentedFrame[];
        __playerGateMediaEvents?: MediaEventObservation[];
      };
      return {
        beganAtMs,
        endedAtMs,
        samples,
        frames: (observed.__playerGateFrames ?? []).filter(
          (frame) =>
            frame.observedAtMs >= beganAtMs && frame.observedAtMs <= endedAtMs,
        ),
        events: (observed.__playerGateMediaEvents ?? []).filter(
          (event) =>
            event.observedAtMs >= beganAtMs && event.observedAtMs <= endedAtMs,
        ),
      };
    });
    const transport = authoritative.transport;
    const frameDriftSec = observation.frames.map((frame) => {
      const target =
        transport.positionSec +
        ((frame.expectedDisplayAtMs + offsetMs - transport.anchoredAtServerMs) /
          1000) *
          transport.rate;
      return target - frame.mediaTime;
    });
    const absoluteDrift = frameDriftSec.map(Math.abs);
    const frameTimes = [
      observation.beganAtMs,
      ...observation.frames.map((frame) => frame.observedAtMs),
      observation.endedAtMs,
    ];
    const frameGapsMs = frameTimes
      .slice(1)
      .map((time, index) => time - frameTimes[index]!);
    const eventCounts = Object.fromEntries(
      ["seeking", "seeked", "waiting", "stalled", "ratechange", "pause"].map(
        (event) => [
          event,
          observation.events.filter((entry) => entry.event === event).length,
        ],
      ),
    );
    const summary = {
      durationMs: observation.endedAtMs - observation.beganAtMs,
      frameCount: observation.frames.length,
      driftP95Sec: quantile(absoluteDrift, 0.95),
      driftMaxSec: Math.max(...absoluteDrift),
      maximumFrameGapMs: Math.max(...frameGapsMs),
      frameGapsOver125Ms: frameGapsMs.filter((gap) => gap > 125).length,
      eventCounts,
      clockSamples,
      offsetMs,
    };
    // Attach the whole window before any assertion, so a failed distribution or
    // stall assertion cannot hide the measurements behind a later good frame.
    await testInfo.attach("mobile-continuous-window", {
      body: JSON.stringify(
        {
          summary,
          authority: authoritative,
          ...observation,
          frameDriftSec,
          frameGapsMs,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(summary.durationMs).toBeGreaterThanOrEqual(35_000);
    expect(observation.samples.length).toBeGreaterThanOrEqual(120);
    expect(summary.frameCount).toBeGreaterThan(850);
    expect(summary.driftP95Sec).toBeLessThan(0.5);
    expect(summary.driftMaxSec).toBeLessThan(0.75);
    expect(summary.maximumFrameGapMs).toBeLessThan(250);
    expect(summary.frameGapsOver125Ms).toBeLessThanOrEqual(1);
    expect(eventCounts.seeking).toBe(0);
    expect(eventCounts.waiting).toBe(0);
    expect(eventCounts.stalled).toBe(0);
    expect(eventCounts.pause).toBe(0);
    expect(eventCounts.ratechange).toBe(0);
    expect(
      observation.samples.every((sample) => sample.playbackRate === 1),
    ).toBe(true);
    expect(
      observation.samples.every(
        (sample) =>
          !sample.paused && !sample.seeking && sample.visibility === "visible",
      ),
    ).toBe(true);
    expect(viewer.evidence.snapshots.at(-1)?.snapshot.revision).toBe(
      authoritative.revision,
    );
    expect(viewer.evidence.pageErrors).toEqual([]);
    expect(host.evidence.pageErrors).toEqual([]);
    await viewer.page.screenshot({
      path: testInfo.outputPath("mobile-continuous-final.png"),
    });
  } finally {
    await attachEvidence(testInfo, "steady-host", host);
    await attachEvidence(testInfo, "steady-mobile-viewer", viewer);
    await closeExistingRoom(host.page).catch(() => undefined);
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
  contextOptions: BrowserContextOptions = {},
): Promise<{ context: BrowserContext; page: Page; evidence: Evidence }> {
  const context = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    ...contextOptions,
  });
  const page = await context.newPage();
  const evidence: Evidence = {
    snapshots: [],
    clocks: [],
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
        if (message.type === "clock.pong") {
          const pong = message.payload as unknown as {
            clientSentAtMs: number;
            serverReceivedAtMs: number;
            serverSentAtMs: number;
          };
          const receivedAtMs = Date.now();
          evidence.clocks.push({
            offsetMs:
              (pong.serverReceivedAtMs -
                pong.clientSentAtMs +
                (pong.serverSentAtMs - receivedAtMs)) /
              2,
            roundTripMs:
              receivedAtMs -
              pong.clientSentAtMs -
              (pong.serverSentAtMs - pong.serverReceivedAtMs),
          });
        }
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
      expectedDisplayAtMs: number;
      paused: boolean;
    }> = [];
    const events: MediaEventObservation[] = [];
    Object.assign(window, {
      __playerGateFrames: frames,
      __playerGateMediaEvents: events,
    });
    const scan = () => {
      for (const video of document.querySelectorAll("video")) {
        if (
          observed.has(video) ||
          typeof video.requestVideoFrameCallback !== "function"
        )
          continue;
        observed.add(video);
        for (const event of [
          "seeking",
          "seeked",
          "waiting",
          "stalled",
          "ratechange",
          "playing",
          "pause",
        ]) {
          video.addEventListener(event, () => {
            events.push({
              event,
              observedAtMs: performance.timeOrigin + performance.now(),
              mediaTime: video.currentTime,
              playbackRate: video.playbackRate,
            });
            if (events.length > 2000) events.splice(0, events.length - 2000);
          });
        }
        const frame = (now: number, metadata: VideoFrameCallbackMetadata) => {
          frames.push({
            mediaTime: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
            observedAtMs: performance.timeOrigin + now,
            expectedDisplayAtMs:
              performance.timeOrigin + metadata.expectedDisplayTime,
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

function quantile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ??
    Number.POSITIVE_INFINITY
  );
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
  // A snapshot's Node-side receive timestamp includes browser/automation event
  // delivery delay and can underestimate a slow startup's real residual. Use
  // independently observed low-RTT clock exchanges, just like the long-window
  // gate, and the frame's expected display timestamp rather than a setter.
  const clocks = evidence.clocks
    .filter(
      (sample) => Number.isFinite(sample.offsetMs) && sample.roundTripMs >= 0,
    )
    .sort((left, right) => left.roundTripMs - right.roundTripMs)
    .slice(0, 3);
  if (clocks.length === 0) return Number.POSITIVE_INFINITY;
  const offsetMs = quantile(
    clocks.map((sample) => sample.offsetMs),
    0.5,
  );
  const serverFrameTime = frame.expectedDisplayAtMs + offsetMs;
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
      const rectangle = video?.getBoundingClientRect();
      const style = video ? getComputedStyle(video) : null;
      return {
        visibility: document.visibilityState,
        layout: {
          focused: document.hasFocus(),
          viewport: [window.innerWidth, window.innerHeight],
          scroll: [window.scrollX, window.scrollY],
          videoRectangle: rectangle
            ? {
                x: rectangle.x,
                y: rectangle.y,
                width: rectangle.width,
                height: rectangle.height,
                top: rectangle.top,
                right: rectangle.right,
                bottom: rectangle.bottom,
                left: rectangle.left,
              }
            : null,
          videoDisplay: style?.display ?? null,
          videoVisibility: style?.visibility ?? null,
          videoOpacity: style?.opacity ?? null,
        },
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
