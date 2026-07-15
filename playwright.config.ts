import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:15173",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @simplewatch/web dev --host 127.0.0.1 --port 15173",
    port: 15173,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
