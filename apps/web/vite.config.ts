import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { defineConfig } from "vite";

const repository = resolve(import.meta.dirname, "../..");
const sourceFile = (file: string) =>
  /^(?:apps|packages)\/[^/]+\/(?:src\/.*|public\/.*|package\.json|tsconfig[^/]*\.json|vite\.config\.ts|index\.html)$/.test(
    file,
  ) ||
  /^(?:tools\/build\/[^/]+\.mjs|migrations\/\d+_[a-z0-9_]+\.sql|infra\/images\/player-pair\/Dockerfile|Dockerfile|\.dockerignore|\.npmrc|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.base)?\.json)$/.test(
    file,
  );
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

/** Cloud candidates have no .git directory. Verify their manifest, never use a
 * hand-maintained version string or include local environment/credentials. */
export function playerBuildId(root = repository): string {
  const realRoot = realpathSync(root);
  const manifestPath = join(root, "source-manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      sourceSha256?: unknown;
      entries?: unknown;
    };
    if (!Array.isArray(manifest.entries) || manifest.entries.length === 0)
      throw new Error("Invalid player source manifest");
    const seen = new Set<string>();
    const entries = manifest.entries
      .map((entry: unknown) => {
        if (!entry || typeof entry !== "object")
          throw new Error("Invalid source entry");
        const { file, sha256 } = entry as { file?: unknown; sha256?: unknown };
        if (
          typeof file !== "string" ||
          !sourceFile(file) ||
          file.split("/").some((part) => part === ".." || part === ".") ||
          seen.has(file) ||
          typeof sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(sha256)
        )
          throw new Error("Invalid player source entry");
        seen.add(file);
        const path = resolve(root, file);
        if (
          !path.startsWith(`${resolve(root)}${sep}`) ||
          !realpathSync(path).startsWith(`${realRoot}${sep}`) ||
          !lstatSync(path).isFile() ||
          digest(readFileSync(path)) !== sha256
        )
          throw new Error("Player source does not match manifest");
        return { file, sha256 };
      })
      .sort((left, right) =>
        left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
      );
    const verified = digest(
      entries.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join(""),
    );
    if (verified !== manifest.sourceSha256)
      throw new Error("Player source manifest digest mismatch");
    return verified;
  }
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const directory of [
    "apps/web/src",
    "apps/web/public",
    "packages/sync/src",
    "packages/contracts/src",
  ])
    if (existsSync(join(root, directory))) visit(join(root, directory));
  for (const file of [
    "apps/web/vite.config.ts",
    "apps/web/index.html",
    "pnpm-lock.yaml",
  ])
    if (existsSync(join(root, file))) files.push(join(root, file));
  return digest(
    files
      .sort()
      .map(
        (path) =>
          `${digest(readFileSync(path))}  ${relative(root, path).split(sep).join("/")}\n`,
      )
      .join(""),
  );
}

const buildId = playerBuildId();

export default defineConfig({
  define: { __PLAYER_BUILD__: JSON.stringify(buildId) },
  plugins: [
    react(),
    {
      name: "player-build-identity",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "player-version.json",
          source: JSON.stringify({ schemaVersion: 1, buildId }),
        });
      },
      configureServer(server) {
        server.middlewares.use("/player-version.json", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify({ schemaVersion: 1, buildId }));
        });
      },
    },
  ],
  build: { outDir: "../../dist/web", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:13900", ws: true },
    },
  },
});
