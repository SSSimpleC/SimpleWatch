import { expect, test } from "@playwright/test";

test("host controls progress while a kicked member is disconnected", async ({
  browser,
  page,
}) => {
  await page.goto("/admin");
  await page.getByLabel("6 位放映口令").fill("260713");
  await page.getByRole("button", { name: "解锁控制台" }).click();
  await page.getByLabel("主持人昵称").fill("Focused Host");
  await page.getByRole("button", { name: /开启放映室/ }).click();
  const inviteUrl = await page.locator(".invite-copy code").textContent();
  expect(inviteUrl).toBeTruthy();
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
  await member.goto(inviteUrl!);
  await member.getByLabel("昵称").fill("Focused Member");
  await member.getByRole("button", { name: "进入放映室" }).click();
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
    member.getByRole("heading", { name: /让远方的人/ }),
  ).toBeVisible();
  await memberContext.close();
});
