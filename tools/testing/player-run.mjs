import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const repository = resolve(import.meta.dirname, "../..");
const browserRoot = resolve(repository, ".cache/playwright");
const caddy =
  process.env.PLAYER_CADDY_BIN ??
  resolve(repository, ".cache/caddy-2.11.4/caddy");
if (!existsSync(caddy))
  throw new Error(
    "缺少 Caddy；请先运行 pnpm test:player:prepare（仅项目缓存，不安装系统服务）。",
  );
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "playwright.player.config.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: repository,
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
  },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
