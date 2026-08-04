import { getuid, stdin, stdout } from "node:process";

import { z } from "zod";

import { parseAppConfig } from "@simplewatch/config";

import { openDatabase } from "../database.js";
import { EdgeAuthService } from "../services/edge-auth-service.js";
import { EdgeTransferLifecycleService } from "../services/edge-transfer-lifecycle-service.js";

if (process.env.ALLOW_EDGE_AGENT_MANAGE !== "edge-agent-maintenance") {
  throw new Error("必须显式确认 Edge Agent 凭据维护");
}
if (process.platform !== "win32" && getuid?.() !== 0) {
  throw new Error("Edge Agent 凭据维护必须由 root 执行");
}

const commandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enroll"),
    displayName: z.string().trim().min(1).max(120),
    softwareVersion: z.string().trim().min(1).max(120),
    protocolVersion: z.number().int().positive().default(1),
    label: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({
    action: z.literal("rotate"),
    agentId: z.string().uuid(),
    label: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({ action: z.literal("revoke"), agentId: z.string().uuid() }),
]);

stdin.setEncoding("utf8");
let input = "";
for await (const chunk of stdin) input += chunk;
const command = commandSchema.parse(JSON.parse(input));
const config = parseAppConfig(process.env);
const database = openDatabase({ databasePath: config.databasePath });
try {
  const lifecycle = new EdgeTransferLifecycleService(
    database,
    config.uploadRoot,
  );
  const service = new EdgeAuthService(database, Date.now, lifecycle);
  if (command.action === "enroll") {
    stdout.write(
      `${JSON.stringify(
        service.enroll({
          displayName: command.displayName,
          softwareVersion: command.softwareVersion,
          protocolVersion: command.protocolVersion,
          ...(command.label ? { label: command.label } : {}),
        }),
      )}\n`,
    );
  } else if (command.action === "rotate") {
    stdout.write(
      `${JSON.stringify(service.rotate(command.agentId, command.label))}\n`,
    );
  } else {
    service.revoke(command.agentId);
    stdout.write(
      `${JSON.stringify({ agentId: command.agentId, revoked: true })}\n`,
    );
  }
} finally {
  database.close();
}
