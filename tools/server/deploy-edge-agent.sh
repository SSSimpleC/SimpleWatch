#!/usr/bin/env bash
set -euo pipefail

approved_library=/srv/dev-disk-by-uuid-7E82064F82060C79/PLAYS/SimpleWatchLibrary
target_root=/opt/simplewatch-edge-agent
state_root=/srv/simplewatch-edge-agent/state
backup_root=/srv/simplewatch-edge-agent/backups
config_root=/etc/simplewatch-edge-agent
unit_path=/etc/systemd/system/simplewatch-edge-agent.service
verification_timeout_seconds=600

release_dir=${1:?release directory required}
edge_api_origin=${2:?Edge API HTTPS origin required}
release_tag=${3:?immutable release tag required}
library_root=${4:-$approved_library}

if [[ $(id -u) -ne 0 ]]; then
  printf '%s\n' '家庭 Edge Agent 必须由 root 部署' >&2
  exit 1
fi
if [[ ! "$release_tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || \
  [[ "$release_tag" == "." || "$release_tag" == ".." ]]; then
  printf '%s\n' 'release_tag 只能使用安全的不可变镜像标签字符' >&2
  exit 1
fi
if [[ "$edge_api_origin" =~ ^https://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$ ]]; then
  origin_port=${BASH_REMATCH[2]:-}
  origin_port=${origin_port#:}
  if [[ -n "$origin_port" ]] && \
    ((10#$origin_port < 1 || 10#$origin_port > 65535)); then
    printf '%s\n' 'EDGE_API_ORIGIN 端口范围无效' >&2
    exit 1
  fi
else
  printf '%s\n' 'EDGE_API_ORIGIN 必须是无路径、查询或片段的 HTTPS Origin' >&2
  exit 1
fi
if [[ "$library_root" != "$approved_library" ]]; then
  printf '%s\n' '拒绝部署到未经批准的 Library 路径' >&2
  exit 1
fi
if [[ ! -d "$release_dir" || -L "$release_dir" ]]; then
  printf '%s\n' '发布目录不存在或为符号链接' >&2
  exit 1
fi
release_dir=$(readlink -f -- "$release_dir")
case "$release_dir/" in
  "$target_root/"*)
    printf '%s\n' '发布源目录不得位于 Edge Agent 安装目录内' >&2
    exit 1
    ;;
esac
for required in \
  dist/edge-agent/main.mjs \
  infra/compose/compose.edge-agent.yaml \
  infra/images/edge-agent/Dockerfile \
  infra/systemd/simplewatch-edge-agent.service; do
  if [[ ! -f "$release_dir/$required" || -L "$release_dir/$required" ]]; then
    printf '发布目录缺少普通文件 %s\n' "$required" >&2
    exit 1
  fi
done
if ! command -v sha256sum >/dev/null 2>&1; then
  printf '%s\n' '缺少 sha256sum，无法绑定 Edge Agent 发布产物' >&2
  exit 1
fi
artifact_sha256=$(sha256sum "$release_dir/dist/edge-agent/main.mjs" | awk '{print $1}')
if [[ ! "$artifact_sha256" =~ ^[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'Edge Agent 构建产物 SHA-256 无效' >&2
  exit 1
fi
if [[ ! -d "$library_root" || -L "$library_root" ]]; then
  printf '%s\n' '专用 Library 不存在或为符号链接' >&2
  exit 1
fi
token_path=$config_root/agent-token
if [[ ! -s "$token_path" || -L "$token_path" ]]; then
  printf '%s\n' '缺少 Edge Agent 机器令牌；请先通过标准输入安装' >&2
  exit 1
fi
read -r token_uid token_gid token_mode < <(stat -c '%u %g %a' "$token_path")
if [[ "$token_uid:$token_gid:$token_mode" != "10001:10001:400" ]]; then
  printf '%s\n' 'Edge Agent 机器令牌必须为 10001:10001 且权限 0400' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' '缺少 Docker Compose v2' >&2
  exit 1
fi
image_ref=simplewatch-edge-agent:$release_tag
if docker image inspect "$image_ref" >/dev/null 2>&1; then
  printf '%s\n' '不可变 Edge Agent 镜像标签已经存在' >&2
  exit 1
fi

target_release=$target_root/releases/$release_tag
backup_dir=$backup_root/pre-$release_tag
current_link=$target_root/current
previous_target=""
if [[ -e "$current_link" && ! -L "$current_link" ]]; then
  printf '%s\n' 'current 必须是指向不可变发布目录的符号链接' >&2
  exit 1
fi
if [[ -L "$current_link" ]]; then
  previous_target=$(readlink -f -- "$current_link")
  if [[ ! -d "$previous_target" || \
    $(dirname -- "$previous_target") != "$target_root/releases" ]]; then
    printf '%s\n' 'current 没有直接指向一个不可变发布目录' >&2
    exit 1
  fi
fi
if [[ -e "$target_release" || -L "$target_release" ]]; then
  printf '%s\n' '不可变发布目录已经存在' >&2
  exit 1
fi
if [[ -e "$backup_dir" || -L "$backup_dir" ]]; then
  printf '%s\n' '状态备份目录已经存在' >&2
  exit 1
fi
if [[ -z "$previous_target" ]] && systemctl is-active --quiet simplewatch-edge-agent.service; then
  printf '%s\n' '服务正在运行但 current 发布链接不存在，拒绝覆盖异常状态' >&2
  exit 1
fi

service_was_active=0
service_was_enabled=0
previous_env_exists=0
previous_unit_exists=0
state_backup_complete=0
deployment_started=0
image_build_started=0
temporary_link=""
temporary_env=""
if systemctl is-active --quiet simplewatch-edge-agent.service; then
  service_was_active=1
fi
if systemctl is-enabled --quiet simplewatch-edge-agent.service; then
  service_was_enabled=1
fi
if [[ -e "$config_root/edge-agent.env" || -L "$config_root/edge-agent.env" ]]; then
  if [[ ! -f "$config_root/edge-agent.env" || -L "$config_root/edge-agent.env" ]]; then
    printf '%s\n' '现有 Edge Agent 环境文件不是普通文件' >&2
    exit 1
  fi
  previous_env_exists=1
fi
if [[ -e "$unit_path" || -L "$unit_path" ]]; then
  if [[ ! -f "$unit_path" || -L "$unit_path" ]]; then
    printf '%s\n' '现有 Edge Agent systemd 单元不是普通文件' >&2
    exit 1
  fi
  previous_unit_exists=1
fi

rollback() {
  local status=$?
  trap - EXIT
  [[ $status -eq 0 ]] && exit 0
  set +e
  if [[ $deployment_started -eq 1 ]]; then
    systemctl stop simplewatch-edge-agent.service >/dev/null 2>&1 || true
    if [[ -n "$previous_target" ]]; then
      ln -sfn "$previous_target" "$current_link"
    else
      rm -f -- "$current_link"
    fi
    if [[ $previous_env_exists -eq 1 ]]; then
      install -o root -g root -m 0600 \
        "$backup_dir/control/edge-agent.env" "$config_root/edge-agent.env"
    else
      rm -f -- "$config_root/edge-agent.env"
    fi
    if [[ $previous_unit_exists -eq 1 ]]; then
      install -o root -g root -m 0644 \
        "$backup_dir/control/simplewatch-edge-agent.service" "$unit_path"
    else
      rm -f -- "$unit_path"
    fi
    if [[ $state_backup_complete -eq 1 ]]; then
      find "$state_root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      cp -a "$backup_dir/state/." "$state_root/"
      chown -R 10001:10001 "$state_root"
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ $service_was_enabled -eq 1 ]]; then
      systemctl enable simplewatch-edge-agent.service >/dev/null 2>&1 || true
    else
      systemctl disable simplewatch-edge-agent.service >/dev/null 2>&1 || true
    fi
    if [[ $service_was_active -eq 1 ]]; then
      systemctl start simplewatch-edge-agent.service >/dev/null 2>&1 || true
    fi
    if [[ $image_build_started -eq 1 ]]; then
      docker image rm "$image_ref" >/dev/null 2>&1 || true
    fi
    [[ -n "$temporary_link" ]] && rm -f -- "$temporary_link"
    [[ -n "$temporary_env" ]] && rm -f -- "$temporary_env"
    rm -rf -- "$target_release" "$backup_dir"
  fi
  printf 'EDGE_AGENT_DEPLOY_ROLLED_BACK release=%s status=%s\n' \
    "$release_tag" "$status" >&2
  exit "$status"
}
trap rollback EXIT

umask 077
deployment_started=1
install -d -o root -g root -m 0755 "$target_root/releases"
install -d -o 10001 -g 10001 -m 0700 "$state_root"
install -d -o root -g root -m 0700 "$backup_root"
install -d -o root -g root -m 0750 "$config_root"
install -d -o root -g root -m 0700 "$backup_dir"
install -d -o root -g root -m 0700 "$backup_dir/state"
install -d -o root -g root -m 0700 "$backup_dir/control"

cp -a "$release_dir" "$target_release"
chown -R root:root "$target_release"
if [[ $previous_env_exists -eq 1 ]]; then
  cp -a "$config_root/edge-agent.env" "$backup_dir/control/edge-agent.env"
fi
if [[ $previous_unit_exists -eq 1 ]]; then
  cp -a "$unit_path" "$backup_dir/control/simplewatch-edge-agent.service"
fi
if [[ $service_was_active -eq 1 ]]; then
  systemctl stop simplewatch-edge-agent.service
fi
cp -a "$state_root/." "$backup_dir/state/"
state_backup_complete=1

temporary_env=$(mktemp "$config_root/edge-agent.env.XXXXXX")
printf 'RELEASE_TAG=%s\nEDGE_API_ORIGIN=%s\nEDGE_AGENT_ARTIFACT_SHA256=%s\n' \
  "$release_tag" "$edge_api_origin" "$artifact_sha256" >"$temporary_env"
chown root:root "$temporary_env"
chmod 0600 "$temporary_env"
mv -fT "$temporary_env" "$config_root/edge-agent.env"
temporary_env=""

temporary_link=$target_root/.current-$release_tag-$$
ln -s "$target_release" "$temporary_link"
mv -fT "$temporary_link" "$current_link"
temporary_link=""
compose=(docker compose \
  --env-file "$config_root/edge-agent.env" \
  -f "$current_link/infra/compose/compose.edge-agent.yaml")

"${compose[@]}" config --quiet
image_build_started=1
"${compose[@]}" build edge-agent
image_id=$(docker image inspect -f '{{.Id}}' "$image_ref")
image_release_tag=$(docker image inspect -f \
  '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image_ref")
image_artifact_sha256=$(docker image inspect -f \
  '{{index .Config.Labels "io.simplewatch.edge-agent.artifact-sha256"}}' \
  "$image_ref")
if [[ ! "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || \
  [[ "$image_release_tag" != "$release_tag" ]] || \
  [[ "$image_artifact_sha256" != "$artifact_sha256" ]]; then
  printf '%s\n' 'Edge Agent 镜像标签与构建产物绑定校验失败' >&2
  exit 1
fi
install -o root -g root -m 0644 \
  "$current_link/infra/systemd/simplewatch-edge-agent.service" \
  "$unit_path"
systemctl daemon-reload
verification_since=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
systemctl enable --now simplewatch-edge-agent.service

for _ in $(seq 1 30); do
  container_id=$("${compose[@]}" ps -q edge-agent)
  if [[ -n "$container_id" ]] && \
    [[ $(docker inspect -f '{{.State.Running}}' "$container_id") == "true" ]] && \
    [[ $(docker inspect -f '{{.RestartCount}}' "$container_id") == "0" ]]; then
    break
  fi
  sleep 2
done
container_id=$("${compose[@]}" ps -q edge-agent)
if [[ -z "$container_id" ]] || \
  [[ $(docker inspect -f '{{.State.Running}}' "$container_id") != "true" ]] || \
  [[ $(docker inspect -f '{{.RestartCount}}' "$container_id") != "0" ]]; then
  printf '%s\n' 'EDGE_AGENT_CONTAINER_VERIFY_FAILED running=false_or_restarted' >&2
  exit 1
fi
if [[ $(docker inspect -f '{{.Image}}' "$container_id") != "$image_id" ]]; then
  printf '%s\n' 'Edge Agent 容器没有运行本次绑定的不可变镜像' >&2
  exit 1
fi
runtime_artifact_sha256=$(docker exec "$container_id" node \
  --input-type=module --eval \
  'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; console.log(createHash("sha256").update(readFileSync("/opt/simplewatch-edge-agent/main.mjs")).digest("hex"));')
if [[ "$runtime_artifact_sha256" != "$artifact_sha256" ]]; then
  printf '%s\n' '运行中 Edge Agent 产物与发布 SHA-256 不一致' >&2
  exit 1
fi

library_mount=""
state_mount=""
token_mount=""
while IFS='|' read -r source destination writable; do
  case "$destination" in
    /library) library_mount=$source\|$writable ;;
    /state) state_mount=$source\|$writable ;;
    /run/secrets/edge_agent_token) token_mount=$source\|$writable ;;
  esac
  if [[ "$source" == */docker.sock || "$destination" == */docker.sock ]]; then
    printf '%s\n' 'Edge Agent 禁止挂载 Docker socket' >&2
    exit 1
  fi
done < <(docker inspect -f \
  '{{range .Mounts}}{{printf "%s|%s|%t\n" .Source .Destination .RW}}{{end}}' \
  "$container_id")
if [[ "$library_mount" != "$approved_library|false" ]]; then
  printf '%s\n' 'Library 来源、目标或只读属性校验失败' >&2
  exit 1
fi
if [[ "$state_mount" != "$state_root|true" ]]; then
  printf '%s\n' 'Edge Agent 状态目录挂载校验失败' >&2
  exit 1
fi
if [[ "$token_mount" != "$token_path|false" ]]; then
  printf '%s\n' 'Edge Agent 令牌挂载校验失败' >&2
  exit 1
fi
if [[ $(docker inspect -f '{{len .HostConfig.PortBindings}}' "$container_id") != "0" ]] || \
  [[ $(docker inspect -f '{{len .NetworkSettings.Ports}}' "$container_id") != "0" ]]; then
  printf '%s\n' 'Edge Agent 意外发布了入站端口' >&2
  exit 1
fi
if [[ $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container_id") != "true" ]] || \
  [[ $(docker inspect -f '{{.Config.User}}' "$container_id") != "10001:10001" ]]; then
  printf '%s\n' 'Edge Agent 运行身份或只读根文件系统校验失败' >&2
  exit 1
fi

heartbeat_verified=0
catalog_commit_verified=0
safe_logs=""
verification_deadline=$((SECONDS + verification_timeout_seconds))
while ((SECONDS < verification_deadline)); do
  if [[ $(docker inspect -f '{{.State.Running}}' "$container_id") != "true" ]] || \
    [[ $(docker inspect -f '{{.RestartCount}}' "$container_id") != "0" ]]; then
    break
  fi
  safe_logs=$(docker logs --since "$verification_since" "$container_id" 2>/dev/null || true)
  if [[ "$safe_logs" == *'"message":"Agent 已连接控制面"'* ]]; then
    heartbeat_verified=1
  fi
  if [[ "$safe_logs" == *'"message":"家庭媒体目录已同步"'* ]]; then
    catalog_commit_verified=1
  fi
  if [[ $heartbeat_verified -eq 1 && $catalog_commit_verified -eq 1 ]]; then
    break
  fi
  sleep 5
done
if [[ $heartbeat_verified -ne 1 || $catalog_commit_verified -ne 1 ]]; then
  warning_count=$(grep -c '"level":"warn"' <<<"$safe_logs" || true)
  error_count=$(grep -c '"level":"error"' <<<"$safe_logs" || true)
  printf 'EDGE_AGENT_DEPLOY_VERIFY_FAILED heartbeat=%s catalog_commit=%s warnings=%s errors=%s timeout_seconds=%s\n' \
    "$heartbeat_verified" "$catalog_commit_verified" "$warning_count" \
    "$error_count" "$verification_timeout_seconds" >&2
  exit 1
fi

verified_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
verification_summary=$target_release/edge-agent-deployment-verification.txt
temporary_summary=$(mktemp "$target_release/.edge-agent-verification.XXXXXX")
printf 'release=%s\nartifact_sha256=%s\nimage_id=%s\nheartbeat=verified\ncatalog_commit=verified\nlibrary=read-only\npublished_ports=0\nverified_at=%s\n' \
  "$release_tag" "$artifact_sha256" "$image_id" "$verified_at" \
  >"$temporary_summary"
chown root:root "$temporary_summary"
chmod 0444 "$temporary_summary"
mv -fT "$temporary_summary" "$verification_summary"

trap - EXIT
printf 'EDGE_AGENT_DEPLOY_OK release=%s artifact_sha256=%s image_id=%s heartbeat=verified catalog_commit=verified library=read-only published_ports=0\n' \
  "$release_tag" "$artifact_sha256" "$image_id"
