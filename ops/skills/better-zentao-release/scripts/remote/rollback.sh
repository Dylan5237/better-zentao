#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/opt/better-zentao"
SERVICE_NAME="better-zentao.service"
BACKEND_PORT="17330"
BACKUP_DIR=""
RESTORE_DATA="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root) APP_ROOT="$2"; shift 2 ;;
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --restore-data) RESTORE_DATA="1"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -d "$BACKUP_DIR" && -f "$BACKUP_DIR/current.link" && -f "$BACKUP_DIR/SHA256SUMS" ]] || {
  echo "ERROR: invalid backup dir (missing current.link or SHA256SUMS): $BACKUP_DIR" >&2
  exit 2
}

echo "[rollback] verifying backup SHA256SUMS..."
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS >/dev/null)

PREV_TARGET="$(cat "$BACKUP_DIR/current.link")"
if [[ "$PREV_TARGET" == "NONE" || ! -d "$PREV_TARGET" ]]; then
  echo "ERROR: backup has no valid previous release target: $PREV_TARGET" >&2
  exit 1
fi

if [[ "$RESTORE_DATA" == "1" ]]; then
  [[ -f "$BACKUP_DIR/data.tar.gz" ]] || { echo "ERROR: data.tar.gz missing in $BACKUP_DIR" >&2; exit 2; }
  STAGE_DATA="${APP_ROOT}/.data-restore-$$"
  trap 'rm -rf "$STAGE_DATA"' EXIT
  mkdir -p "$STAGE_DATA"
  echo "[rollback] extracting data.tar.gz into staging dir first..."
  tar -xzf "$BACKUP_DIR/data.tar.gz" -C "$STAGE_DATA"
  [[ -d "$STAGE_DATA/data" ]] || { echo "ERROR: data.tar.gz does not contain data/ directory" >&2; exit 1; }
  chown -R better-zentao:better-zentao "$STAGE_DATA/data"
  chmod 0700 "$STAGE_DATA/data"

  echo "[rollback] stopping service before swapping data..."
  systemctl stop "$SERVICE_NAME" || true
  SAFETY_DIR="${APP_ROOT}/backups/pre-rollback-data-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$SAFETY_DIR"
  if [[ -d "${APP_ROOT}/data" ]]; then
    mv "${APP_ROOT}/data" "${SAFETY_DIR}/data"
  fi
  mv "$STAGE_DATA/data" "${APP_ROOT}/data"
  echo "[rollback] data restored atomically (previous data preserved at ${SAFETY_DIR}/data)"
fi

ln -sfn "$PREV_TARGET" "$APP_ROOT/current"
if [[ -f "$BACKUP_DIR/deployment.json" ]]; then
  cp -a "$BACKUP_DIR/deployment.json" "$APP_ROOT/deployment.json"
fi

systemctl restart "$SERVICE_NAME"

HEALTH_OK="0"
for _ in $(seq 1 30); do
  BODY="$(curl -sS --max-time 2 "http://127.0.0.1:${BACKEND_PORT}/healthz" 2>/dev/null || true)"
  if [[ "$BODY" == *'"ok":true'* && "$BODY" == *'"mode":"server"'* ]]; then
    HEALTH_OK="1"
    break
  fi
  sleep 0.5
done

if [[ "$HEALTH_OK" != "1" ]]; then
  echo "ERROR: loopback healthz failed after rollback" >&2
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
  exit 1
fi

echo "ROLLBACK_OK target=${PREV_TARGET}"
