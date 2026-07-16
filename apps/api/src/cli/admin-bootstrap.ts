import { stdin, stdout } from "node:process";

import { parseAppConfig } from "@simplewatch/config";

import { openDatabase } from "../database.js";
import {
  AuthService,
  type ProvisionedAccount,
} from "../services/auth-service.js";

const expectedAccounts = new Map([
  ["host", "host"],
  ["simple", "viewer"],
  ["fj233", "viewer"],
  ["conflict", "viewer"],
  ["fpliy", "viewer"],
  ["lorrence", "viewer"],
] as const);

if (process.env.ALLOW_ACCOUNT_PROVISION !== "fixed-account-replacement") {
  throw new Error("必须显式确认固定账户替换");
}

stdin.setEncoding("utf8");
let input = "";
for await (const chunk of stdin) input += chunk;
const raw: unknown = JSON.parse(input);
if (!Array.isArray(raw)) throw new Error("账户输入必须是JSON数组");
const accounts = raw as ProvisionedAccount[];
if (accounts.length !== expectedAccounts.size)
  throw new Error("必须提供恰好六个固定账户");
const seen = new Set<string>();
for (const account of accounts) {
  if (
    !account ||
    typeof account.username !== "string" ||
    typeof account.password !== "string" ||
    (account.role !== "host" && account.role !== "viewer")
  ) {
    throw new Error("账户结构无效");
  }
  const folded = account.username.trim().toLocaleLowerCase("en-US");
  const expectedRole = expectedAccounts.get(
    folded as "host" | "simple" | "fj233" | "conflict" | "fpliy" | "lorrence",
  );
  if (!expectedRole || account.role !== expectedRole || seen.has(folded)) {
    throw new Error(`固定账户或角色不匹配：${account.username}`);
  }
  seen.add(folded);
}

const config = parseAppConfig(process.env);
const database = openDatabase({ databasePath: config.databasePath });
try {
  const provisioned = await new AuthService(
    database,
    Date.now,
    config.passwordPepper,
  ).provisionAccounts(accounts);
  stdout.write(
    `${provisioned.map((account) => `${account.username}:${account.role}`).join("\n")}\n`,
  );
} finally {
  database.close();
}
