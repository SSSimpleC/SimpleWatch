import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/player-e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "output/playwright/player/results",
  reporter: [
    ["list"],
    ["json", { outputFile: "output/playwright/player/report.json" }],
  ],
  use: {
    baseURL: "https://127.0.0.1:18443",
    ignoreHTTPSErrors: true, // Ephemeral localhost-only test certificate; no system trust change.
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "player-chromium", use: { browserName: "chromium" } },
    { name: "player-webkit", use: { browserName: "webkit" } },
    { name: "player-firefox", use: { browserName: "firefox" } },
  ],
  webServer: {
    command:
      "node --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/testing/player-server.mjs",
    url: "https://127.0.0.1:18443/health/live",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 45_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
