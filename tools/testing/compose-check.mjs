import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import YAML from "yaml";

const pinnedNodeImage =
  "docker.m.daocloud.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const pinnedEdgeNodeImage =
  "docker.1ms.run/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const files = [
  "infra/compose/compose.local.yaml",
  "infra/compose/compose.server-ip.yaml",
  "infra/compose/compose.edge-agent.yaml",
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
    EDGE_API_ORIGIN: "https://127.0.0.1",
    EDGE_AGENT_ARTIFACT_SHA256: "e".repeat(64),
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
const edge = YAML.parse(readFileSync(files[2], "utf8"));
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

const edgeAgent = edge.services?.["edge-agent"];
if (!edgeAgent) throw new Error("家庭Compose缺少edge-agent");
if (edgeAgent.privileged === true)
  throw new Error("edge-agent不得使用privileged");
if (!(edgeAgent.security_opt ?? []).includes("no-new-privileges:true")) {
  throw new Error("edge-agent缺少no-new-privileges");
}
if (edgeAgent.read_only !== true)
  throw new Error("edge-agent根文件系统必须只读");
if (!edgeAgent.mem_limit || !edgeAgent.cpus || !edgeAgent.pids_limit) {
  throw new Error("edge-agent缺少资源与进程上限");
}
if ((edgeAgent.ports ?? []).length > 0)
  throw new Error("edge-agent不得开放入站端口");
if ((edgeAgent.expose ?? []).length > 0 || edgeAgent.network_mode === "host") {
  throw new Error("edge-agent不得暴露端口或使用host网络");
}
if ("EDGE_AGENT_TOKEN" in (edgeAgent.environment ?? {})) {
  throw new Error("edge-agent令牌不得直接放入环境变量");
}
const edgeVolumes = edgeAgent.volumes ?? [];
if (edgeVolumes.length !== 3) {
  throw new Error("edge-agent只允许Library、状态与令牌三项固定挂载");
}
const libraryVolume = edgeVolumes.find(
  (volume) => typeof volume === "object" && volume.target === "/library",
);
if (
  !libraryVolume ||
  libraryVolume.type !== "bind" ||
  libraryVolume.source !==
    "/srv/dev-disk-by-uuid-7E82064F82060C79/PLAYS/SimpleWatchLibrary" ||
  libraryVolume.read_only !== true ||
  libraryVolume.bind?.create_host_path !== false
) {
  throw new Error("edge-agent必须以只读方式挂载专用Library");
}
const stateVolume = edgeVolumes.find(
  (volume) => typeof volume === "object" && volume.target === "/state",
);
if (
  !stateVolume ||
  stateVolume.type !== "bind" ||
  stateVolume.source !== "/srv/simplewatch-edge-agent/state" ||
  stateVolume.read_only === true ||
  stateVolume.bind?.create_host_path !== false
) {
  throw new Error("edge-agent状态目录必须是唯一固定的可写持久挂载");
}
const tokenVolume = edgeVolumes.find(
  (volume) =>
    typeof volume === "object" &&
    volume.target === "/run/secrets/edge_agent_token",
);
if (
  !tokenVolume ||
  tokenVolume.type !== "bind" ||
  tokenVolume.source !== "/etc/simplewatch-edge-agent/agent-token" ||
  tokenVolume.read_only !== true ||
  tokenVolume.bind?.create_host_path !== false
) {
  throw new Error("edge-agent令牌必须从固定0400文件只读挂载");
}
const serializedEdgeVolumes = JSON.stringify(edgeVolumes);
if (serializedEdgeVolumes.includes("docker.sock")) {
  throw new Error("edge-agent不得挂载Docker socket");
}
if (
  edgeAgent.environment?.LIBRARY_ROOT !== "/library" ||
  edgeAgent.environment?.EDGE_AGENT_TOKEN_FILE !==
    "/run/secrets/edge_agent_token"
) {
  throw new Error("edge-agent容器路径必须绑定固定Library与令牌挂载点");
}
if (
  edgeAgent.user !== "10001:10001" ||
  JSON.stringify(edgeAgent.cap_drop) !== JSON.stringify(["ALL"])
) {
  throw new Error("edge-agent必须以10001身份运行并移除全部Linux capabilities");
}
if (edgeAgent.environment?.EDGE_HEARTBEAT_INTERVAL_MS !== "15000") {
  throw new Error("edge-agent心跳必须小于60秒租约的三分之一");
}
if (
  edgeAgent.build?.args?.EDGE_AGENT_RELEASE_TAG !==
    "${RELEASE_TAG:?RELEASE_TAG is required}" ||
  edgeAgent.build?.args?.EDGE_AGENT_ARTIFACT_SHA256 !==
    "${EDGE_AGENT_ARTIFACT_SHA256:?EDGE_AGENT_ARTIFACT_SHA256 is required}"
) {
  throw new Error("edge-agent镜像必须绑定发布标签与构建产物SHA-256");
}
if (edgeAgent.build?.args?.NODE_IMAGE !== pinnedEdgeNodeImage) {
  throw new Error("Edge Agent Compose未固定经家庭网络验证的Node基础镜像digest");
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
const edgeDockerfile = readFileSync(
  "infra/images/edge-agent/Dockerfile",
  "utf8",
);
if (!dockerfile.includes(`ARG NODE_IMAGE=${pinnedNodeImage}`)) {
  throw new Error("Dockerfile未固定Node基础镜像digest");
}
if (!edgeDockerfile.includes(`ARG NODE_IMAGE=${pinnedEdgeNodeImage}`)) {
  throw new Error("Edge Agent Dockerfile未固定Node基础镜像digest");
}
if (edgeDockerfile.includes("ffmpeg") || edgeDockerfile.includes("apt-get")) {
  throw new Error("Edge Agent镜像不得继承云端媒体处理依赖");
}
if (!edgeDockerfile.includes('CMD ["node", "main.mjs"]')) {
  throw new Error("Edge Agent镜像必须直接运行打包后的JavaScript");
}
for (const requiredFragment of [
  "ARG EDGE_AGENT_RELEASE_TAG",
  "ARG EDGE_AGENT_ARTIFACT_SHA256",
  'org.opencontainers.image.version="${EDGE_AGENT_RELEASE_TAG}"',
  'io.simplewatch.edge-agent.artifact-sha256="${EDGE_AGENT_ARTIFACT_SHA256}"',
]) {
  if (!edgeDockerfile.includes(requiredFragment)) {
    throw new Error(`Edge Agent镜像缺少发布产物绑定：${requiredFragment}`);
  }
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

const edgeDeploymentScripts = [
  "tools/server/install-edge-agent-token.sh",
  "tools/server/deploy-edge-agent.sh",
];
for (const script of edgeDeploymentScripts) {
  if ((statSync(script).mode & 0o111) === 0) {
    throw new Error(`${script}缺少可执行位`);
  }
  const syntax = spawnSync("bash", ["-n", script], { stdio: "inherit" });
  if (syntax.status !== 0) throw new Error(`${script}未通过bash -n`);
}
const tokenInstaller = readFileSync(edgeDeploymentScripts[0], "utf8");
for (const requiredFragment of [
  "umask 077",
  "chown 10001:10001",
  "chmod 0400",
  "10001:10001:400",
]) {
  if (!tokenInstaller.includes(requiredFragment)) {
    throw new Error(`令牌安装脚本缺少约束：${requiredFragment}`);
  }
}
const tokenOutputLines = tokenInstaller
  .split("\n")
  .filter((line) => /(?:printf|echo).*\$token/.test(line));
if (tokenOutputLines.some((line) => !line.includes('>"$temporary"'))) {
  throw new Error("令牌安装脚本不得回显机器令牌");
}
const edgeDeployment = readFileSync(edgeDeploymentScripts[1], "utf8");
for (const requiredFragment of [
  "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
  "EDGE_AGENT_DEPLOY_ROLLED_BACK",
  'rm -f -- "$current_link"',
  'cp -a "$backup_dir/state/." "$state_root/"',
  '"$library_mount" != "$approved_library|false"',
  '"$token_mount" != "$token_path|false"',
  "{{len .HostConfig.PortBindings}}",
  "verification_timeout_seconds=600",
  'sha256sum "$release_dir/dist/edge-agent/main.mjs"',
  "EDGE_AGENT_ARTIFACT_SHA256",
  "io.simplewatch.edge-agent.artifact-sha256",
  'readFileSync("/opt/simplewatch-edge-agent/main.mjs")',
  '"message":"Agent 已连接控制面"',
  '"message":"家庭媒体目录已同步"',
  "EDGE_AGENT_DEPLOY_VERIFY_FAILED",
  "edge-agent-deployment-verification.txt",
  'docker image rm "$image_ref"',
  "heartbeat=verified",
  "catalog_commit=verified",
]) {
  if (!edgeDeployment.includes(requiredFragment)) {
    throw new Error(`Edge部署脚本缺少安全约束：${requiredFragment}`);
  }
}
if (/logs --tail|docker logs[^\n]*>&2/.test(edgeDeployment)) {
  throw new Error("Edge部署失败不得向终端倾倒可能含家庭路径的原始容器日志");
}
const edgeAgentSource = readFileSync("apps/edge-agent/src/agent.ts", "utf8");
for (const safeSuccessEvent of [
  'this.#logger.info("Agent 已连接控制面");',
  'this.#logger.info("家庭媒体目录已同步", {',
]) {
  if (!edgeAgentSource.includes(safeSuccessEvent)) {
    throw new Error(`Edge Agent缺少脱敏发布验证事件：${safeSuccessEvent}`);
  }
}
const edgeUnit = readFileSync(
  "infra/systemd/simplewatch-edge-agent.service",
  "utf8",
);
for (const requiredFragment of [
  "RequiresMountsFor=/srv/dev-disk-by-uuid-7E82064F82060C79/PLAYS/SimpleWatchLibrary",
  "BindsTo=srv-dev\\x2ddisk\\x2dby\\x2duuid\\x2d7E82064F82060C79.mount",
  "NoNewPrivileges=yes",
  "ProtectSystem=strict",
]) {
  if (!edgeUnit.includes(requiredFragment)) {
    throw new Error(`Edge systemd单元缺少约束：${requiredFragment}`);
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
