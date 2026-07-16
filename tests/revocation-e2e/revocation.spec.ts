import { expect, request as apiRequest, test } from "@playwright/test";

const apiOrigin = "http://127.0.0.1:13900";
const browserOrigin = "http://127.0.0.1:18080";

test("a kicked member is removed from real LiveKit and cannot reuse the token", async ({
  browser,
}) => {
  // Arrange
  const hostApi = await apiRequest.newContext({ baseURL: apiOrigin });
  const memberApi = await apiRequest.newContext({ baseURL: apiOrigin });
  const memberBrowser = await browser.newContext({
    permissions: ["microphone"],
  });
  const page = await memberBrowser.newPage();
  try {
    const login = await hostApi.post("/api/v1/auth/login", {
      headers: { origin: browserOrigin },
      data: { username: "Host", password: "rtc-host-password-24-characters" },
    });
    expect(login.status()).toBe(200);
    const adminCsrf = (await login.json()) as { csrfToken: string };
    const adminCookie = login.headers()["set-cookie"]?.split(";", 1)[0];
    expect(adminCookie).toBeTruthy();
    const created = await hostApi.post("/api/v1/rooms", {
      headers: {
        origin: browserOrigin,
        "x-csrf-token": adminCsrf.csrfToken,
        cookie: adminCookie ?? "",
      },
      data: {},
    });
    expect(created.status()).toBe(201);
    const room = (await created.json()) as {
      room: { id: string };
      csrfToken: string;
    };
    const hostRoomCookie = adminCookie;
    const joined = await memberApi.post("/api/v1/auth/login", {
      headers: { origin: browserOrigin },
      data: {
        username: "Simple",
        password: "rtc-viewer-password-24-chars",
      },
    });
    expect(joined.status()).toBe(200);
    const member = (await joined.json()) as {
      destination: { memberId: string };
      csrfToken: string;
    };
    const memberCookie = joined.headers()["set-cookie"]?.split(";", 1)[0];
    expect(memberCookie).toBeTruthy();
    const credential = await memberApi.post(
      `/api/v1/rooms/${room.room.id}/credentials`,
      {
        headers: {
          origin: browserOrigin,
          "x-csrf-token": member.csrfToken,
          cookie: memberCookie ?? "",
        },
        data: { purpose: "voice" },
      },
    );
    expect(credential.status()).toBe(200);
    const voice = (await credential.json()) as { url: string; token: string };

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.addScriptTag({
      type: "module",
      content:
        "import * as harness from '/src/rtc-smoke.ts'; window.rtcHarness = harness;",
    });
    await page.waitForFunction(() => "rtcHarness" in window);
    await page.evaluate(
      async ({ url, token }) =>
        (
          window as unknown as {
            rtcHarness: {
              connectFakeParticipant(url: string, token: string): Promise<void>;
            };
          }
        ).rtcHarness.connectFakeParticipant(url, token),
      voice,
    );

    // Act
    const kicked = await hostApi.post(
      `/api/v1/rooms/${room.room.id}/members/${member.destination.memberId}/kick`,
      {
        headers: {
          origin: browserOrigin,
          "x-csrf-token": room.csrfToken,
          cookie: hostRoomCookie ?? "",
        },
        data: { reason: "revocation e2e" },
      },
    );

    // Assert
    expect(kicked.status()).toBe(200);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              window as unknown as {
                rtcHarness: { connectionState(): string };
              }
            ).rtcHarness.connectionState(),
          ),
        { timeout: 20_000 },
      )
      .toBe("disconnected");
    await page.evaluate(async ({ url, token }) => {
      try {
        await (
          window as unknown as {
            rtcHarness: {
              connectFakeParticipant(
                candidateUrl: string,
                candidateToken: string,
              ): Promise<void>;
            };
          }
        ).rtcHarness.connectFakeParticipant(url, token);
      } catch {
        // Self-hosted LiveKit does not provide token blocklisting. A short
        // transient reconnect is acceptable only if reconciliation removes it.
      }
    }, voice);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              window as unknown as {
                rtcHarness: { connectionState(): string };
              }
            ).rtcHarness.connectionState(),
          ),
        { timeout: 20_000 },
      )
      .toBe("disconnected");

    await expect
      .poll(async () => {
        const claim = await hostApi.post("/api/v1/internal/outbox/claim", {
          headers: {
            "x-internal-token":
              "rtc-predeploy-internal-token-at-least-32-bytes",
          },
          data: { workerId: "e2e-observer" },
        });
        return claim.status();
      })
      .toBe(204);
  } finally {
    await memberBrowser.close();
    await memberApi.dispose();
    await hostApi.dispose();
  }
});
