import { expect, test, type Page } from "@playwright/test";

test("real admin creates a room and a second browser joins read-only", async ({
  browser,
  page,
}) => {
  await login(page, "Host", "range-host-password-24-characters");
  await expect(page.getByRole("heading", { name: "放映控制" })).toBeVisible();

  await page
    .locator('input[type="file"][accept="video/mp4"]')
    .setInputFiles("test-data/generated/media-smoke.mp4");
  await expect(page.getByText(/上传完成|正在检查兼容性/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "media-smoke.mp4" }),
  ).toBeVisible({ timeout: 20_000 });
  const subtitleInput = page.getByLabel("为 media-smoke.mp4 添加字幕");
  await expect(subtitleInput).toBeVisible({ timeout: 20_000 });
  await subtitleInput.setInputFiles("test-data/subtitles/predeploy.vtt");
  await expect(
    page.getByText(/字幕 predeploy.vtt 已进入处理队列/),
  ).toBeVisible();

  await page.getByRole("button", { name: /开启放映室/ }).click();
  await page.getByRole("button", { name: "进入主持房间" }).click();
  await expect(page.getByText("主持控制")).toBeVisible();
  await expect(page.getByText("同步在线")).toBeVisible();
  await expect(page.getByLabel("选择点播影片")).toBeVisible();
  await page
    .getByLabel("选择点播影片")
    .selectOption({ label: "media-smoke.mp4" });
  await expect(page.locator("video")).toBeVisible();
  const hostProgress = page.getByRole("slider", { name: "播放进度" });
  await expect(hostProgress).toBeEnabled();
  await expect(page.getByRole("button", { name: /播放|暂停/ })).toBeEnabled();
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await login(member, "Simple", "range-viewer-password-24-chars");
  await expect(member.getByText("同场观众")).toBeVisible();
  await expect(
    member.getByRole("button", { name: /播放|暂停/ }),
  ).toBeDisabled();
  await expect(member.getByRole("button", { name: "−10s" })).toBeDisabled();
  await expect(member.getByRole("slider", { name: "播放进度" })).toBeDisabled();
  await expect(member.getByText("主持控制")).toHaveCount(0);
  await member.getByRole("link", { name: "诊断" }).click();
  await expect(member.getByRole("heading", { name: "连接诊断" })).toBeVisible();
  await member.goBack();
  await expect(member.getByText("同场观众")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".seat-list li")
    .filter({ hasText: "Second Browser" })
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
