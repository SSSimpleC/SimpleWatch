import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/server-e2e",
  workers: 1,
  reporter: "list",
  timeout: 90_000,
  use: {
    baseURL: "https://8.134.239.34",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge",
    ignoreHTTPSErrors: false,
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
