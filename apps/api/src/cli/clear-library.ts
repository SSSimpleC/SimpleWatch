import { resolve, sep } from "node:path";

import { parseAppConfig } from "@simplewatch/config";

import { openDatabase } from "../database.js";
import { clearLibraryData } from "../services/library-reset-service.js";

if (process.env.CLEAR_LIBRARY_CONFIRM !== "clear-all-media-uploads-and-rooms") {
  throw new Error("缺少片库清理确认值");
}

const quarantineInput = process.env.CLEAR_LIBRARY_QUARANTINE;
if (!quarantineInput) throw new Error("缺少隔离备份目录");
const quarantine = resolve(quarantineInput);
const config = parseAppConfig(process.env);
const productionRoot = resolve(
  process.env.CLEAR_LIBRARY_ALLOWED_ROOT ?? "/quarantine",
);
const developmentRoot = resolve(".local");
const allowedRoot =
  config.nodeEnv === "production" ? productionRoot : developmentRoot;
if (
  quarantine !== allowedRoot &&
  !quarantine.startsWith(`${allowedRoot}${sep}`)
) {
  throw new Error("隔离备份目录超出允许范围");
}

const database = openDatabase({ databasePath: config.databasePath });
try {
  const result = await clearLibraryData(database, {
    quarantine,
    roots: [
      config.mediaRoot,
      config.uploadRoot,
      config.inboxRoot,
      config.subtitleRoot,
      process.env.SFTP_INCOMING_ROOT,
      process.env.TRASH_ROOT,
    ].filter((value): value is string => Boolean(value)),
  });
  console.log(
    `片库、上传、房间与会话数据已清空；${result.movedEntries} 项已暂存隔离目录`,
  );
} finally {
  database.close();
}
