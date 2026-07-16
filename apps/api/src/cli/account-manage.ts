import { stdin, stdout } from "node:process";

import { parseAppConfig } from "@simplewatch/config";

import { openDatabase } from "../database.js";
import { AuthService } from "../services/auth-service.js";

if (process.env.ALLOW_ACCOUNT_MANAGE !== "fixed-account-maintenance") {
  throw new Error("必须显式确认固定账户维护");
}
stdin.setEncoding("utf8");
let input = "";
for await (const chunk of stdin) input += chunk;
const command = JSON.parse(input) as {
  username?: unknown;
  password?: unknown;
  enabled?: unknown;
};
if (typeof command.username !== "string") throw new Error("缺少账户名");
if (command.password !== undefined && typeof command.password !== "string") {
  throw new Error("密码格式无效");
}
if (command.enabled !== undefined && typeof command.enabled !== "boolean") {
  throw new Error("enabled格式无效");
}

const config = parseAppConfig(process.env);
const database = openDatabase({ databasePath: config.databasePath });
try {
  const account = await new AuthService(
    database,
    Date.now,
    config.passwordPepper,
  ).manageAccount({
    username: command.username,
    ...(typeof command.password === "string"
      ? { password: command.password }
      : {}),
    ...(typeof command.enabled === "boolean"
      ? { enabled: command.enabled }
      : {}),
  });
  stdout.write(`${account.username}:${account.role}\n`);
} finally {
  database.close();
}
