import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const mediaBody = readFileSync(
  resolve(process.env.FOCUSED_MEDIA_FILE ?? "test-data/generated/sync-60s.mp4"),
);
let mediaServer: Server;
let mediaUrl: string;

test.beforeAll(async () => {
  mediaServer = createServer((request, response) => {
    if (request.url !== "/sync.mp4") {
      response.writeHead(404).end();
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const requestedEnd = match?.[2] ? Number(match[2]) : mediaBody.length - 1;
    const end = Math.min(requestedEnd, mediaBody.length - 1);
    const body = mediaBody.subarray(start, end + 1);
    response.writeHead(match ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Content-Type": "video/mp4",
      "Content-Length": String(body.length),
      ...(match
        ? { "Content-Range": `bytes ${start}-${end}/${mediaBody.length}` }
        : {}),
    });
    response.end(body);
  });
  await new Promise<void>((resolveListen) =>
    mediaServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = mediaServer.address() as AddressInfo;
  mediaUrl = `http://127.0.0.1:${address.port}/sync.mp4`;
});

test.afterAll(
  async () =>
    new Promise<void>((resolveClose, reject) =>
      mediaServer.close((error) => (error ? reject(error) : resolveClose())),
    ),
);

test("clock-skewed viewers converge after play, seek and a locally ignored seek", async ({
  browser,
}) => {
  const hostContext = await createClockContext(browser, 5_000);
  const earlyContext = await createClockContext(browser, -5_000);
  const lateContext = await createClockContext(browser, 3_500);
  const host = await hostContext.newPage();
  const early = await earlyContext.newPage();
  const late = await lateContext.newPage();

  await host.goto("/admin");
  await host.getByLabel("6 位放映口令").fill("260713");
  await host.getByRole("button", { name: "解锁控制台" }).click();
  await ensureNoActiveRoom(host);
  await host.getByLabel("主持人昵称").fill("Sync Host");
  await host.getByRole("button", { name: /开启放映室/ }).click();
  const inviteUrl = await host.locator(".invite-copy code").textContent();
  expect(inviteUrl).toBeTruthy();
  await host.getByRole("button", { name: "进入主持房间" }).click();
  await host.getByLabel("选择点播影片").selectOption({ label: "sync-60s.mp4" });

  await joinViewer(early, inviteUrl!, "Early Clock");
  await joinViewer(late, inviteUrl!, "Late Clock");
  for (const page of [host, early, late]) await loadTestMedia(page);
  for (const page of [host, early, late])
    await page.getByRole("button", { name: "启用节目声音" }).click();

  await host.getByRole("button", { name: /播放/ }).click();
  await expect
    .poll(() => spreadSeconds([host, early, late]), { timeout: 5_000 })
    .toBeLessThan(1);

  const progress = host.getByRole("slider", { name: "播放进度" });
  await progress.fill("20");
  await progress.dispatchEvent("pointerup");
  await expect
    .poll(() => minimumPosition([host, early, late]), { timeout: 5_000 })
    .toBeGreaterThan(19);
  await expect
    .poll(() => spreadSeconds([host, early, late]), { timeout: 5_000 })
    .toBeLessThan(1);

  await early.locator("video").evaluate((video: HTMLVideoElement) => {
    video.currentTime = 0;
  });
  await expect
    .poll(() => spreadSeconds([host, early, late]), { timeout: 3_000 })
    .toBeLessThan(1);
  await expect(early.getByText(/SYNC .* ms/)).toBeVisible();

  host.once("dialog", (dialog) => void dialog.accept());
  await host.getByRole("button", { name: "关闭房间" }).click();
  await expect(host).toHaveURL(/\/admin$/);

  await hostContext.close();
  await earlyContext.close();
  await lateContext.close();
});

test("live mode automatically reveals stable OBS config and viewer display controls", async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const host = await hostContext.newPage();
  const viewer = await viewerContext.newPage();
  await host.goto("/admin");
  await host.getByLabel("6 位放映口令").fill("260713");
  await host.getByRole("button", { name: "解锁控制台" }).click();
  await ensureNoActiveRoom(host);
  await host.getByLabel("主持人昵称").fill("Live Host");
  await host.getByRole("button", { name: /开启放映室/ }).click();
  const inviteUrl = await host.locator(".invite-copy code").textContent();
  await host.getByRole("button", { name: "进入主持房间" }).click();
  await joinViewer(viewer, inviteUrl!, "Live Viewer");

  await host.getByRole("button", { name: "切换直播" }).click();
  await expect(host.locator(".publish-config code")).toHaveCount(2);
  await expect(
    host.getByRole("button", { name: "生成 OBS 配置", exact: true }),
  ).toHaveCount(0);
  await expect(
    host.getByRole("button", { name: "重新生成 OBS 配置" }),
  ).toBeVisible();
  await expect(viewer.getByRole("button", { name: "屏幕全屏" })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "网页全屏" })).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "重新连接节目" }),
  ).toBeVisible();

  await hostContext.close();
  await viewerContext.close();
});

async function createClockContext(
  browser: Browser,
  offsetMs: number,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript((offset: number) => {
    const actualNow = Date.now.bind(Date);
    Date.now = () => actualNow() + offset;
  }, offsetMs);
  return context;
}

async function loadTestMedia(page: Page) {
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await video.evaluate((element: HTMLVideoElement, source) => {
    element.src = source;
    element.load();
  }, mediaUrl);
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThan(0);
}

async function ensureNoActiveRoom(page: Page) {
  const hostNickname = page.getByLabel("主持人昵称");
  const closeButton = page.getByRole("button", { name: "强制关闭房间" });
  await expect(hostNickname.or(closeButton)).toBeVisible();
  if (await hostNickname.isVisible()) return;
  page.once("dialog", (dialog) => void dialog.accept());
  await closeButton.click();
  await expect(hostNickname).toBeVisible();
}

async function joinViewer(page: Page, inviteUrl: string, nickname: string) {
  await page.goto(inviteUrl);
  await page.getByLabel("昵称").fill(nickname);
  await page.getByRole("button", { name: "进入放映室" }).click();
  await expect(page.getByText("同场观众")).toBeVisible();
}

async function positions(pages: Page[]): Promise<number[]> {
  return Promise.all(
    pages.map((page) =>
      page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.currentTime),
    ),
  );
}

async function spreadSeconds(pages: Page[]): Promise<number> {
  const values = await positions(pages);
  return Math.max(...values) - Math.min(...values);
}

async function minimumPosition(pages: Page[]): Promise<number> {
  return Math.min(...(await positions(pages)));
}
