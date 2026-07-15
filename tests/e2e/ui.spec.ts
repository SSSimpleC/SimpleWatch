import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const artifacts = resolve("artifacts/predeploy/latest");
mkdirSync(artifacts, { recursive: true });

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`landing and admin shell render without overflow on ${viewport.name}`, async ({
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
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", { name: /让远方的人/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: resolve(artifacts, `landing-${viewport.name}.png`),
      fullPage: true,
    });
    await page.getByRole("link", { name: /放映员入口/ }).click();
    await expect(
      page.getByRole("heading", { name: "放映员控制台" }),
    ).toBeVisible();
    const codeInput = page.getByLabel("6 位放映口令");
    await expect(codeInput).toHaveValue("");
    await expect(codeInput).toHaveAttribute("inputmode", "numeric");
    await expect(
      page.getByRole("button", { name: "解锁控制台" }),
    ).toBeDisabled();
    await page.screenshot({
      path: resolve(artifacts, `admin-login-${viewport.name}.png`),
      fullPage: true,
    });
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
    /sw_admin|sw_room|Bearer /,
  );
});
