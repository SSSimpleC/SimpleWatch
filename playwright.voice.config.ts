import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/voice-e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: "output/playwright/voice/results",
  reporter: [
    ["list"],
    ["json", { outputFile: "output/playwright/voice/report.json" }],
  ],
  use: {
    baseURL: "https://127.0.0.1:18443",
    ignoreHTTPSErrors: true,
    viewport: { width: 1360, height: 950 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  projects: [{ name: "voice-chromium", use: { browserName: "chromium" } }],
  webServer: {
    command:
      "node --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/testing/player-server.mjs",
    env: { SIMPLEWATCH_VOICE_GATE: "1" },
    url: "https://127.0.0.1:18443/health/live",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
