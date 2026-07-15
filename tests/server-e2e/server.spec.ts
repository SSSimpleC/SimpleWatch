import { readFileSync } from "node:fs";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

test("public server supports upload, room admission and two-party voice", async ({
  browser,
  page,
}) => {
  const code = process.env.SIMPLEWATCH_ADMIN_CODE;
  expect(code).toMatch(/^\d{6}$/);

  await page.goto("/admin");
  await page.getByLabel("6 位放映口令").fill(code!);
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/admin/login") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "解锁控制台" }).click();
  const { csrfToken: adminCsrfToken } = (await (
    await loginResponsePromise
  ).json()) as { csrfToken: string };
  await expect(page.getByRole("heading", { name: "放映控制" })).toBeVisible();

  const mediaName = `server-media-${Date.now()}.mp4`;
  await page.locator('input[type="file"][accept="video/mp4"]').setInputFiles({
    name: mediaName,
    mimeType: "video/mp4",
    buffer: readFileSync("test-data/generated/media-smoke.mp4"),
  });
  await expect(page.getByText(/上传完成|正在检查兼容性/)).toBeVisible({
    timeout: 30_000,
  });
  const subtitleInput = page.getByLabel(`为 ${mediaName} 添加字幕`);
  await expect(subtitleInput).toBeVisible({ timeout: 30_000 });
  await subtitleInput.setInputFiles("test-data/subtitles/predeploy.vtt");

  await page.getByLabel("主持人昵称").fill("Server Host");
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
    const inviteUrl = await page.locator(".invite-copy code").textContent();
    expect(inviteUrl).toBeTruthy();
    await page.getByRole("button", { name: "进入主持房间" }).click();
    await expect(page.getByText("主持控制")).toBeVisible();
    await expect(page.getByText("同步在线")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("选择点播影片").selectOption({ label: mediaName });
    await expect(page.locator("video")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "生成 OBS 配置" }).click();
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
    memberContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const member = await memberContext.newPage();
    await member.goto(inviteUrl!);
    await member.getByLabel("昵称").fill("Server Member");
    await member.getByRole("button", { name: "进入放映室" }).click();
    await expect(member.getByText("同场观众")).toBeVisible();
    await expect(
      member.getByRole("button", { name: /播放|暂停/ }),
    ).toBeDisabled();

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
  } finally {
    await memberContext?.close();
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
        if (!response.ok)
          throw new Error(`关闭测试房间失败：${response.status}`);
      },
      { roomId, csrfToken: adminCsrfToken },
    );
  }
});

async function publishWhipFromBrowser(page: Page, url: string, token: string) {
  return page.evaluate(
    async ({ url, token }) => {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable");
      let frame = 0;
      const drawFrame = () => {
        context.fillStyle = frame % 2 === 0 ? "#0b1f33" : "#123c5a";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        context.font = "32px sans-serif";
        context.fillText(`SimpleWatch WHIP ${frame++}`, 40, 190);
      };
      drawFrame();
      const frameTimer = window.setInterval(drawFrame, 100);
      const videoStream = canvas.captureStream(10);
      const stream = new MediaStream([
        ...audioStream.getAudioTracks(),
        ...videoStream.getVideoTracks(),
      ]);
      const peer = new RTCPeerConnection();
      for (const track of stream.getTracks()) {
        const transceiver = peer.addTransceiver(track, {
          direction: "sendonly",
        });
        if (track.kind === "video") {
          const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
          const h264 = codecs.filter((codec) =>
            codec.mimeType.toLowerCase().includes("h264"),
          );
          if (h264.length === 0)
            throw new Error("Chrome does not expose an H264 encoder");
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
        body: peer.localDescription?.sdp,
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
      };
      peer.close();
      window.clearInterval(frameTimer);
      for (const track of stream.getTracks()) track.stop();
      if (location)
        await fetch(new URL(location, url), {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
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
