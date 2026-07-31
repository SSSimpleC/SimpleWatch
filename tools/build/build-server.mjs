import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const outputRoot = resolve(repositoryRoot, "dist/server");

const apiDependencies = await productionDependencies("apps/api/package.json");
const workerDependencies = await productionDependencies(
  "apps/worker/package.json",
);

for (const dependency of Object.keys(workerDependencies)) {
  if (!(dependency in apiDependencies)) {
    throw new Error(
      `Worker生产依赖 ${dependency} 未包含在API运行依赖集合中，无法构建单一运行镜像`,
    );
  }
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const shared = {
  absWorkingDir: repositoryRoot,
  bundle: true,
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  minify: false,
  outExtension: { ".js": ".mjs" },
  platform: "node",
  sourcemap: false,
  target: "node24",
};

await build({
  ...shared,
  entryPoints: {
    api: "apps/api/src/main.ts",
    "admin-bootstrap": "apps/api/src/cli/admin-bootstrap.ts",
    "account-manage": "apps/api/src/cli/account-manage.ts",
    "clear-library": "apps/api/src/cli/clear-library.ts",
    "cleanup-expired-uploads": "apps/api/src/cli/cleanup-expired-uploads.ts",
  },
  external: Object.keys(apiDependencies),
  outdir: outputRoot,
});

async function productionDependencies(relativePackagePath) {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, relativePackagePath), "utf8"),
  );
  return Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(
      ([, version]) => !String(version).startsWith("workspace:"),
    ),
  );
}

await build({
  ...shared,
  entryPoints: { worker: "apps/worker/src/main.ts" },
  external: Object.keys(workerDependencies),
  outdir: outputRoot,
});
