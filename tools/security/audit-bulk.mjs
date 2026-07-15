import { execFileSync } from "node:child_process";

const tree = JSON.parse(
  execFileSync(
    "pnpm",
    ["--recursive", "list", "--prod", "--json", "--depth", "Infinity"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ),
);
const versions = new Map();

function collectDependencies(dependencies) {
  if (!dependencies || typeof dependencies !== "object") return;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!dependency || typeof dependency !== "object") continue;
    if (
      typeof dependency.version === "string" &&
      !name.startsWith("@simplewatch/")
    ) {
      const packageVersions = versions.get(name) ?? new Set();
      packageVersions.add(dependency.version);
      versions.set(name, packageVersions);
    }
    collectDependencies(dependency.dependencies);
  }
}

for (const workspace of tree) collectDependencies(workspace.dependencies);
const payload = Object.fromEntries(
  [...versions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, packageVersions]) => [name, [...packageVersions].sort()]),
);

const response = await fetch(
  "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
  {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  },
);
if (!response.ok) {
  throw new Error(`npm bulk advisory 请求失败：HTTP ${response.status}`);
}

const body = await response.json();
const advisories = Object.entries(body).flatMap(([name, entries]) =>
  entries.map((entry) => ({ name, ...entry })),
);
const blocking = advisories.filter((entry) =>
  ["high", "critical"].includes(entry.severity),
);

if (advisories.length === 0) {
  console.log(`生产依赖审计通过：${versions.size} 个包，无已知漏洞`);
} else {
  for (const advisory of advisories) {
    console.log(
      `[${advisory.severity}] ${advisory.name}: ${advisory.title} (${advisory.url})`,
    );
  }
  console.log(
    `生产依赖审计完成：${advisories.length} 条公告，${blocking.length} 条 high/critical`,
  );
}

if (blocking.length > 0) process.exitCode = 1;
