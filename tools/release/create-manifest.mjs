import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(
  process.argv[2] ?? "artifacts/releases/local-release-manifest.json",
);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const gitSha = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
const files = git("ls-files", "-co", "--exclude-standard")
  .split("\n")
  .filter(Boolean)
  .filter(existsSync)
  .filter(
    (file) =>
      !/^(?:artifacts|dist|tmp|coverage|playwright-report|test-results)\//.test(
        file,
      ),
  )
  .sort();
const tree = createHash("sha256");
for (const file of files) {
  tree.update(createHash("sha256").update(readFileSync(file)).digest("hex"));
  tree.update(`  ${file}\n`);
}
const migrations = files
  .filter((file) => /^migrations\/\d+.*\.sql$/.test(file))
  .map((file) => ({
    file: file.slice("migrations/".length),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }));
const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const condaLock =
  process.platform === "darwin" ? "conda-osx-arm64.lock" : "conda-win-64.lock";
const manifest = {
  createdAt: new Date().toISOString(),
  releaseKind: "local-predeploy",
  gitSha,
  dirty,
  sourceTreeSha256: tree.digest("hex"),
  pnpmLockSha256: digest("pnpm-lock.yaml"),
  condaLockFile: condaLock,
  condaLockSha256: digest(condaLock),
  migrations,
  mediaMtx: { version: "1.18.2" },
  liveKit: { version: "1.13.1" },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${output}\n`);
