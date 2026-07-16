import { readFileSync } from "node:fs";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

test("public server supports upload, room admission and two-party voice", async ({
  browser,
  page,
}) => {
  const hostPassword = process.env.SIMPLEWATCH_HOST_PASSWORD;
  const viewerPassword = process.env.SIMPLEWATCH_VIEWER_PASSWORD;
  expect(hostPassword?.length).toBeGreaterThanOrEqual(20);
  expect(viewerPassword?.length).toBeGreaterThanOrEqual(20);

  await page.route("**/admin", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["permissions-policy"];
    await route.fulfill({ response, headers });
  });

  await page.goto("/");
  await page.getByLabel("账户名称").fill("Host");
  await page.getByLabel("账户密码").fill(hostPassword!);
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/auth/login") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /凭证入场/ }).click();
  let { csrfToken: adminCsrfToken } = (await (
    await loginResponsePromise
  ).json()) as { csrfToken: string };
  await expect(
    page.getByRole("heading", { name: "放映控制", exact: true }),
  ).toBeVisible();

  const mediaName = `server-h264-${Date.now()}.mp4`;
  const hevcName = `server-h265-${Date.now()}.mp4`;
  await uploadMp4(page, mediaName, "test-data/generated/media-smoke.mp4");
  const subtitleInput = page.getByLabel(`为 ${mediaName} 添加字幕`);
  await expect(subtitleInput).toBeVisible({ timeout: 30_000 });
  await subtitleInput.setInputFiles("test-data/subtitles/predeploy.vtt");
  await uploadMp4(
    page,
    hevcName,
    "test-data/generated/media-smoke-hevc-hev1.mp4",
  );
  await expect(
    page.locator(".media-row").filter({ hasText: hevcName }),
  ).toContainText("H.265 · 终端相关");

  const roomResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/rooms") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /开启放映室/ }).click();
  const roomResponse = await roomResponsePromise;
  expect(roomResponse.status()).toBe(201);
  const roomId = ((await roomResponse.json()) as { room: { id: string } }).room
    .id;
  let memberContext: BrowserContext | undefined;
  try {
    await page.getByRole("button", { name: "进入主持房间" }).click();
    await expect(page.getByText("主持控制")).toBeVisible();
    await expect(page.getByText("同步在线")).toBeVisible({ timeout: 15_000 });
    await selectVodAndWait(page, mediaName);
    await expect(page.locator("video")).toBeVisible({ timeout: 15_000 });
    await selectVodAndWait(page, hevcName);
    const declaresHevc = await page.evaluate(() => {
      const video = document.createElement("video");
      return Boolean(
        video.canPlayType('video/mp4; codecs="hvc1"') ||
        video.canPlayType('video/mp4; codecs="hev1"'),
      );
    });
    if (!declaresHevc) {
      await expect(page.getByText(/当前浏览器未声明支持/)).toBeVisible();
    } else {
      await expect(page.locator("video")).toBeVisible();
    }
    await selectVodAndWait(page, mediaName);
    const revisionBeforeLive = await roomRevision(page);
    await page.getByRole("button", { name: "切换直播" }).click();
    await expect
      .poll(() => roomRevision(page), { timeout: 15_000 })
      .toBeGreaterThan(revisionBeforeLive);
    await expect(page.getByText("LIVE / 等待 OBS")).toBeVisible();
    const publishConfig = page.locator(".publish-config code");
    await expect(publishConfig).toHaveCount(2);
    await expect(publishConfig.first()).toHaveText(
      /^https:\/\/8\.134\.239\.34\/program\/[a-z0-9_-]+\/whip$/,
    );
    await expect(publishConfig.nth(1)).not.toHaveText("");
    const whipResult = await publishWhipFromBrowser(
      page,
      (await publishConfig.first().textContent())!,
      (await publishConfig.nth(1).textContent())!,
    );
    expect(whipResult.status).toBe(201);
    expect(whipResult.connected).toBe(true);
    expect(whipResult.codecs, JSON.stringify(whipResult.diagnostics)).toContain(
      "audio/opus",
    );
    expect(whipResult.codecs, JSON.stringify(whipResult.diagnostics)).toContain(
      "video/H264",
    );
    await expect(page.getByText("LIVE / 信号在线")).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(
        () =>
          page.evaluate(async (activeRoomId) => {
            const response = await fetch(
              `/api/v1/rooms/${activeRoomId}/live/status`,
              { credentials: "same-origin" },
            );
            const status = (await response.json()) as {
              sourceBitrateMbps: number | null;
            };
            return status.sourceBitrateMbps ?? 0;
          }, roomId),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    memberContext = await browser.newContext({ ignoreHTTPSErrors: false });
    const member = await memberContext.newPage();
    await member.goto("/");
    await member.getByLabel("账户名称").fill("Simple");
    await member.getByLabel("账户密码").fill(viewerPassword!);
    await member.getByRole("button", { name: /凭证入场/ }).click();
    await expect(member.getByText("同场观众")).toBeVisible();
    await expect(member.getByRole("button", { name: /播放|暂停/ })).toHaveCount(
      0,
    );
    await member.getByRole("button", { name: "启用节目声音" }).click();
    await expect
      .poll(
        () =>
          member.locator("video").evaluate((element) => {
            const stream = (element as HTMLVideoElement).srcObject;
            return stream instanceof MediaStream
              ? stream
                  .getTracks()
                  .map((track) => track.kind)
                  .sort()
              : [];
          }),
        { timeout: 20_000 },
      )
      .toEqual(["audio", "video"]);
    await expect
      .poll(
        () =>
          member.evaluate(() => {
            const raw = sessionStorage.getItem("simplewatch.live-diagnostics");
            if (!raw) return 0;
            return Number(
              (JSON.parse(raw) as { bitrateMbps?: number }).bitrateMbps ?? 0,
            );
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    if (process.env.SIMPLEWATCH_SKIP_RTC !== "true") {
      await page.getByRole("button", { name: "加入语音通话" }).click();
      await member.getByRole("button", { name: "加入语音通话" }).click();
      await expect(page.getByText("麦克风已接通")).toBeVisible({
        timeout: 30_000,
      });
      await expect(member.getByText("麦克风已接通")).toBeVisible({
        timeout: 30_000,
      });
    }
    const monitor = await page.context().newPage();
    await monitor.goto("/admin");
    await expect(
      monitor.getByText("OBS 直播", { exact: true }).first(),
    ).toBeVisible();
    await expect(monitor.getByText("2 / 5")).toBeVisible();
    await expect(monitor.getByText("推流在线")).toBeVisible({
      timeout: 15_000,
    });
    await stopWhipFromBrowser(page);
    monitor.once("dialog", (dialog) => dialog.accept());
    await monitor.getByRole("button", { name: "强制关闭房间" }).click();
    await expect(
      monitor.getByText("房间已强制关闭，所有成员凭据均已撤销"),
    ).toBeVisible();
    const revokedStatus = await member.evaluate(async (activeRoomId) => {
      const response = await fetch(`/api/v1/rooms/${activeRoomId}/bootstrap`, {
        credentials: "same-origin",
      });
      return response.status;
    }, roomId);
    expect(revokedStatus).toBe(401);
    await monitor.close();
  } finally {
    await stopWhipFromBrowser(page);
    await memberContext?.close();
    adminCsrfToken = await page.evaluate(async (fallback) => {
      const response = await fetch("/api/v1/auth/session", {
        credentials: "same-origin",
      });
      if (!response.ok) return fallback;
      return ((await response.json()) as { csrfToken: string }).csrfToken;
    }, adminCsrfToken);
    await page.evaluate(
      async ({ roomId, csrfToken }) => {
        const response = await fetch(`/api/v1/rooms/${roomId}`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({ close: true }),
        });
        if (!response.ok && response.status !== 404)
          throw new Error(`关闭测试房间失败：${response.status}`);
      },
      { roomId, csrfToken: adminCsrfToken },
    );
    await cleanupMediaRows(page, hostPassword!, adminCsrfToken, [
      mediaName,
      hevcName,
    ]);
  }
});

test("public upload reports speed and can be cancelled", async ({ page }) => {
  const hostPassword = process.env.SIMPLEWATCH_HOST_PASSWORD;
  expect(hostPassword?.length).toBeGreaterThanOrEqual(20);
  await page.goto("/");
  await page.getByLabel("账户名称").fill("Host");
  await page.getByLabel("账户密码").fill(hostPassword!);
  await page.getByRole("button", { name: /凭证入场/ }).click();
  await expect(
    page.getByRole("heading", { name: "放映控制", exact: true }),
  ).toBeVisible();

  await page
    .locator('input[type="file"][accept*="video/"]')
    .first()
    .setInputFiles({
      name: `cancel-${Date.now()}.mp4`,
      mimeType: "video/mp4",
      buffer: Buffer.alloc(48 * 1024 * 1024, 0x41),
    });
  await expect(page.locator("progress")).toBeVisible();
  await expect(page.getByText(/(?:KB|MB)\/s/)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "终止本条上传" }).click();
  await expect(page.getByText("本条上传已终止，临时数据已清理")).toBeVisible({
    timeout: 15_000,
  });
});

async function uploadMp4(page: Page, name: string, path: string) {
  await page
    .locator('input[type="file"][accept*="video/"]')
    .first()
    .setInputFiles({
      name,
      mimeType: "video/mp4",
      buffer: readFileSync(path),
    });
  const row = page.locator(".media-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("可放映", { timeout: 30_000 });
}

async function cleanupMediaRows(
  page: Page,
  password: string,
  initialCsrfToken: string,
  names: string[],
) {
  await page.goto("/admin");
  const login = page.getByLabel("账户密码");
  let csrfToken = initialCsrfToken;
  if (await login.isVisible()) {
    await page.getByLabel("账户名称").fill("Host");
    await login.fill(password);
    const loginResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/auth/login") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /凭证入场/ }).click();
    csrfToken = (
      (await (await loginResponsePromise).json()) as { csrfToken: string }
    ).csrfToken;
  }
  await expect(
    page.getByRole("heading", { name: "放映控制", exact: true }),
  ).toBeVisible();
  csrfToken = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/session", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`恢复Host会话失败：${response.status}`);
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  });
  await page.evaluate(
    async ({ names, csrfToken }) => {
      const list = async () => {
        const response = await fetch("/api/v1/media", {
          credentials: "same-origin",
        });
        if (!response.ok)
          throw new Error(`读取测试媒体失败：${response.status}`);
        return (await response.json()) as Array<{
          id: string;
          displayName: string;
        }>;
      };
      for (const item of (await list()).filter((candidate) =>
        names.includes(candidate.displayName),
      )) {
        const response = await fetch(`/api/v1/admin/media/${item.id}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "x-csrf-token": csrfToken },
        });
        if (!response.ok && response.status !== 404)
          throw new Error(`清理测试媒体失败：${response.status}`);
      }
      const remaining = (await list()).filter((candidate) =>
        names.includes(candidate.displayName),
      );
      if (remaining.length > 0)
        throw new Error(
          `测试媒体未清理：${remaining.map((item) => item.displayName).join(", ")}`,
        );
    },
    { names, csrfToken },
  );
}

async function roomRevision(page: Page): Promise<number> {
  const label = await page.locator(".screen-meta span").nth(1).textContent();
  return Number(label?.replace(/\D/g, "") ?? 0);
}

async function selectVodAndWait(page: Page, label: string) {
  const previousRevision = await roomRevision(page);
  await page.getByLabel("选择点播影片").selectOption({ label });
  await expect
    .poll(() => roomRevision(page), { timeout: 15_000 })
    .toBeGreaterThan(previousRevision);
}

async function publishWhipFromBrowser(page: Page, url: string, token: string) {
  return page.evaluate(
    async ({ url, token }) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("Fake camera produced no video track");
      videoTrack.contentHint = "motion";
      const peer = new RTCPeerConnection({ sdpSemantics: "unified-plan" });
      for (const track of stream.getTracks()) {
        const sender = peer.addTrack(track, stream);
        if (track.kind === "video") {
          const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
          const h264 = codecs.filter((codec) =>
            codec.mimeType.toLowerCase().includes("h264"),
          );
          if (h264.length === 0)
            throw new Error("Chrome does not expose an H264 encoder");
          const transceiver = peer
            .getTransceivers()
            .find((candidate) => candidate.sender === sender);
          if (!transceiver)
            throw new Error("Video transceiver was not created");
          transceiver.setCodecPreferences(h264);
        }
      }
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error("WHIP ICE gathering timeout")),
            15_000,
          );
          peer.addEventListener("icegatheringstatechange", () => {
            if (peer.iceGatheringState === "complete") {
              window.clearTimeout(timeout);
              resolve();
            }
          });
        });
      }
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/sdp",
        },
        body: peer.localDescription?.sdp ?? "",
      });
      if (!response.ok) throw new Error(`WHIP HTTP ${response.status}`);
      const location = response.headers.get("location");
      const answerSdp = await response.text();
      await peer.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
      const connected = await new Promise<boolean>((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), 20_000);
        const inspect = () => {
          if (peer.connectionState === "connected") {
            window.clearTimeout(timeout);
            resolve(true);
          }
        };
        peer.addEventListener("connectionstatechange", inspect);
        inspect();
      });
      const waitForOutboundMedia = async (
        timeoutMs: number,
      ): Promise<RTCStatsReport> => {
        const deadline = Date.now() + timeoutMs;
        let latest = await peer.getStats();
        while (Date.now() < deadline) {
          const mediaWithPackets = new Set<string>();
          latest.forEach((report: unknown) => {
            if (
              report &&
              typeof report === "object" &&
              "type" in report &&
              report.type === "outbound-rtp" &&
              "packetsSent" in report &&
              typeof report.packetsSent === "number" &&
              report.packetsSent > 0
            ) {
              if ("kind" in report && typeof report.kind === "string")
                mediaWithPackets.add(report.kind);
              else if (
                "mediaType" in report &&
                typeof report.mediaType === "string"
              )
                mediaWithPackets.add(report.mediaType);
            }
          });
          if (mediaWithPackets.has("audio") && mediaWithPackets.has("video"))
            return latest;
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          latest = await peer.getStats();
        }
        return latest;
      };
      const stats = await waitForOutboundMedia(10_000);
      const codecs: string[] = [];
      const outbound: Array<{
        kind: string | undefined;
        packetsSent: number | undefined;
        bytesSent: number | undefined;
        codecId: string | undefined;
      }> = [];
      stats.forEach((report: unknown) => {
        if (
          report &&
          typeof report === "object" &&
          "type" in report &&
          "mimeType" in report &&
          report.type === "codec" &&
          typeof report.mimeType === "string"
        ) {
          codecs.push(report.mimeType);
        }
        if (
          report &&
          typeof report === "object" &&
          "type" in report &&
          report.type === "outbound-rtp"
        ) {
          outbound.push({
            kind:
              "kind" in report && typeof report.kind === "string"
                ? report.kind
                : undefined,
            packetsSent:
              "packetsSent" in report && typeof report.packetsSent === "number"
                ? report.packetsSent
                : undefined,
            bytesSent:
              "bytesSent" in report && typeof report.bytesSent === "number"
                ? report.bytesSent
                : undefined,
            codecId:
              "codecId" in report && typeof report.codecId === "string"
                ? report.codecId
                : undefined,
          });
        }
      });
      const diagnostics = {
        offerVideo: peer.localDescription?.sdp.match(/^m=video.*$/m)?.[0],
        answerVideo: answerSdp.match(/^m=video.*$/m)?.[0],
        offerH264: peer.localDescription?.sdp.match(
          /^a=rtpmap:\d+ H264\/90000$/m,
        )?.[0],
        answerH264: answerSdp.match(/^a=rtpmap:\d+ H264\/90000$/m)?.[0],
        transceivers: peer.getTransceivers().map((transceiver) => ({
          kind: transceiver.sender.track?.kind,
          currentDirection: transceiver.currentDirection,
        })),
        videoTrack: stream.getVideoTracks()[0]?.getSettings(),
        outbound,
      };
      (
        window as typeof window & {
          __simpleWatchWhipTest?: {
            peer: RTCPeerConnection;
            stream: MediaStream;
            location: string | null;
            url: string;
            token: string;
          };
        }
      ).__simpleWatchWhipTest = {
        peer,
        stream,
        location,
        url,
        token,
      };
      return {
        status: response.status,
        connected,
        codecs,
        diagnostics,
      };
    },
    { url, token },
  );
}

async function stopWhipFromBrowser(page: Page) {
  await page.evaluate(async () => {
    const testWindow = window as typeof window & {
      __simpleWatchWhipTest?: {
        peer: RTCPeerConnection;
        stream: MediaStream;
        location: string | null;
        url: string;
        token: string;
      };
    };
    const active = testWindow.__simpleWatchWhipTest;
    if (!active) return;
    active.peer.close();
    for (const track of active.stream.getTracks()) track.stop();
    if (active.location) {
      await fetch(new URL(active.location, active.url), {
        method: "DELETE",
        headers: { authorization: `Bearer ${active.token}` },
      }).catch(() => undefined);
    }
    delete testWindow.__simpleWatchWhipTest;
  });
}
