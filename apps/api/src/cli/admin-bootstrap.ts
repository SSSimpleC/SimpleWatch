import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { parseAppConfig } from "@simplewatch/config";

import { openDatabase } from "../database.js";
import { AppError } from "../errors.js";
import { AuthService } from "../services/auth-service.js";

if (!stdin.isTTY || !stdout.isTTY) {
  console.error("admin-bootstrap 必须在 TTY 中运行");
  process.exit(1);
}

const config = parseAppConfig(process.env);
const database = openDatabase({ databasePath: config.databasePath });
const readline = createInterface({ input: stdin, output: stdout });

try {
  const code = await readHidden("输入 6 位放映口令：");
  const confirmation = await readHidden("再次输入放映口令：");
  if (code !== confirmation) throw new Error("两次输入的口令不一致");

  const admin = await new AuthService(database).configureAccessCode(code);
  stdout.write(`放映员 ${admin.username} 的口令已更新，旧控制台会话已撤销。\n`);
} catch (error) {
  if (error instanceof AppError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(error instanceof Error ? error.message : "初始化失败");
    process.exitCode = 1;
  }
} finally {
  readline.close();
  database.close();
}

async function readHidden(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (key: string) => {
      if (key === "\u0003") {
        cleanup();
        reject(new Error("操作已取消"));
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (key === "\u007f" || key === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += key;
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}
