import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface EdgeAgentConfig {
  readonly apiOrigin: string;
  readonly agentToken: string;
  readonly libraryRoot: string;
  readonly statePath: string;
  readonly scanIntervalMs: number;
  readonly stabilityObservationMs: number;
  readonly claimWaitSeconds: number;
  readonly heartbeatIntervalMs: number;
  readonly uploadChunkBytes: number;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EdgeAgentConfig {
  const apiOrigin = requireString(environment, "EDGE_API_ORIGIN");
  const origin = new URL(apiOrigin);
  const allowHttp = environment.EDGE_ALLOW_INSECURE_HTTP === "true";
  if (origin.protocol !== "https:" && !allowHttp) {
    throw new Error("EDGE_API_ORIGIN 必须使用 HTTPS");
  }
  if (origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("EDGE_API_ORIGIN 不能包含凭据、查询参数或片段");
  }

  const tokenPath = requireString(environment, "EDGE_AGENT_TOKEN_FILE");
  const agentToken = readFileSync(tokenPath, "utf8").trim();
  if (agentToken.length < 32) throw new Error("Edge Agent 令牌无效");

  return {
    apiOrigin: origin.toString(),
    agentToken,
    libraryRoot: resolve(requireString(environment, "LIBRARY_ROOT")),
    statePath: resolve(requireString(environment, "EDGE_STATE_PATH")),
    scanIntervalMs: parsePositiveInteger(
      environment.EDGE_SCAN_INTERVAL_MS,
      5 * 60 * 1000,
      "EDGE_SCAN_INTERVAL_MS",
    ),
    stabilityObservationMs: parsePositiveInteger(
      environment.EDGE_STABILITY_OBSERVATION_MS,
      120_000,
      "EDGE_STABILITY_OBSERVATION_MS",
    ),
    claimWaitSeconds: parseIntegerInRange(
      environment.EDGE_CLAIM_WAIT_SECONDS,
      25,
      1,
      25,
      "EDGE_CLAIM_WAIT_SECONDS",
    ),
    heartbeatIntervalMs: parseIntegerInRange(
      environment.EDGE_HEARTBEAT_INTERVAL_MS,
      15_000,
      5_000,
      20_000,
      "EDGE_HEARTBEAT_INTERVAL_MS",
    ),
    uploadChunkBytes: parseIntegerInRange(
      environment.EDGE_UPLOAD_CHUNK_BYTES,
      16 * 1024 * 1024,
      1024 * 1024,
      64 * 1024 * 1024,
      "EDGE_UPLOAD_CHUNK_BYTES",
    ),
  };
}

function requireString(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function parseIntegerInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = parsePositiveInteger(value, fallback, name);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return parsed;
}
