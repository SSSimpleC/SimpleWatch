import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import YAML from "yaml";

const files = [
  "infra/compose/compose.local.yaml",
  "infra/compose/compose.server-ip.yaml",
];
const docker = spawnSync("docker", ["compose", "version"], {
  stdio: "ignore",
});
if (docker.status === 0) {
  for (const file of files) {
    const result = spawnSync(
      "docker",
      ["compose", "-f", file, "config", "--quiet"],
      {
        stdio: "inherit",
      },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.stdout.write("Docker Compose配置校验通过\n");
  process.exit(0);
}

for (const file of files) {
  const document = YAML.parse(readFileSync(file, "utf8"));
  if (!document || typeof document !== "object" || !document.services) {
    throw new Error(`${file} 缺少services`);
  }
}

const server = YAML.parse(readFileSync(files[1], "utf8"));
for (const required of [
  "app",
  "worker",
  "caddy",
  "tusd",
  "mediamtx",
  "livekit",
]) {
  const service = server.services[required];
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
  "未检测到本机Docker；静态Compose安全合同校验通过，生产发布前仍须在服务器运行docker compose config。\n",
);
