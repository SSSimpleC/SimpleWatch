import { expect, test, type Page } from "@playwright/test";

test("host controls progress while a kicked member is disconnected", async ({
  browser,
  page,
}) => {
  await login(page, "Host", "range-host-password-24-characters");
  await page.getByRole("button", { name: /开启放映室/ }).click();
  await page.getByRole("button", { name: "进入主持房间" }).click();
  await expect(page.getByText("同步在线")).toBeVisible();
  await page
    .getByLabel("选择点播影片")
    .selectOption({ label: "focused-hevc.mp4" });

  const hostProgress = page.getByRole("slider", { name: "播放进度" });
  await expect(hostProgress).toBeEnabled();
  await expect(hostProgress).toHaveAttribute("max", "10");
  await expect(page.getByText("高负载原片")).toBeVisible();
  await expect(page.getByText(/约 20\.0 Mbps/)).toBeVisible();

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await login(member, "Simple", "range-viewer-password-24-chars");
  await expect(member.getByText("同场观众")).toBeVisible();
  await expect(member.getByRole("slider", { name: "播放进度" })).toBeDisabled();

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".seat-list li")
    .filter({ hasText: "Focused Member" })
    .getByRole("button", { name: "移出" })
    .click();
  await expect(member).toHaveURL("/");
  await expect(
    member.getByRole("heading", { name: /本场席位已被移出/ }),
  ).toBeVisible();
  await memberContext.close();
});

async function login(page: Page, username: string, password: string) {
  await page.goto("/");
  await page.getByLabel("账户名称").fill(username);
  await page.getByLabel("账户密码").fill(password);
  await page.getByRole("button", { name: /凭证入场/ }).click();
}
