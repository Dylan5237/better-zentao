#!/usr/bin/env bash
set -u

SERVICE_NAME="better-zentao.service"
NGINX_SITE="better-zentao"
LINES="100"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --nginx-site) NGINX_SITE="$2"; shift 2 ;;
    --lines) LINES="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "=== SYSTEMD JOURNAL ($SERVICE_NAME, last $LINES lines) ==="
journalctl -u "$SERVICE_NAME" -n "$LINES" --no-pager 2>&1 || true

echo ""
echo "=== NGINX ERROR LOG (/var/log/nginx/${NGINX_SITE}.error.log, last 50 lines) ==="
if [[ -f "/var/log/nginx/${NGINX_SITE}.error.log" ]]; then
  tail -n 50 "/var/log/nginx/${NGINX_SITE}.error.log"
else
  echo "(no nginx error log yet)"
fi
