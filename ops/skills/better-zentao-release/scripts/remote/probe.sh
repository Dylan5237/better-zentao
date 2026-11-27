#!/usr/bin/env bash
set -u

APP_ROOT="/opt/better-zentao"
SERVICE_NAME="better-zentao.service"
NGINX_SITE="better-zentao"
BACKEND_PORT="17330"
HTTPS_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root) APP_ROOT="$2"; shift 2 ;;
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --nginx-site) NGINX_SITE="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --https-url) HTTPS_URL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "=== HOST ==="
hostname
uname -srm
grep -E '^(NAME|VERSION)=' /etc/os-release 2>/dev/null || true
free -h | head -n 2
df -h "$APP_ROOT" 2>/dev/null || df -h /

echo "=== RUNTIME ==="
if [[ -x "$APP_ROOT/runtime/node/bin/node" ]]; then
  echo "node_bin=$APP_ROOT/runtime/node/bin/node"
  echo "node_version=$("$APP_ROOT/runtime/node/bin/node" -v 2>&1 || true)"
else
  echo "node_bin=MISSING"
fi

echo "=== RELEASE ==="
if [[ -L "$APP_ROOT/current" ]]; then
  echo "current_target=$(readlink -f "$APP_ROOT/current")"
else
  echo "current_target=NONE"
fi
if [[ -f "$APP_ROOT/deployment.json" ]]; then
  cat "$APP_ROOT/deployment.json"
  echo ""
else
  echo "deployment_json=NONE"
fi
echo "releases_count=$(find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
echo "backups_count=$(find "$APP_ROOT/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"

echo "=== SERVICE ==="
systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || echo "not-enabled"
systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "inactive"
systemctl show "$SERVICE_NAME" -p MainPID,ActiveState,SubState,WorkingDirectory,ExecMainStartTimestamp 2>/dev/null || true

echo "=== CONFIG (NON-SECRET ALLOWLIST) ==="
if [[ -f "$APP_ROOT/config/server.json" ]]; then
  python3 - "$APP_ROOT/config/server.json" <<'PY'
import json, sys
p = sys.argv[1]
with open(p, "r", encoding="utf-8") as f:
    d = json.load(f)
summary = {
    "version": d.get("version"),
    "host": d.get("host"),
    "port": d.get("port"),
    "externalOrigin": d.get("externalOrigin"),
    "allowInsecureHttp": d.get("allowInsecureHttp"),
    "trustedProxies": d.get("trustedProxies"),
    "dataDir": d.get("dataDir"),
    "readOnly": d.get("readOnly"),
    "notifyEnabled": (d.get("notify") or {}).get("enabled"),
    "instances": {k: {"enabled": v.get("enabled", True)} for k, v in (d.get("instances") or {}).items()},
}
print(json.dumps(summary, ensure_ascii=False))
PY
else
  echo "server_json=MISSING"
fi

echo "=== DATA ==="
if [[ -d "$APP_ROOT/data" ]]; then
  du -sh "$APP_ROOT/data" 2>/dev/null || true
  echo "state_db_count=$(find "$APP_ROOT/data" -name 'state.db' 2>/dev/null | wc -l)"
  echo "lock_present=$([[ -f "$APP_ROOT/data/.server.lock" ]] && echo yes || echo no)"
else
  echo "data_dir=MISSING"
fi

echo "=== NGINX ==="
systemctl is-active nginx 2>/dev/null || echo "nginx-inactive"
echo "site_enabled=$([[ -L "/etc/nginx/sites-enabled/$NGINX_SITE" ]] && echo yes || echo no)"
nginx -t 2>&1 || true

echo "=== HEALTH ==="
echo -n "loopback_healthz="
curl -sS --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/healthz" 2>&1 || echo "UNREACHABLE"
echo ""
if [[ -n "$HTTPS_URL" ]]; then
  echo -n "https_healthz="
  curl -skS --max-time 5 "${HTTPS_URL}/healthz" 2>&1 || echo "UNREACHABLE"
  echo ""
fi
