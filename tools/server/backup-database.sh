#!/usr/bin/env bash
set -euo pipefail

umask 077

state_root=${SIMPLEWATCH_STATE_ROOT:-/srv/simplewatch/state}
database_path=${SIMPLEWATCH_DATABASE_PATH:-$state_root/simplewatch.sqlite3}
backup_root=${SIMPLEWATCH_BACKUP_ROOT:-$state_root/backups/daily}
retention_days=${SIMPLEWATCH_BACKUP_RETENTION_DAYS:-14}

if [[ ! -f "$database_path" || -L "$database_path" ]]; then
  printf '数据库不存在或不是常规文件：%s\n' "$database_path" >&2
  exit 1
fi
if ! [[ "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  printf '备份保留天数无效：%s\n' "$retention_days" >&2
  exit 1
fi

install -d -m 0700 -o root -g root "$backup_root"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
final_path="$backup_root/simplewatch-$timestamp.sqlite3"
temporary_path="$backup_root/.simplewatch-$timestamp.sqlite3.tmp"
checksum_path="$final_path.sha256"

cleanup() {
  rm -f -- "$temporary_path" "$temporary_path-wal" "$temporary_path-shm"
}
trap cleanup EXIT

sqlite3 -batch -bail -readonly "$database_path" ".timeout 30000" ".backup '$temporary_path'"
sqlite3 -batch -bail "$temporary_path" \
  ".timeout 30000" \
  'PRAGMA wal_checkpoint(TRUNCATE);' \
  'PRAGMA journal_mode=DELETE;' >/dev/null

integrity=$(sqlite3 -batch -bail -readonly "$temporary_path" 'PRAGMA integrity_check;')
if [[ "$integrity" != ok ]]; then
  printf 'SQLite integrity_check 失败：%s\n' "$integrity" >&2
  exit 1
fi

foreign_key_violations=$(sqlite3 -batch -bail -readonly "$temporary_path" 'PRAGMA foreign_key_check;' | wc -l)
if [[ "$foreign_key_violations" -ne 0 ]]; then
  printf 'SQLite foreign_key_check 发现 %s 条违规\n' "$foreign_key_violations" >&2
  exit 1
fi

chmod 0600 "$temporary_path"
mv -- "$temporary_path" "$final_path"
(
  cd "$backup_root"
  sha256sum "${final_path##*/}" >"${checksum_path##*/}"
)
chmod 0600 "$checksum_path"

find "$backup_root" -maxdepth 1 -type f \
  \( -name 'simplewatch-*.sqlite3' -o -name 'simplewatch-*.sqlite3.sha256' \) \
  -mtime "+$retention_days" -delete

printf 'backup=%s integrity=ok foreign_key_violations=0\n' "$final_path"
