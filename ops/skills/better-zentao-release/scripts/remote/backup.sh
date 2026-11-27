#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/opt/better-zentao"
SERVICE_NAME="better-zentao.service"
NGINX_SITE="better-zentao"
TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root) APP_ROOT="$2"; shift 2 ;;
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --nginx-site) NGINX_SITE="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$TAG" ]] || TAG="manual-$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${APP_ROOT}/backups/${TAG}"
mkdir -p "$BACKUP_DIR"

if [[ -L "$APP_ROOT/current" ]]; then
  readlink -f "$APP_ROOT/current" >"$BACKUP_DIR/current.link"
else
  echo "NONE" >"$BACKUP_DIR/current.link"
fi

[[ -f "$APP_ROOT/deployment.json" ]] && cp -a "$APP_ROOT/deployment.json" "$BACKUP_DIR/deployment.json"
[[ -d "$APP_ROOT/config" ]] && cp -a "$APP_ROOT/config" "$BACKUP_DIR/config"
[[ -f "/etc/systemd/system/${SERVICE_NAME}" ]] && cp -a "/etc/systemd/system/${SERVICE_NAME}" "$BACKUP_DIR/${SERVICE_NAME}"
[[ -f "/etc/nginx/sites-available/${NGINX_SITE}" ]] && cp -a "/etc/nginx/sites-available/${NGINX_SITE}" "$BACKUP_DIR/nginx-site.conf"

if [[ -d "$APP_ROOT/data" ]]; then
  SNAP_TMP="$(mktemp -d)"
  trap 'rm -rf "$SNAP_TMP"' EXIT
  mkdir -p "$SNAP_TMP/data"
  python3 - "$APP_ROOT/data" "$SNAP_TMP/data" <<'PY'
import os, shutil, sqlite3, sys
src_root, dst_root = sys.argv[1], sys.argv[2]
for dirpath, dirnames, filenames in os.walk(src_root):
    rel_dir = os.path.relpath(dirpath, src_root)
    out_dir = dst_root if rel_dir == "." else os.path.join(dst_root, rel_dir)
    os.makedirs(out_dir, exist_ok=True)
    for fn in filenames:
        if fn == ".server.lock" or fn.endswith("-wal") or fn.endswith("-shm"):
            continue
        src_p = os.path.join(dirpath, fn)
        dst_p = os.path.join(out_dir, fn)
        if fn.endswith(".db") or fn.endswith(".sqlite"):
            src_conn = sqlite3.connect(f"file:{src_p}?mode=ro", uri=True, timeout=10)
            dst_conn = sqlite3.connect(dst_p)
            try:
                src_conn.backup(dst_conn)
            finally:
                dst_conn.close()
                src_conn.close()
        else:
            shutil.copy2(src_p, dst_p)
PY
  tar -czf "$BACKUP_DIR/data.tar.gz" -C "$SNAP_TMP" data
fi

(
  cd "$BACKUP_DIR"
  find . -maxdepth 2 -type f ! -name 'SHA256SUMS' -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
)
chmod -R go-rwx "$BACKUP_DIR"

echo "BACKUP_OK dir=${BACKUP_DIR}"
