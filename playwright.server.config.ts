import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const fakeVideoPath =
  process.env.SIMPLEWATCH_FAKE_VIDEO_PATH ??
  resolve("test-data/generated/whip-test.y4m");

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
        `--use-file-for-fake-video-capture=${fakeVideoPath}`,
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
