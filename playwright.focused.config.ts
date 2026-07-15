import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/focused-e2e",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:18080",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
