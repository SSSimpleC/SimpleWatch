import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const artifacts = resolve("artifacts/predeploy/latest");
mkdirSync(artifacts, { recursive: true });

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`fixed-account admission renders without overflow on ${viewport.name}`, async ({
    page,
  }) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.route("**/api/v1/auth/session", (route) =>
      route.fulfill({
        status: 204,
      }),
    );
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: /入场凭证/ })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: resolve(artifacts, `account-login-${viewport.name}.png`),
      fullPage: true,
    });
    await expect(page.getByLabel("账户名称")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    await expect(page.getByLabel("账户密码")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(browserErrors).toEqual([]);
  });
}

test("settings persist local audio preferences and diagnostics stay redacted", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "声音与设备" })).toBeVisible();
  await page.getByRole("slider", { name: "节目音量" }).fill("42");
  await page.getByRole("slider", { name: "通话音量" }).fill("67");
  await page.getByLabel("按键说话").check();
  await page.reload();
  await expect(page.getByRole("slider", { name: "节目音量" })).toHaveValue(
    "42",
  );
  await expect(page.getByRole("slider", { name: "通话音量" })).toHaveValue(
    "67",
  );
  await expect(page.getByLabel("按键说话")).toBeChecked();

  await page.goto("/diagnostics");
  await expect(page.getByRole("heading", { name: "连接诊断" })).toBeVisible();
  await expect(page.getByText(/不包含 Cookie、JWT、房间密码/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    /__Host-sw_session|sw_admin|sw_room|Bearer /,
  );
});

test("Host shell exposes real Edge workspaces without overflowing at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await mockHostConsole(page);
  await page.goto("/admin", { waitUntil: "networkidle" });

  await expect(
    page.getByRole("heading", { name: "放映控制", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "管理控制台分区" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "节目单" })).toBeVisible();

  for (const section of ["家庭片库", "云端片库", "传输", "系统"]) {
    await page.getByRole("link", { name: new RegExp(section) }).click();
    await expect(
      page.getByRole("heading", { name: section }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
    if (section === "家庭片库") {
      const scanButton = page.getByRole("button", { name: "立即刷新目录" });
      await expect(scanButton).toBeVisible();
      await scanButton.click();
      await expect(
        page.getByText(/目录刷新已排队；Agent 将主动领取/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "等待扫描完成" }),
      ).toBeDisabled();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        ),
      ).toBe(false);
    }
  }
});

test("switching from Host to Viewer removes Edge information and stops admin requests", async ({
  page,
}) => {
  let loggedOut = false;
  let edgeRequests = 0;
  let scanRequests = 0;
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill(
      loggedOut
        ? { status: 401, contentType: "application/json", body: unauthorized() }
        : { status: 200, contentType: "application/json", body: hostSession() },
    ),
  );
  await page.route("**/api/v1/auth/logout", (route) => {
    loggedOut = true;
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/auth/login", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        account: { id: accountId(2), username: "Simple", role: "viewer" },
        csrfToken: "viewer-csrf",
        idleExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        destination: {
          state: "waiting",
          reason: "no-room",
          roomId: null,
          position: 1,
        },
      }),
    }),
  );
  await page.route("**/api/v1/lobby/events", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  await page.route("**/api/v1/admin/events", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  await page.route("**/api/v1/admin/program", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }),
  );
  await page.route("**/api/v1/admin/edge/**", (route) => {
    edgeRequests += 1;
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/catalog/refresh")) {
      scanRequests += 1;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          agent: edgeAgentSummary(),
          task: {
            id: accountId(7),
            state: "queued",
            deduplicated: false,
          },
        }),
      });
    }
    if (pathname.endsWith("/catalog")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: accountId(3),
              versionId: accountId(4),
              relativePath: "Private/Edge Secret Film.mkv",
              displayName: "Edge Secret Film",
              bytes: 1024,
              mtimeMs: 1,
              sourceState: "present",
              cloudState: "not-requested",
              sha256: null,
            },
          ],
          nextCursor: null,
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
  await page.goto("/admin?view=home-library", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Edge Secret Film" }),
  ).toBeVisible();
  const beforeViewer = edgeRequests;

  await page.getByRole("button", { name: "退出账户" }).click();
  await expect(page.getByLabel("账户名称")).toBeVisible();
  await page.getByLabel("账户名称").fill("Simple");
  await page.getByLabel("账户密码").fill("viewer-password");
  await page.getByRole("button", { name: /凭证入场/ }).click();

  await expect(page.getByText("放映室尚未开放")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Edge Secret Film");
  expect(edgeRequests).toBe(beforeViewer);
  expect(scanRequests).toBe(0);
});

async function mockHostConsole(page: Page) {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: hostSession(),
    }),
  );
  await page.route("**/api/v1/admin/active-room", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }),
  );
  await page.route("**/api/v1/media", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/v1/admin/program", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }),
  );
  await page.route("**/api/v1/admin/events", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  await page.route("**/api/v1/admin/edge/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/catalog/refresh")) {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      expect(route.request().headers()["x-csrf-token"]).toBe("host-csrf");
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          agent: edgeAgentSummary(),
          task: {
            id: accountId(7),
            state: "queued",
            deduplicated: false,
          },
        }),
      });
    }
    const body = pathname.endsWith("/catalog")
      ? JSON.stringify({ items: [], nextCursor: null })
      : pathname.endsWith("/summary")
        ? JSON.stringify({
            agents: [edgeAgentSummary()],
            storage: {
              capacityBytes: 50 * 1024 ** 3,
              freeBytes: 30 * 1024 ** 3,
              reservedBytes: 0,
              safetyFloorBytes: 12 * 1024 ** 3,
              permanentMediaBytes: 5 * 1024 ** 3,
              edgeCacheBytes: 0,
              inFlightBytes: 0,
            },
          })
        : "[]";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body,
    });
  });
}

function hostSession() {
  return JSON.stringify({
    account: { id: accountId(1), username: "Host", role: "host" },
    csrfToken: "host-csrf",
    idleExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    destination: { state: "admin" },
  });
}

function unauthorized() {
  return JSON.stringify({
    error: { code: "UNAUTHORIZED", message: "请登录", requestId: "test" },
  });
}

function edgeAgentSummary() {
  return {
    id: accountId(6),
    displayName: "SimpleServer",
    state: "online",
    protocolVersion: 1,
    softwareVersion: "0.1.0",
    lastSeenAt: new Date().toISOString(),
    lastCompleteScanAt: null,
    catalogItemCount: 0,
    credentialExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    credentialExpiringSoon: false,
  };
}

function accountId(suffix: number) {
  return `019f6555-77a3-753c-bbfd-${String(suffix).padStart(12, "0")}`;
}
