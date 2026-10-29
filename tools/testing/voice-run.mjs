import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const binary =
  process.env.VOICE_LIVEKIT_BIN ??
  resolve(root, ".cache/voice-runtime/bin/livekit-server");
if (!existsSync(binary)) {
  throw new Error(
    "缺少本地 LiveKit 1.13.1；macOS arm64 请先运行 pnpm test:voice:prepare，其他平台显式提供 VOICE_LIVEKIT_BIN。不会启动生产服务或申请真实麦克风。",
  );
}
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "playwright.voice.config.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VOICE_LIVEKIT_BIN: binary,
      PLAYWRIGHT_BROWSERS_PATH: resolve(root, ".cache/playwright"),
    },
  },
);
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
