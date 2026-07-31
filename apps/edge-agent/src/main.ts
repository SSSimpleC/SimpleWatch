import { EdgeAgent, type AgentLogger } from "./agent.js";
import { EdgeApiClient } from "./api-client.js";
import { loadConfig } from "./config.js";
import { AgentState } from "./state.js";
import { TusUploadClient } from "./tus-client.js";

const logger: AgentLogger = {
  info: (message, fields) =>
    console.info(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) =>
    console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) =>
    console.error(JSON.stringify({ level: "error", message, ...fields })),
};

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new AgentState(config.statePath);
  const api = new EdgeApiClient(
    config.apiOrigin,
    config.agentToken,
    fetch,
    process.env.EDGE_ALLOW_INSECURE_HTTP === "true",
  );
  const tus = new TusUploadClient(fetch, config.uploadChunkBytes);
  const agent = new EdgeAgent(config, state, api, tus, logger);
  const controller = new AbortController();
  const stop = () =>
    controller.abort(new DOMException("Agent 正在停止", "AbortError"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await agent.run(controller.signal);
  } finally {
    state.close();
  }
}

void main().catch((error: unknown) => {
  logger.error("Edge Agent 启动失败", {
    error: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
