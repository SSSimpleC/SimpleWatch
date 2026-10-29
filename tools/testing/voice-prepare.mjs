import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Local test runtime only. No Docker daemon, global Go installation or server configuration.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prefix = join(root, ".conda/envs/voice-tools");
const runtime = join(root, ".cache/voice-runtime");
const work = join(root, "tmp/voice-runtime");
const goVersion = "1.26.7";
const goBuild = "nocgo_he1c6cbc_1";
const goPackageSha256 =
  "ba14127fdc0d20aee37e3d0330a0933ec1e25c8008facef8e66012b99419e20f";
const livekitVersion = "v1.13.1";
const moduleName = "github.com/livekit/livekit-server";
const commit = "46c4309554d37d23ee8da88a8a7e02a68fba09c1";
const moduleSum = "h1:sJEbH7F6a/nFu4hPwMZtGGsbv8c4bszMx5xX/wapk6c=";
const goModSum = "h1:AplU/Vv4otx4+AThOfxnYApz1L9VLBtrgmVdwYmY5lQ=";

if (process.argv.includes("--help")) {
  process.stdout.write(
    "Usage: tools/environment/run-dev node tools/testing/voice-prepare.mjs\n" +
      "Builds pinned LiveKit 1.13.1 for local macOS arm64 tests using a project Conda Go environment.\n" +
      "Set SIMPLEWATCH_CONDA_EXE to an existing Conda executable if it is not /opt/miniconda3/bin/conda.\n" +
      "Does not start services or request microphone access.\n",
  );
  process.exit(0);
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    "此固定构建脚本仅用于 macOS arm64；其他平台继续使用现有测试运行时。",
  );
}
for (const directory of [runtime, work, join(runtime, "bin")]) {
  mkdirSync(directory, { recursive: true });
}
const environment = {
  ...process.env,
  CONDA_PKGS_DIRS: join(root, ".cache/conda-voice-pkgs"),
  TMPDIR: work,
  GOPATH: join(runtime, "gopath"),
  GOMODCACHE: join(runtime, "modules"),
  GOCACHE: join(runtime, "build-cache"),
  GOENV: "off",
  GOWORK: "off",
  GOTOOLCHAIN: "local",
  GOFLAGS: "",
  GOPROXY: "https://proxy.golang.org",
  GOSUMDB: "sum.golang.org",
  GOPRIVATE: "",
  GONOSUMDB: "",
  GONOPROXY: "",
  GOINSECURE: "",
  CGO_ENABLED: "1",
  GOMAXPROCS: "2",
};

function command(executable, args, { cwd = root, capture = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} failed (${result.status ?? result.signal})`);
  }
  return result.stdout?.trim() ?? "";
}

async function downloadArchive(url, target, bytes) {
  const prefixBytes = existsSync(target) ? statSync(target).size : 0;
  if (prefixBytes === bytes) return;
  if (prefixBytes > bytes)
    throw new Error("Go archive exceeds its official length");
  const partRoot = `${target}.parts`;
  mkdirSync(partRoot, { recursive: true });
  const chunks = [];
  for (let start = prefixBytes; start < bytes; start += 4 * 1024 * 1024) {
    chunks.push({
      start,
      end: Math.min(bytes - 1, start + 4 * 1024 * 1024 - 1),
    });
  }
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const file = join(partRoot, `${chunk.start}-${chunk.end}`);
      const headers = `${file}.headers`;
      const expectedRange = `content-range: bytes ${chunk.start}-${chunk.end}/${bytes}`;
      const valid = () =>
        existsSync(file) &&
        statSync(file).size === chunk.end - chunk.start + 1 &&
        existsSync(headers) &&
        readFileSync(headers, "utf8")
          .toLowerCase()
          .split(/\r?\n/)
          .filter((line) => line.startsWith("content-range:"))
          .at(-1) === expectedRange;
      if (valid()) continue;
      const status = await new Promise((resolveStatus, reject) => {
        const child = spawn(
          "/usr/bin/curl",
          [
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--retry",
            "3",
            "--retry-all-errors",
            "--retry-delay",
            "2",
            "--connect-timeout",
            "15",
            "--max-time",
            "300",
            "--range",
            `${chunk.start}-${chunk.end}`,
            "--dump-header",
            headers,
            "--output",
            file,
            "--write-out",
            "%{http_code}",
            url,
          ],
          { cwd: root, env: environment, stdio: ["ignore", "pipe", "inherit"] },
        );
        let output = "";
        child.stdout.setEncoding("utf8").on("data", (data) => {
          output += data;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolveStatus(output.trim())
            : reject(new Error(`Archive range download failed (${code})`)),
        );
      });
      if (status !== "206" || !valid())
        throw new Error(
          "Go proxy range response did not match the requested bytes",
        );
      process.stdout.write(
        `Go archive verified range ${chunk.start}-${chunk.end}\n`,
      );
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, chunks.length) }, worker),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  const parts = prefixBytes ? [readFileSync(target)] : [];
  for (const chunk of chunks)
    parts.push(readFileSync(join(partRoot, `${chunk.start}-${chunk.end}`)));
  const assembled = `${target}.assembled`;
  writeFileSync(assembled, Buffer.concat(parts));
  if (statSync(assembled).size !== bytes)
    throw new Error("Assembled Go archive length mismatch");
  renameSync(assembled, target);
}

const go = join(prefix, "bin/go");
if (!existsSync(go)) {
  const conda =
    process.env.SIMPLEWATCH_CONDA_EXE ?? "/opt/miniconda3/bin/conda";
  if (!existsSync(conda))
    throw new Error("未找到 Conda；请设置 SIMPLEWATCH_CONDA_EXE。");
  command(conda, [
    "create",
    "--yes",
    "--prefix",
    prefix,
    "--override-channels",
    "-c",
    "conda-forge",
    `go=${goVersion}=${goBuild}`,
  ]);
}
const compiler = command(go, ["version"], { capture: true });
if (!compiler.includes(`go${goVersion} darwin/arm64`)) {
  throw new Error(`Go 工具链不匹配：${compiler}`);
}
// go-osstat's Darwin CPU counters require CGO and Apple's Mach headers. Reuse
// the installed Xcode toolchain; do not install or alter any system software.
environment.CC = command("/usr/bin/xcrun", ["--find", "clang"], {
  capture: true,
});
environment.SDKROOT = command(
  "/usr/bin/xcrun",
  ["--sdk", "macosx", "--show-sdk-path"],
  { capture: true },
);
if (!existsSync(environment.CC) || !existsSync(environment.SDKROOT)) {
  throw new Error(
    "macOS LiveKit 构建需要现有 Xcode clang/SDK；未自动安装系统工具。",
  );
}
const compilerPackage = JSON.parse(
  readFileSync(
    join(prefix, `conda-meta/go-${goVersion}-${goBuild}.json`),
    "utf8",
  ),
);
if (compilerPackage.sha256 !== goPackageSha256) {
  throw new Error("Conda Go package 校验值不匹配。");
}
const downloaded = JSON.parse(
  command(go, ["mod", "download", "-json", `${moduleName}@${livekitVersion}`], {
    capture: true,
  }),
);
if (
  downloaded.Error ||
  downloaded.Sum !== moduleSum ||
  downloaded.GoModSum !== goModSum ||
  downloaded.Origin?.Hash !== commit
) {
  throw new Error("LiveKit 源码版本、提交或 Go checksum database 校验不匹配。");
}
if (!downloaded.Dir?.startsWith(environment.GOMODCACHE + "/")) {
  throw new Error("LiveKit 模块目录不在项目隔离缓存中。");
}
const binary = join(runtime, "bin/livekit-server");
// The upstream compress archive contains ~39 MB of test fixtures. Keep a
// resumable local proxy copy when a long Go HTTP download was interrupted.
// Go still authenticates its contents against upstream go.sum and sum.golang.org.
const archiveModule = "github.com/klauspost/compress";
const archiveVersion = "v1.18.6";
if (
  !existsSync(
    join(
      environment.GOMODCACHE,
      "cache/download",
      archiveModule,
      "@v",
      `${archiveVersion}.ziphash`,
    ),
  )
) {
  const proxy = join(runtime, "download-proxy");
  const directory = join(proxy, archiveModule, "@v");
  mkdirSync(directory, { recursive: true });
  for (const extension of ["info", "mod", "zip"]) {
    const target = join(directory, `${archiveVersion}.${extension}`);
    const url = `https://proxy.golang.org/${archiveModule}/@v/${archiveVersion}.${extension}`;
    if (extension !== "zip" && existsSync(target)) continue;
    // The official proxy archive length; matching length alone never bypasses
    // Go's cryptographic checksum verification below.
    if (
      extension === "zip" &&
      existsSync(target) &&
      statSync(target).size === 39_201_205
    )
      continue;
    process.stdout.write(
      `Fetching Go dependency for checksum verification: ${archiveModule}@${archiveVersion} (${extension})\n`,
    );
    if (extension === "zip") {
      await downloadArchive(url, target, 39_201_205);
      continue;
    }
    command("/usr/bin/curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--retry",
      "3",
      "--retry-all-errors",
      "--retry-delay",
      "2",
      "--connect-timeout",
      "15",
      "--max-time",
      "600",
      "--continue-at",
      "-",
      "--output",
      target,
      url,
    ]);
  }
  environment.GOPROXY = `${pathToFileURL(proxy).href},https://proxy.golang.org`;
}
command(
  go,
  [
    "build",
    "-mod=readonly",
    "-trimpath",
    "-p",
    "2",
    "-o",
    binary,
    "./cmd/server",
  ],
  {
    cwd: downloaded.Dir,
  },
);
command(go, ["mod", "verify"], { cwd: downloaded.Dir });
const version = command(binary, ["--version"], { capture: true });
if (!version.includes("1.13.1"))
  throw new Error(`LiveKit 版本不匹配：${version}`);
const manifest = {
  createdAt: new Date().toISOString(),
  platform: "darwin-arm64",
  compiler,
  cgoEnabled: true,
  cCompiler: environment.CC,
  macosSdk: environment.SDKROOT,
  goPackageSha256,
  livekitVersion,
  sourceCommit: commit,
  module: moduleName,
  moduleSum,
  goModSum,
  binary,
  binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
};
writeFileSync(
  join(runtime, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
process.stdout.write(`${version}\n${binary}\n`);
