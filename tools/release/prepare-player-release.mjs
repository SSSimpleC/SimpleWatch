import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// A source-only allowlist: never send local accounts, logs, media, SSH keys,
// node_modules, Conda, caches or .env files to the build host.
const repository = resolve(import.meta.dirname, "../..");
const git = (...args) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain").length > 0;
const gitSha = git("rev-parse", "HEAD");
const production = process.argv.includes("--production");
if (production && dirty)
  throw new Error(
    "Production release requires a clean, committed Git checkout",
  );
const rootFiles = new Set([
  "Dockerfile",
  "infra/images/player-pair/Dockerfile",
  ".dockerignore",
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
]);
const files = [
  ...new Set(git("ls-files", "-co", "--exclude-standard").split("\n")),
]
  .filter(
    (file) =>
      rootFiles.has(file) ||
      /^(?:apps|packages)\/[^/]+\/(?:src\/.*|public\/.*|package\.json|tsconfig[^/]*\.json|vite\.config\.ts|index\.html)$/.test(
        file,
      ) ||
      /^tools\/build\/[^/]+\.mjs$/.test(file) ||
      /^migrations\/\d+_[a-z0-9_]+\.sql$/.test(file),
  )
  .sort();
const entries = files.map((file) => {
  const path = join(repository, file);
  if (!lstatSync(path).isFile())
    throw new Error(`Not a regular source file: ${file}`);
  return {
    file,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
});
for (const file of rootFiles) {
  if (!files.includes(file)) throw new Error(`Missing build input: ${file}`);
}
const sourceSha256 = createHash("sha256")
  .update(entries.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join(""))
  .digest("hex");
const releaseTag = `20261022-player-${sourceSha256.slice(0, 12)}`;
const releases = join(repository, "artifacts/releases");
mkdirSync(releases, { recursive: true });
const output = mkdtempSync(join(releases, `${releaseTag}-`));
const source = join(output, "source");
mkdirSync(source);
for (const file of files) {
  const destination = join(source, file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(repository, file), destination);
}
// A clean pre-check alone must not certify a checkout that changed while the
// release was being assembled. Generated artifacts live in ignored directories.
if (
  production &&
  (git("status", "--porcelain").length > 0 ||
    git("rev-parse", "HEAD") !== gitSha)
)
  throw new Error("Git checkout changed during production packaging");
const manifest = {
  releaseTag,
  createdAt: new Date().toISOString(),
  gitSha,
  releaseKind: production ? "production" : "local-predeploy",
  dirty,
  sourceSha256,
  entries,
};
writeFileSync(
  join(source, "source-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const archive = join(output, `${releaseTag}.tar.gz`);
execFileSync(
  "tar",
  [
    ...(process.platform === "darwin" ? ["--no-xattrs"] : []),
    "-czf",
    archive,
    "-C",
    source,
    ".",
  ],
  {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  },
);
const archiveSha256 = createHash("sha256")
  .update(readFileSync(archive))
  .digest("hex");
writeFileSync(
  join(output, "archive.sha256"),
  `${archiveSha256}  ${releaseTag}.tar.gz\n`,
);
console.log(
  JSON.stringify(
    {
      output,
      archive,
      archiveSha256,
      releaseTag,
      sourceSha256,
      files: files.length,
    },
    null,
    2,
  ),
);
