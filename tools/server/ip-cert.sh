#!/usr/bin/env bash
set -euo pipefail

mode=${1:?usage: ip-cert.sh bootstrap|staging|issue|renew|status [public-ip]}
public_ip=${2:-8.134.239.34}
release_dir=${SIMPLEWATCH_RELEASE_DIR:-/opt/simplewatch/current}
cert_root=${SIMPLEWATCH_CERT_ROOT:-/srv/simplewatch/ip-cert}
webroot=${SIMPLEWATCH_ACME_WEBROOT:-/srv/simplewatch/acme-webroot}
state_root=${SIMPLEWATCH_CERTBOT_STATE:-/srv/simplewatch/certbot}
staging_state_root=${SIMPLEWATCH_CERTBOT_STAGING_STATE:-/srv/simplewatch/certbot-staging}
image_lock=${SIMPLEWATCH_CERTBOT_IMAGE_LOCK:-/srv/simplewatch/certbot-image.digest}
cert_name=simplewatch-ip

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    echo "必须以 root 运行证书管理脚本" >&2
    exit 1
  fi
}

resolve_image() {
  if [[ -s "$image_lock" ]]; then
    cat "$image_lock"
    return
  fi
  local tagged resolved
  for tagged in \
    docker.m.daocloud.io/certbot/certbot:v5.7.0 \
    docker.io/certbot/certbot:v5.7.0; do
    if ! docker image inspect "$tagged" >/dev/null 2>&1 &&
      ! docker pull "$tagged" >/dev/null; then
      continue
    fi
    resolved=$(docker image inspect --format '{{index .RepoDigests 0}}' "$tagged")
    if [[ "$resolved" == *@sha256:* ]]; then
      install -D -m 0644 /dev/null "$image_lock"
      printf '%s\n' "$resolved" >"$image_lock"
      printf '%s\n' "$resolved"
      return
    fi
  done
  echo "无法通过镜像加速或 Docker Hub 锁定 Certbot 镜像摘要" >&2
  exit 1
}

run_certbot() {
  local state=$1
  shift
  local image
  image=$(resolve_image)
  mkdir -p "$state" "$webroot"
  docker run --rm \
    -v "$state:/etc/letsencrypt" \
    -v "$webroot:/var/www/acme" \
    "$image" "$@"
}

validate_certificate() {
  local chain=$1
  local key=$2
  openssl x509 -in "$chain" -noout -checkip "$public_ip" >/dev/null
  openssl x509 -in "$chain" -noout -checkend 432000 >/dev/null
  local cert_public key_public
  cert_public=$(openssl x509 -in "$chain" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)
  key_public=$(openssl pkey -in "$key" -pubout -outform DER | sha256sum | cut -d' ' -f1)
  [[ "$cert_public" == "$key_public" ]]
}

install_certificate() {
  local chain=$1
  local key=$2
  # ShellCheck 0.11 在此处会误判已经位于上方的函数定义。
  # shellcheck disable=SC2218
  validate_certificate "$chain" "$key"
  local fingerprint current_fingerprint=""
  fingerprint=$(openssl x509 -in "$chain" -noout -fingerprint -sha256)
  if [[ -s "$cert_root/current/fullchain.pem" ]]; then
    current_fingerprint=$(openssl x509 -in "$cert_root/current/fullchain.pem" -noout -fingerprint -sha256 || true)
  fi
  if [[ "$fingerprint" == "$current_fingerprint" ]]; then
    echo "证书未变化：$fingerprint"
    return 1
  fi

  local timestamp temporary final next_link
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  temporary="$cert_root/releases/.${timestamp}.$$"
  final="$cert_root/releases/$timestamp"
  next_link="$cert_root/.current.$$"
  mkdir -p "$temporary" "$cert_root/releases"
  install -m 0640 "$chain" "$temporary/fullchain.pem"
  install -m 0640 "$key" "$temporary/privkey.pem"
  chown -R root:1000 "$temporary"
  mv "$temporary" "$final"
  chown root:1000 "$cert_root" "$cert_root/releases" "$final"
  chmod 0750 "$cert_root" "$cert_root/releases" "$final"
  ln -s "releases/$timestamp" "$next_link"
  mv -Tf "$next_link" "$cert_root/current"
  echo "已安装证书：$fingerprint"
  return 0
}

restart_caddy_if_running() {
  if ! docker ps --format '{{.Names}}' | grep -Fxq simplewatch-server-caddy-1; then
    return
  fi
  cd "$release_dir"
  docker compose --env-file .env.server \
    -f infra/compose/compose.server-ip.yaml restart caddy
}

bootstrap_certificate() {
  mkdir -p "$cert_root/releases" "$webroot"
  chown root:1000 "$cert_root" "$cert_root/releases"
  chmod 0750 "$cert_root" "$cert_root/releases"
  if [[ -s "$cert_root/current/fullchain.pem" && -s "$cert_root/current/privkey.pem" ]]; then
    return
  fi
  local temporary_root
  temporary_root=$(mktemp -d "$cert_root/.bootstrap.XXXXXX")
  if [[ -s "$cert_root/ip.crt" && -s "$cert_root/ip.key" ]]; then
    cp "$cert_root/ip.crt" "$temporary_root/fullchain.pem"
    cp "$cert_root/ip.key" "$temporary_root/privkey.pem"
  else
    openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 7 \
      -keyout "$temporary_root/privkey.pem" \
      -out "$temporary_root/fullchain.pem" \
      -subj "/CN=${public_ip}" \
      -addext "subjectAltName=IP:${public_ip}" \
      -addext "keyUsage=digitalSignature,keyEncipherment" \
      -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
  fi
  install_certificate "$temporary_root/fullchain.pem" "$temporary_root/privkey.pem" || true
  rm -rf "$temporary_root"
}

issue_certificate() {
  local state=$1
  shift
  run_certbot "$state" certonly "$@" \
    --preferred-profile shortlived \
    --webroot --webroot-path /var/www/acme \
    --ip-address "$public_ip" \
    --cert-name "$cert_name" \
    --agree-tos --register-unsafely-without-email --non-interactive
}

require_root
case "$mode" in
  bootstrap)
    bootstrap_certificate
    ;;
  staging)
    rm -rf "$staging_state_root"
    issue_certificate "$staging_state_root" \
      --server https://acme-staging-v02.api.letsencrypt.org/directory
    validate_certificate \
      "$staging_state_root/live/$cert_name/fullchain.pem" \
      "$staging_state_root/live/$cert_name/privkey.pem"
    echo "Let's Encrypt staging IP 证书签发验证通过（未替换当前证书）"
    ;;
  issue)
    issue_certificate "$state_root"
    if install_certificate \
      "$state_root/live/$cert_name/fullchain.pem" \
      "$state_root/live/$cert_name/privkey.pem"; then
      restart_caddy_if_running
    fi
    ;;
  renew)
    image=$(resolve_image)
    mkdir -p "$state_root" "$webroot"
    docker run --rm \
      -v "$state_root:/etc/letsencrypt" \
      -v "$webroot:/var/www/acme" \
      "$image" renew --cert-name "$cert_name" --non-interactive
    if install_certificate \
      "$state_root/live/$cert_name/fullchain.pem" \
      "$state_root/live/$cert_name/privkey.pem"; then
      restart_caddy_if_running
    fi
    ;;
  status)
    openssl x509 -in "$cert_root/current/fullchain.pem" \
      -noout -subject -issuer -serial -dates -ext subjectAltName
    ;;
  *)
    echo "未知模式：$mode" >&2
    exit 2
    ;;
esac
