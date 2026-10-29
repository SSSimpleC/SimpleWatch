import { expect, test } from "@playwright/test";

test("a late authenticated restore cannot resurrect a cross-tab logged-out account", async ({
  page,
}) => {
  let release!: () => void;
  let started!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/v1/auth/session", async (route) => {
    started();
    await paused;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        account: {
          id: "019fa000-0000-7000-8000-000000000001",
          username: "Simple",
          role: "viewer",
        },
        csrfToken: "test-only-csrf",
        idleExpiresAt: "2030-01-01T00:00:00Z",
        absoluteExpiresAt: "2030-01-01T00:00:00Z",
        destination: {
          state: "waiting",
          reason: "no-room",
          roomId: null,
          position: null,
        },
      }),
    });
  });
  await page.goto("/");
  await requested;
  await page.evaluate(() => {
    const channel = new BroadcastChannel("simplewatch:session-lifecycle.v1");
    channel.postMessage({ type: "logout", version: 1 });
    channel.close();
  });
  release();
  await expect(page.getByLabel("账户名称")).toBeVisible();
  await expect(
    page.getByText("SEAT / Simple", { exact: true }),
  ).not.toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

for (const outcome of ["success", "failure"] as const) {
  test(`a late takeover ${outcome} cannot navigate or change login UI after logout`, async ({
    page,
  }) => {
    let release!: () => void;
    let started!: () => void;
    let unexpectedBootstraps = 0;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const roomId = "019fa000-0000-7000-8000-000000000010";
    const memberId = "019fa000-0000-7000-8000-000000000011";
    await page.route("**/api/v1/auth/session", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          account: {
            id: "019fa000-0000-7000-8000-000000000001",
            username: "Simple",
            role: "viewer",
          },
          csrfToken: "test-only-csrf",
          idleExpiresAt: "2030-01-01T00:00:00Z",
          absoluteExpiresAt: "2030-01-01T00:00:00Z",
          destination: { state: "taken-over", roomId, memberId },
        }),
      }),
    );
    await page.route("**/api/v1/room/takeover", async (route) => {
      started();
      await paused;
      await route.fulfill({
        status: outcome === "success" ? 200 : 500,
        contentType: "application/json",
        body: JSON.stringify(
          outcome === "success"
            ? {
                state: "room",
                roomId,
                memberId,
                nickname: "Simple",
                role: "member",
                tookOver: true,
              }
            : {
                error: {
                  code: "TEST_LATE_FAILURE",
                  message: "迟到接管错误不应进入登录页",
                },
              },
        ),
      });
    });
    await page.route("**/api/v1/rooms/*/bootstrap", (route) => {
      unexpectedBootstraps += 1;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAUTHORIZED" } }),
      });
    });
    await page.route("**/api/v1/auth/logout", (route) =>
      route.fulfill({ status: 204 }),
    );

    await page.goto("/", { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "在本设备接管席位", exact: true })
      .click();
    await requested;
    await page.getByRole("button", { name: "退出账户", exact: true }).click();
    await expect(page.getByLabel("账户名称")).toBeVisible();
    const response = page.waitForResponse((value) =>
      value.url().endsWith("/api/v1/room/takeover"),
    );
    release();
    await response;
    // Let the fetch continuation and React commit run before asserting no stale effect.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByLabel("账户名称")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "凭证入场 →", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("body")).not.toContainText(
      "迟到接管错误不应进入登录页",
    );
    expect(unexpectedBootstraps).toBe(0);
  });
}
