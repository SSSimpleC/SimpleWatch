import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

// Repair only a copied local report; never mutate the active run or its evidence.
const repository = resolve(import.meta.dirname, "../..");
const history = resolve(repository, "output/playwright/voice-history");
const archive = resolve(process.argv[2] ?? "");
if (!archive.startsWith(`${history}${sep}`)) {
  throw new Error("目标必须是项目 voice-history 内的一份独立归档");
}
const sourceResults = resolve(repository, "output/playwright/voice/results");
const archivedResults = resolve(archive, "results");
const reportFile = resolve(archive, "report.json");
const report = JSON.parse(readFileSync(reportFile, "utf8"));
let rewritten = 0;
const missing = [];

function inspect(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "path" || key === "outputDir") && typeof child === "string") {
      const absolute = resolve(child);
      if (
        absolute === sourceResults ||
        absolute.startsWith(`${sourceResults}${sep}`)
      ) {
        const target = resolve(
          archivedResults,
          relative(sourceResults, absolute),
        );
        if (!existsSync(target)) missing.push(relative(archive, target));
        else {
          value[key] = target;
          rewritten += 1;
        }
      }
    } else inspect(child);
  }
}

inspect(report);
if (missing.length) {
  throw new Error(`归档附件缺失，报告未改写：${missing.join(", ")}`);
}
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `归档路径校验通过：${rewritten} 个路径指向本归档，不依赖活动测试目录。`,
);
