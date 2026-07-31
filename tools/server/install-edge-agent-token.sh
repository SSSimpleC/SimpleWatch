#!/usr/bin/env bash
set -euo pipefail

if [[ ${ALLOW_EDGE_AGENT_TOKEN_INSTALL:-} != "edge-agent-token-install" ]]; then
  printf '%s\n' '必须显式确认 Edge Agent 令牌安装' >&2
  exit 1
fi
if [[ $(id -u) -ne 0 ]]; then
  printf '%s\n' 'Edge Agent 令牌必须由 root 安装' >&2
  exit 1
fi

umask 077
IFS= read -r token
if [[ ${#token} -lt 32 || ${#token} -gt 4096 ]]; then
  printf '%s\n' 'Edge Agent 令牌长度无效' >&2
  exit 1
fi
if IFS= read -r unexpected; then
  printf '%s\n' 'Edge Agent 令牌输入只能包含一行' >&2
  exit 1
fi

install -d -o root -g root -m 0750 /etc/simplewatch-edge-agent
temporary=$(mktemp /etc/simplewatch-edge-agent/agent-token.XXXXXX)
trap 'rm -f "$temporary"' EXIT
printf '%s\n' "$token" >"$temporary"
chown 10001:10001 "$temporary"
chmod 0400 "$temporary"
mv -fT "$temporary" /etc/simplewatch-edge-agent/agent-token
trap - EXIT
read -r installed_uid installed_gid installed_mode < <(
  stat -c '%u %g %a' /etc/simplewatch-edge-agent/agent-token
)
if [[ "$installed_uid:$installed_gid:$installed_mode" != "10001:10001:400" ]]; then
  printf '%s\n' 'Edge Agent 令牌权限校验失败' >&2
  exit 1
fi
printf '%s\n' 'EDGE_AGENT_TOKEN_INSTALLED'
