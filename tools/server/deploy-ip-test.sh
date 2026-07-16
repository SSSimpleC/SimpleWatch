#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?release directory required}
public_ip=${2:?public IP required}
public_port=${3:-443}
clear_existing_data=${4:-false}
accounts_file=${5:?root-only fixed account JSON file required}
if [[ "$public_port" == "443" ]]; then
  public_origin="https://${public_ip}"
else
  public_origin="https://${public_ip}:${public_port}"
fi
cd "$release_dir"
umask 077

sysctl_target=/etc/sysctl.d/99-simplewatch-rtc.conf
sysctl_backup="$release_dir/.server/sysctl-predeploy.conf"
sysctl_absent="$release_dir/.server/sysctl-predeploy.absent"
sysctl_runtime_backup="$release_dir/.server/sysctl-runtime-predeploy"
sysctl_changed=false
restore_sysctl() {
  if [[ "$sysctl_changed" != "true" ]]; then return; fi
  if [[ -f "$sysctl_backup" ]]; then
    cp "$sysctl_backup" "$sysctl_target"
  elif [[ -f "$sysctl_absent" ]]; then
    rm -f "$sysctl_target"
  fi
  sysctl --system >/dev/null
  if [[ -f "$sysctl_runtime_backup" ]]; then
    # shellcheck disable=SC1090
    source "$sysctl_runtime_backup"
    sysctl -w "net.core.rmem_max=$PREVIOUS_RMEM_MAX" >/dev/null
    sysctl -w "net.core.wmem_max=$PREVIOUS_WMEM_MAX" >/dev/null
  fi
}
on_exit() {
  local status=$?
  trap - EXIT
  if [[ -f "$accounts_file" ]]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u "$accounts_file"
    else
      rm -f "$accounts_file"
    fi
  fi
  if [[ $status -ne 0 ]]; then restore_sysctl; fi
  exit "$status"
}
trap on_exit EXIT

secret() { openssl rand -hex 32; }
set_env() {
  local key=$1 value=$2 temporary
  temporary=$(mktemp .env.server.XXXXXX)
  if [[ -f .env.server ]]; then
    grep -v "^${key}=" .env.server >"$temporary" || true
  fi
  printf '%s=%s\n' "$key" "$value" >>"$temporary"
  mv "$temporary" .env.server
}
remove_env() {
  local key=$1 temporary
  temporary=$(mktemp .env.server.XXXXXX)
  grep -v "^${key}=" .env.server >"$temporary" || true
  mv "$temporary" .env.server
}

if [[ ! -f .env.server && -f /opt/simplewatch/current/.env.server ]]; then
  cp /opt/simplewatch/current/.env.server .env.server
fi
if [[ ! -f .env.server ]]; then
  livekit_key="sw_$(openssl rand -hex 8)"
  cat >.env.server <<EOF
SESSION_SECRET=$(secret)
PASSWORD_PEPPER=$(secret)
CONTENT_SIGNING_SECRET=$(secret)
INTERNAL_HOOK_TOKEN=$(secret)
MEDIA_JWT_SECRET=$(secret)
OBS_CREDENTIAL_ENCRYPTION_KEY=$(secret)
LIVEKIT_API_KEY=${livekit_key}
LIVEKIT_API_SECRET=$(secret)
EOF
fi

set_env RELEASE_TAG "$(basename "$release_dir")"
set_env PUBLIC_ORIGIN "$public_origin"
password_pepper=$(grep '^PASSWORD_PEPPER=' .env.server | cut -d= -f2- || true)
if [[ ${#password_pepper} -lt 32 ]]; then
  password_pepper=$(secret)
fi
set_env PASSWORD_PEPPER "$password_pepper"
obs_credential_key=$(grep '^OBS_CREDENTIAL_ENCRYPTION_KEY=' .env.server | cut -d= -f2- || true)
if [[ ${#obs_credential_key} -lt 32 ]]; then
  obs_credential_key=$(secret)
fi
set_env OBS_CREDENTIAL_ENCRYPTION_KEY "$obs_credential_key"
set_env MEDIA_ORIGIN "$public_origin"
set_env LIVEKIT_URL "${public_origin/https:/wss:}"
set_env TUS_ENDPOINT "${public_origin}/files/"
set_env MEDIAMTX_CONTROL_URL "http://mediamtx:9997"
remove_env FRIEND_INVITE_TOKEN
remove_env ALLOW_NONINTERACTIVE_BOOTSTRAP
remove_env BOOTSTRAP_ADMIN_CODE
remove_env BOOTSTRAP_ADMIN_USERNAME
remove_env BOOTSTRAP_ADMIN_PASSWORD
chmod 600 .env.server
[[ -f "$accounts_file" ]]
[[ "$(stat -c '%a' "$accounts_file")" == "600" ]]

set -a
# `.env.server` 由本脚本在当前发布目录中生成或继承。
# shellcheck disable=SC1091
source .env.server
set +a

mkdir -p \
  /srv/simplewatch/{state,media,uploads,inbox,subtitles,trash,quarantine,acme-webroot} \
  /srv/simplewatch/sftp/incoming
chown 1000:1000 /srv/simplewatch/{state,media,uploads,inbox,subtitles,trash,quarantine}
chmod 0750 /srv/simplewatch/{state,media,uploads,inbox,subtitles,trash,quarantine}
chown root:root /srv/simplewatch/acme-webroot
chmod 0755 /srv/simplewatch/acme-webroot
SIMPLEWATCH_RELEASE_DIR="$release_dir" \
  tools/server/ip-cert.sh bootstrap "$public_ip"

vendor_dir="$release_dir/.server/vendor"
mkdir -p "$vendor_dir"
if [[ -d /opt/simplewatch/current/.server/vendor ]] &&
  [[ "$(readlink -f /opt/simplewatch/current)" != "$(readlink -f "$release_dir")" ]]; then
  cp -a /opt/simplewatch/current/.server/vendor/. "$vendor_dir/"
fi
livekit_archive="livekit_1.13.1_linux_amd64.tar.gz"
mediamtx_archive="mediamtx_v1.18.2_linux_amd64.tar.gz"
if [[ ! -x "$vendor_dir/livekit-server" ]]; then
  [[ -f "$vendor_dir/$livekit_archive" ]] || curl -fsSL --retry 3 -o "$vendor_dir/$livekit_archive" "https://github.com/livekit/livekit/releases/download/v1.13.1/$livekit_archive"
  [[ -f "$vendor_dir/livekit-checksums.txt" ]] || curl -fsSL --retry 3 -o "$vendor_dir/livekit-checksums.txt" "https://github.com/livekit/livekit/releases/download/v1.13.1/checksums.txt"
  (cd "$vendor_dir" && grep "$livekit_archive\$" livekit-checksums.txt | sha256sum -c -)
  tar -xzf "$vendor_dir/$livekit_archive" -C "$vendor_dir" livekit-server
fi
if [[ ! -x "$vendor_dir/mediamtx" ]]; then
  [[ -f "$vendor_dir/$mediamtx_archive" ]] || curl -fsSL --retry 3 -o "$vendor_dir/$mediamtx_archive" "https://github.com/bluenviron/mediamtx/releases/download/v1.18.2/$mediamtx_archive"
  [[ -f "$vendor_dir/mediamtx-checksums.txt" ]] || curl -fsSL --retry 3 -o "$vendor_dir/mediamtx-checksums.txt" "https://github.com/bluenviron/mediamtx/releases/download/v1.18.2/checksums.sha256"
  (cd "$vendor_dir" && grep "$mediamtx_archive\$" mediamtx-checksums.txt | sha256sum -c -)
  tar -xzf "$vendor_dir/$mediamtx_archive" -C "$vendor_dir" mediamtx
fi
chmod 755 "$vendor_dir/livekit-server" "$vendor_dir/mediamtx"
export LIVEKIT_ARCHIVE_SHA256 MEDIAMTX_ARCHIVE_SHA256
LIVEKIT_ARCHIVE_SHA256=$(sha256sum "$vendor_dir/$livekit_archive" | cut -d' ' -f1)
MEDIAMTX_ARCHIVE_SHA256=$(sha256sum "$vendor_dir/$mediamtx_archive" | cut -d' ' -f1)
sed \
  -e "s/__LIVEKIT_API_KEY__/${LIVEKIT_API_KEY}/g" \
  -e "s/__LIVEKIT_API_SECRET__/${LIVEKIT_API_SECRET}/g" \
  infra/livekit/livekit.server-ip.template.yaml >infra/livekit/livekit.server-ip.yaml
chmod 600 infra/livekit/livekit.server-ip.yaml

compose=(docker compose --env-file .env.server -f infra/compose/compose.server-ip.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" pull --policy missing caddy
docker tag ghcr.io/tus/tusd:v2.9.2 docker.m.daocloud.io/tusproject/tusd:v2.9.2 2>/dev/null || true
"${compose[@]}" pull --policy missing tusd
docker image inspect "simplewatch-app:${RELEASE_TAG}" >/dev/null 2>&1 || "${compose[@]}" build app
docker image inspect "simplewatch-mediamtx:${RELEASE_TAG}" >/dev/null 2>&1 || "${compose[@]}" build mediamtx
docker image inspect "simplewatch-livekit:${RELEASE_TAG}" >/dev/null 2>&1 || "${compose[@]}" build livekit

mkdir -p "$release_dir/.server"
rm -f "$sysctl_backup" "$sysctl_absent" "$sysctl_runtime_backup"
printf 'PREVIOUS_RMEM_MAX=%q\nPREVIOUS_WMEM_MAX=%q\n' \
  "$(sysctl -n net.core.rmem_max)" "$(sysctl -n net.core.wmem_max)" \
  >"$sysctl_runtime_backup"
if [[ -f "$sysctl_target" ]]; then
  cp "$sysctl_target" "$sysctl_backup"
else
  : >"$sysctl_absent"
fi
install -m 0644 infra/sysctl/99-simplewatch-rtc.conf "$sysctl_target"
sysctl --system >/dev/null
sysctl_changed=true
[[ "$(sysctl -n net.core.rmem_max)" -ge 7500000 ]]
[[ "$(sysctl -n net.core.wmem_max)" -ge 7500000 ]]

# The project name is fixed in Compose, so this stops only SimpleWatch and leaves
# FRP, DERP and the unrelated MES stack untouched.
"${compose[@]}" down --remove-orphans

"${compose[@]}" run --rm -T \
  -e ALLOW_ACCOUNT_PROVISION=fixed-account-replacement \
  app node apps/api/node_modules/tsx/dist/cli.mjs \
  apps/api/src/cli/admin-bootstrap.ts <"$accounts_file"
if command -v shred >/dev/null 2>&1; then
  shred -u "$accounts_file"
else
  rm -f "$accounts_file"
fi

if [[ "$clear_existing_data" == "true" ]]; then
  quarantine_id="pre-${RELEASE_TAG}-$(date -u +%Y%m%dT%H%M%SZ)"
  "${compose[@]}" run --rm --user 0:0 --cap-add DAC_OVERRIDE \
    -e CLEAR_LIBRARY_CONFIRM=clear-all-media-uploads-and-rooms \
    -e CLEAR_LIBRARY_ALLOWED_ROOT=/srv-data/quarantine \
    -e CLEAR_LIBRARY_QUARANTINE="/srv-data/quarantine/${quarantine_id}" \
    -e DATABASE_PATH=/srv-data/state/simplewatch.sqlite3 \
    -e MEDIA_ROOT=/srv-data/media \
    -e UPLOAD_ROOT=/srv-data/uploads \
    -e INBOX_ROOT=/srv-data/inbox \
    -e SUBTITLE_ROOT=/srv-data/subtitles \
    -e TRASH_ROOT=/srv-data/trash \
    -e SFTP_INCOMING_ROOT=/srv-data/sftp/incoming \
    -v /srv/simplewatch:/srv-data \
    app node apps/api/node_modules/tsx/dist/cli.mjs \
    apps/api/src/cli/clear-library.ts
  printf '%s\n' "$quarantine_id" >/srv/simplewatch/last-library-quarantine
fi

"${compose[@]}" up -d --wait --wait-timeout 180
ln -sfn "$release_dir" /opt/simplewatch/current

if ! openssl x509 -in /srv/simplewatch/ip-cert/current/fullchain.pem \
  -noout -issuer | grep -qi "Let's Encrypt"; then
  SIMPLEWATCH_RELEASE_DIR="$release_dir" \
    tools/server/ip-cert.sh staging "$public_ip"
  SIMPLEWATCH_RELEASE_DIR="$release_dir" \
    tools/server/ip-cert.sh issue "$public_ip"
fi

install -m 0644 infra/systemd/simplewatch-ip-cert.service \
  /etc/systemd/system/simplewatch-ip-cert.service
install -m 0644 infra/systemd/simplewatch-ip-cert.timer \
  /etc/systemd/system/simplewatch-ip-cert.timer
systemctl daemon-reload
systemctl enable --now simplewatch-ip-cert.timer

curl --fail --silent --show-error --max-time 10 \
  "${public_origin}/health/ready" >/dev/null
tools/server/ip-cert.sh status "$public_ip"
"${compose[@]}" ps
sysctl_changed=false
