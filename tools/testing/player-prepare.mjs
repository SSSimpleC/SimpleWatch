import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../..");
if (!(process.platform === "darwin" && process.arch === "arm64")) {
  throw new Error(
    "自动准备当前仅锁定 macOS arm64；其他平台请提供已验证的 Caddy 2.11.4 PLAYER_CADDY_BIN 并安装项目缓存中的浏览器。不得静默跳过门禁。",
  );
}
const directory = resolve(repository, ".cache/caddy-2.11.4");
mkdirSync(directory, { recursive: true });
const name = "caddy_2.11.4_mac_arm64.tar.gz";
const archive = resolve(directory, name);
const expected =
  "9efb0af2d6cf09cfb5053c0e51721b9b3d4956d346234f39368d943d25a3c9a7";
// Digest from https://api.github.com/repos/caddyserver/caddy/releases/tags/v2.11.4
if (!existsSync(archive)) {
  execFileSync(
    "curl",
    [
      "-fL",
      "--max-time",
      "120",
      `https://github.com/caddyserver/caddy/releases/download/v2.11.4/${name}`,
      "-o",
      archive,
    ],
    { stdio: "inherit" },
  );
}
if (
  createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected
)
  throw new Error("Caddy 官方发行包 SHA-256 不匹配；停止，未执行二进制。");
execFileSync("tar", ["-xzf", archive, "-C", directory, "caddy"], {
  stdio: "inherit",
});
execFileSync(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "install",
    "chromium",
    "webkit",
    "firefox",
  ],
  {
    cwd: repository,
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: resolve(repository, ".cache/playwright"),
    },
  },
);
