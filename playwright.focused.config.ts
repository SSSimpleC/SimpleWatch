import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/focused-e2e",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:18080",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge",
    serviceWorkers: "block",
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
