import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import YAML from "yaml";

const pinnedNodeImage =
  "docker.m.daocloud.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const files = [
  "infra/compose/compose.local.yaml",
  "infra/compose/compose.server-ip.yaml",
];
const docker = spawnSync("docker", ["compose", "version"], {
  stdio: "ignore",
});
if (docker.status === 0) {
  const composeEnvironment = {
    ...process.env,
    RELEASE_TAG: "compose-check",
    PUBLIC_ORIGIN: "https://127.0.0.1",
    SESSION_SECRET: "s".repeat(64),
    PASSWORD_PEPPER: "p".repeat(64),
    CONTENT_SIGNING_SECRET: "c".repeat(64),
    TUS_ENDPOINT: "https://127.0.0.1/files/",
    INTERNAL_HOOK_TOKEN: "i".repeat(64),
    MEDIA_JWT_SECRET: "m".repeat(64),
    OBS_CREDENTIAL_ENCRYPTION_KEY: "o".repeat(64),
    MEDIA_ORIGIN: "https://127.0.0.1",
    LIVEKIT_API_KEY: "compose-check",
    LIVEKIT_API_SECRET: "l".repeat(64),
    LIVEKIT_URL: "wss://127.0.0.1",
    LIVEKIT_ARCHIVE_SHA256: "a".repeat(64),
    MEDIAMTX_ARCHIVE_SHA256: "b".repeat(64),
  };
  for (const file of files) {
    const result = spawnSync(
      "docker",
      ["compose", "-f", file, "config", "--quiet"],
      {
        env: composeEnvironment,
        stdio: "inherit",
      },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

for (const file of files) {
  const document = YAML.parse(readFileSync(file, "utf8"));
  if (!document || typeof document !== "object" || !document.services) {
    throw new Error(`${file} 缺少services`);
  }
}

const server = YAML.parse(readFileSync(files[1], "utf8"));
const productionServices = [
  "app",
  "worker",
  "caddy",
  "tusd",
  "mediamtx",
  "livekit",
];
for (const required of productionServices) {
  const service = server.services[required];
  if (!service) throw new Error(`生产Compose缺少${required}`);
  if (service.privileged === true)
    throw new Error(`${required}不得使用privileged`);
  if (!(service.security_opt ?? []).includes("no-new-privileges:true")) {
    throw new Error(`${required}缺少no-new-privileges`);
  }
  if (service.read_only !== true)
    throw new Error(`${required}根文件系统必须只读`);
  if (!service.mem_limit || !service.cpus || !service.pids_limit) {
    throw new Error(`${required}缺少资源与进程上限`);
  }
  if (
    service.logging?.driver !== "local" ||
    service.logging?.options?.["max-size"] !== "20m" ||
    String(service.logging?.options?.["max-file"]) !== "3"
  ) {
    throw new Error(`${required}日志必须使用local驱动并限制为20m×3`);
  }
  if (service.env_file !== undefined) {
    throw new Error(`${required}不得通过env_file注入整份生产密钥`);
  }
}

const app = server.services.app;
const worker = server.services.worker;
const caddy = server.services.caddy;
if (app.build?.args?.NODE_IMAGE !== pinnedNodeImage) {
  throw new Error("生产Compose未固定Node基础镜像digest");
}
if (JSON.stringify(app.command) !== JSON.stringify(["node", "dist/api.mjs"])) {
  throw new Error("API必须直接运行打包后的JavaScript");
}
if (
  JSON.stringify(worker.command) !== JSON.stringify(["node", "dist/worker.mjs"])
) {
  throw new Error("Worker必须直接运行打包后的JavaScript");
}
const productionCommands = JSON.stringify([app.command, worker.command]);
if (/tsx|src\/.*\.tsx?/.test(productionCommands)) {
  throw new Error("生产Compose不得执行tsx或TypeScript源码");
}
const appHealth = JSON.stringify(app.healthcheck?.test ?? []);
if (
  !appHealth.includes("/health/live") ||
  appHealth.includes("/health/ready")
) {
  throw new Error("API容器健康检查必须使用/health/live");
}
const workerHealth = JSON.stringify(worker.healthcheck?.test ?? []);
for (const requiredFragment of [
  "/api/v1/internal/worker/health",
  "workerId",
  "X-Internal-Token",
  "INTERNAL_HOOK_TOKEN",
]) {
  if (!workerHealth.includes(requiredFragment)) {
    throw new Error(`Worker健康检查缺少${requiredFragment}`);
  }
}
const caddyEnvironment = Object.keys(caddy.environment ?? {}).sort();
if (
  JSON.stringify(caddyEnvironment) !== JSON.stringify(["INTERNAL_HOOK_TOKEN"])
) {
  throw new Error("Caddy只能接收INTERNAL_HOOK_TOKEN这一项运行密钥");
}

const dockerfile = readFileSync("Dockerfile", "utf8");
if (!dockerfile.includes(`ARG NODE_IMAGE=${pinnedNodeImage}`)) {
  throw new Error("Dockerfile未固定Node基础镜像digest");
}
for (const requiredFragment of [
  "pnpm build:production",
  "pnpm --filter @simplewatch/api deploy --prod",
  "COPY --from=builder --chown=node:node /opt/runtime/node_modules ./node_modules",
  'CMD ["node", "dist/api.mjs"]',
]) {
  if (!dockerfile.includes(requiredFragment)) {
    throw new Error(`Dockerfile缺少生产运行约束：${requiredFragment}`);
  }
}
if (
  dockerfile.includes(
    "COPY --from=builder --chown=node:node /opt/simplewatch /opt/simplewatch",
  )
) {
  throw new Error("生产镜像不得复制完整开发工作区");
}

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
if (rootPackage.devDependencies?.esbuild !== "0.28.1") {
  throw new Error("esbuild必须精确固定为0.28.1");
}
if (
  rootPackage.scripts?.["build:server"] !== "node tools/build/build-server.mjs"
) {
  throw new Error("缺少可复现的服务器打包命令");
}

const deploymentScript = readFileSync("tools/server/deploy-ip-test.sh", "utf8");
for (const requiredFragment of [
  "--preserve-accounts",
  "node dist/admin-bootstrap.mjs",
  "node dist/clear-library.mjs",
]) {
  if (!deploymentScript.includes(requiredFragment)) {
    throw new Error(`生产发布脚本缺少运行约束：${requiredFragment}`);
  }
}
if (/node_modules\/tsx|apps\/api\/src\/cli/.test(deploymentScript)) {
  throw new Error("生产发布脚本不得依赖tsx或TypeScript CLI源码");
}

const caddyfile = readFileSync("infra/caddy/Caddyfile.server-ip", "utf8");
if (
  !/handle @public_health\s*\{\s*reverse_proxy app:3000\s*\}/m.test(caddyfile)
) {
  throw new Error("公网健康路由必须反向代理API真实健康状态");
}
for (const header of [
  "Authorization",
  "Cookie",
  "Upload-Token",
  "X-Internal-Token",
]) {
  if (!caddyfile.includes(`request>headers>${header} delete`)) {
    throw new Error(`Caddy访问日志未过滤敏感请求头${header}`);
  }
}
const rendered = JSON.stringify(server);
for (const forbidden of [
  "FRIEND_INVITE_TOKEN",
  "BOOTSTRAP_ADMIN_CODE",
  "260713",
]) {
  if (rendered.includes(forbidden))
    throw new Error(`Compose仍包含旧凭据：${forbidden}`);
}
process.stdout.write(
  docker.status === 0
    ? "Docker Compose与生产运行安全合同校验通过。\n"
    : "未检测到本机Docker；静态Compose安全合同校验通过，生产发布前仍须在服务器运行docker compose config。\n",
);
