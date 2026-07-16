import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const planPath = resolve("IMPLEMENTATION_PLAN.md");
const plan = readFileSync(planPath, "utf8");
const forbiddenPatterns = [
  [
    "工作区外的 macOS 用户目录",
    /\/Users\/(?!simplechen\/Desktop\/Work\/AllAI\/SimpleWatch(?:\/|`|\s))/,
  ],
  ["示例密码", /(?:password|passwd)\s*[=:]\s*(?:changeme|password|123456)/i],
  ["latest 镜像标签", /image:\s*\S+:latest\b/],
];

const failures = forbiddenPatterns
  .filter(([, pattern]) => pattern.test(plan))
  .map(([name]) => `计划仍包含：${name}`);

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("计划环境占位符检查通过");
