import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const gate = process.argv[2];
if (!new Set(["range", "rtc", "backup"]).has(gate)) {
  throw new Error("未知平台门禁");
}
if (process.platform === "win32") {
  const prerequisites = {
    range: [
      "tools/environment/install-caddy.ps1",
      "tools/environment/install-tusd.ps1",
    ],
    rtc: [
      "tools/environment/install-mediamtx.ps1",
      "tools/environment/install-livekit.ps1",
    ],
    backup: [],
  }[gate];
  for (const prerequisite of prerequisites) {
    const installed = spawnSync("pwsh", ["-File", prerequisite], {
      stdio: "inherit",
    });
    if (installed.status !== 0) process.exit(installed.status ?? 1);
  }
  const script = {
    range: "tools/testing/range-predeploy.ps1",
    rtc: "tools/testing/rtc-native-smoke.ps1",
    backup: "tools/testing/backup-restore-smoke.ps1",
  }[gate];
  const result = spawnSync("pwsh", ["-File", script], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (gate === "rtc") {
    const fiveClient = spawnSync(
      "pwsh",
      ["-File", "tools/testing/livekit-five-client.ps1"],
      { stdio: "inherit" },
    );
    process.exit(fiveClient.status ?? 1);
  }
  process.exit(0);
}

if (gate === "backup") {
  const require = createRequire(
    new URL("../../apps/api/package.json", import.meta.url),
  );
  const Database = require("better-sqlite3");
  mkdirSync(resolve(".local"), { recursive: true });
  const root = mkdtempSync(resolve(".local/backup-smoke-"));
  try {
    const source = join(root, "source.sqlite3");
    const backup = join(root, "backup.sqlite3");
    const database = new Database(source);
    database.exec(
      "CREATE TABLE proof(value TEXT NOT NULL); INSERT INTO proof VALUES ('ok')",
    );
    database.prepare("VACUUM INTO ?").run(backup);
    database.close();
    const restored = new Database(backup, { readonly: true });
    const proof = restored.prepare("SELECT value FROM proof").get();
    const integrity = restored.pragma("integrity_check", { simple: true });
    restored.close();
    if (proof?.value !== "ok" || integrity !== "ok") {
      throw new Error("SQLite一致性备份恢复失败");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write("SQLite一致性备份与只读恢复演练通过\n");
  process.exit(0);
}

const testTargets =
  gate === "range"
    ? [
        "apps/api/test/api.integration.test.ts",
        "tests/security/security.integration.test.ts",
      ]
    : [
        "apps/api/test/api.integration.test.ts",
        "apps/worker/test/process-outbox.test.ts",
      ];
const result = spawnSync("pnpm", ["exec", "vitest", "run", ...testTargets], {
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(
  `${gate === "range" ? "Range/鉴权" : "RTC凭据/撤销"}本地协议门禁通过；真实Caddy/RTC网络门禁在生产候选服务器执行。\n`,
);
