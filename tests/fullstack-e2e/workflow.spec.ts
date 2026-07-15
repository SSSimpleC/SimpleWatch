import { expect, test } from "@playwright/test";

test("real admin creates a room and a second browser joins read-only", async ({
  browser,
  page,
}) => {
  await page.goto("/admin");
  await page.getByLabel("6 位放映口令").fill("260713");
  await page.getByRole("button", { name: "解锁控制台" }).click();
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

  await page.getByLabel("主持人昵称").fill("Predeploy Host");
  await page.getByRole("button", { name: /开启放映室/ }).click();
  const inviteUrl = await page.locator(".invite-copy code").textContent();
  expect(inviteUrl).toBeTruthy();
  await page.getByRole("button", { name: "进入主持房间" }).click();
  await expect(page.getByText("主持控制")).toBeVisible();
  await expect(page.getByLabel("选择点播影片")).toBeVisible();
  await page
    .getByLabel("选择点播影片")
    .selectOption({ label: "media-smoke.mp4" });
  await expect(page.locator("video")).toBeVisible();
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await member.goto(inviteUrl!);
  await member.getByLabel("昵称").fill("Second Browser");
  await member.getByRole("button", { name: "进入放映室" }).click();
  await expect(member.getByText("同场观众")).toBeVisible();
  await expect(
    member.getByRole("button", { name: /播放|暂停/ }),
  ).toBeDisabled();
  await expect(member.getByRole("button", { name: "−10s" })).toBeDisabled();
  await expect(member.getByText("主持控制")).toHaveCount(0);
  await member.getByRole("link", { name: "诊断" }).click();
  await expect(member.getByRole("heading", { name: "连接诊断" })).toBeVisible();
  await memberContext.close();
});
