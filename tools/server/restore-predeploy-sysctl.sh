#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?release directory containing the predeploy backup is required}
target=/etc/sysctl.d/99-simplewatch-rtc.conf
backup="$release_dir/.server/sysctl-predeploy.conf"
absent="$release_dir/.server/sysctl-predeploy.absent"
runtime="$release_dir/.server/sysctl-runtime-predeploy"

if [[ -f "$backup" ]]; then
  install -m 0644 "$backup" "$target"
elif [[ -f "$absent" ]]; then
  rm -f "$target"
else
  echo "predeploy sysctl file state is missing" >&2
  exit 1
fi

sysctl --system >/dev/null
if [[ -f "$runtime" ]]; then
  # shellcheck disable=SC1090
  source "$runtime"
  sysctl -w "net.core.rmem_max=$PREVIOUS_RMEM_MAX" >/dev/null
  sysctl -w "net.core.wmem_max=$PREVIOUS_WMEM_MAX" >/dev/null
fi
sysctl net.core.rmem_max net.core.wmem_max
