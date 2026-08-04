import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/api/test/**/*.test.ts",
      "apps/worker/test/**/*.test.ts",
      "apps/edge-agent/test/**/*.test.ts",
      "tests/security/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/*/src/**/*.ts",
        "apps/api/src/**/*.ts",
        "apps/worker/src/**/*.ts",
        "apps/edge-agent/src/**/*.ts",
      ],
      exclude: [
        "apps/api/src/cli/**",
        "apps/api/src/main.ts",
        "apps/worker/src/main.ts",
        "apps/edge-agent/src/main.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "artifacts/coverage",
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 85,
        lines: 80,
      },
    },
  },
});
