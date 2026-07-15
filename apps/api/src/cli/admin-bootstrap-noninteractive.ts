import { resolve, sep } from "node:path";

import { parseAppConfig } from "@simplewatch/config";

import { openDatabase } from "../database.js";
import { AuthService } from "../services/auth-service.js";

if (process.env.ALLOW_NONINTERACTIVE_BOOTSTRAP !== "true") {
  throw new Error("必须显式设置 ALLOW_NONINTERACTIVE_BOOTSTRAP=true");
}
const config = parseAppConfig(process.env);
const productionCodeUpdateAllowed =
  process.env.ALLOW_PRODUCTION_CODE_UPDATE === "locked-single-room-code-update";
if (config.nodeEnv === "production" && !productionCodeUpdateAllowed) {
  throw new Error("生产环境必须显式确认固定口令更新");
}
const code = process.env.BOOTSTRAP_ADMIN_CODE;
if (!code) throw new Error("缺少测试放映口令");
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const allowedRoot = resolve(repositoryRoot, ".local");
const databasePath = resolve(config.databasePath);
const productionStateRoot = resolve("/state");
if (
  !databasePath.startsWith(`${allowedRoot}${sep}`) &&
  !(
    productionCodeUpdateAllowed &&
    (databasePath === productionStateRoot ||
      databasePath.startsWith(`${productionStateRoot}${sep}`))
  )
) {
  throw new Error("非交互初始化仅允许写入仓库 .local 目录");
}

const database = openDatabase({ databasePath });
try {
  await new AuthService(database).configureAccessCode(code);
} finally {
  database.close();
}
