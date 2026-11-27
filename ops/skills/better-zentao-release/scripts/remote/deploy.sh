#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/opt/better-zentao"
SERVICE_NAME="better-zentao.service"
NGINX_SITE="better-zentao"
BACKEND_PORT="17330"
ARCHIVE=""
EXPECTED_SHA256=""
RELEASE=""
SOURCE_SHA=""
CHECK_ONLY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root) APP_ROOT="$2"; shift 2 ;;
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --nginx-site) NGINX_SITE="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    --sha256) EXPECTED_SHA256="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --source-sha) SOURCE_SHA="$2"; shift 2 ;;
    --check) CHECK_ONLY="1"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -f "$ARCHIVE" ]] || { echo "ERROR: archive missing: $ARCHIVE" >&2; exit 2; }
[[ -n "$EXPECTED_SHA256" && -n "$RELEASE" && -n "$SOURCE_SHA" ]] || { echo "ERROR: missing required flags" >&2; exit 2; }

ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256,,}" != "${EXPECTED_SHA256,,}" ]]; then
  echo "ERROR: archive sha256 mismatch: got $ACTUAL_SHA256 expected $EXPECTED_SHA256" >&2
  exit 1
fi

verify_tree() {
  local TREE_ROOT="$1"
  python3 - "$TREE_ROOT" "$RELEASE" "$SOURCE_SHA" <<'PY'
import hashlib, json, os, sys
root, expected_release, expected_sha = sys.argv[1], sys.argv[2], sys.argv[3]
manifest_path = os.path.join(root, "release.json")
if not os.path.isfile(manifest_path):
    sys.exit("ERROR: release.json missing")
with open(manifest_path, "r", encoding="utf-8") as f:
    m = json.load(f)
if m.get("release") != expected_release:
    sys.exit(f"ERROR: manifest release mismatch: {m.get('release')} != {expected_release}")
if m.get("sourceSha") != expected_sha:
    sys.exit(f"ERROR: manifest sourceSha mismatch: {m.get('sourceSha')} != {expected_sha}")
files = m.get("files") or {}
if not files:
    sys.exit("ERROR: manifest files empty")
for rel, expected_hash in files.items():
    p = os.path.join(root, rel)
    if not os.path.isfile(p):
        sys.exit(f"ERROR: manifest file missing: {rel}")
    h = hashlib.sha256(open(p, "rb").read()).hexdigest()
    if h != expected_hash:
        sys.exit(f"ERROR: file hash mismatch for {rel}: {h} != {expected_hash}")
print(f"MANIFEST_OK files={len(files)} release={expected_release} sourceSha={expected_sha}")
PY
}

TMP_VERIFY="$(mktemp -d)"
trap 'rm -rf "$TMP_VERIFY"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP_VERIFY"
verify_tree "$TMP_VERIFY"

CURRENT_TARGET="NONE"
[[ -L "$APP_ROOT/current" ]] && CURRENT_TARGET="$(readlink -f "$APP_ROOT/current")"
RELEASE_DIR="${APP_ROOT}/releases/${RELEASE}"

if [[ "$CHECK_ONLY" == "1" ]]; then
  if [[ "$CURRENT_TARGET" == "$RELEASE_DIR" && -f "$APP_ROOT/deployment.json" ]]; then
    verify_tree "$RELEASE_DIR" >/dev/null
    echo "CHECK_ALREADY_DEPLOYED release=${RELEASE}"
    exit 0
  fi
  echo "CHECK_READY release=${RELEASE} current=${CURRENT_TARGET}"
  exit 0
fi

# Full switch: pre-switch backup
BACKUP_SCRIPT="${APP_ROOT}/incoming/backup.sh"
if [[ -f "$BACKUP_SCRIPT" ]]; then
  bash "$BACKUP_SCRIPT" --app-root "$APP_ROOT" --service "$SERVICE_NAME" --nginx-site "$NGINX_SITE" --tag "${RELEASE}-before"
else
  echo "ERROR: backup.sh missing in ${APP_ROOT}/incoming/" >&2
  exit 1
fi

if [[ -d "$RELEASE_DIR" ]]; then
  echo "[deploy] verifying existing immutable release dir: $RELEASE_DIR"
  verify_tree "$RELEASE_DIR"
else
  STAGE_DIR="${APP_ROOT}/releases/.staging-${RELEASE}-$$"
  mkdir -p "$STAGE_DIR"
  tar -xzf "$ARCHIVE" -C "$STAGE_DIR"
  verify_tree "$STAGE_DIR" >/dev/null
  chown -R root:better-zentao "$STAGE_DIR"
  chmod -R a+rX "$STAGE_DIR"
  mv "$STAGE_DIR" "$RELEASE_DIR"
fi

PREV_TARGET="$CURRENT_TARGET"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current"

rollback_on_failure() {
  echo "[deploy] ERROR: switch failed, attempting automatic rollback..." >&2
  if [[ "$PREV_TARGET" != "NONE" && -d "$PREV_TARGET" ]]; then
    ln -sfn "$PREV_TARGET" "$APP_ROOT/current"
    if ! systemctl restart "$SERVICE_NAME"; then
      echo "[deploy] CRITICAL: auto-rollback restart failed for $PREV_TARGET" >&2
      exit 1
    fi
    local RB_OK="0"
    for _ in $(seq 1 20); do
      local RB_BODY
      RB_BODY="$(curl -sS --max-time 2 "http://127.0.0.1:${BACKEND_PORT}/healthz" 2>/dev/null || true)"
      if [[ "$RB_BODY" == *'"ok":true'* && "$RB_BODY" == *'"mode":"server"'* ]]; then
        RB_OK="1"
        break
      fi
      sleep 0.5
    done
    if [[ "$RB_OK" == "1" ]]; then
      echo "[deploy] auto-rollback restored and verified current -> $PREV_TARGET" >&2
    else
      echo "[deploy] CRITICAL: auto-rollback healthz failed for $PREV_TARGET" >&2
    fi
  else
    systemctl stop "$SERVICE_NAME" || true
    rm -f "$APP_ROOT/current"
    echo "[deploy] auto-rollback stopped service (no previous release)" >&2
  fi
  exit 1
}

if ! systemctl restart "$SERVICE_NAME"; then
  rollback_on_failure
fi

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
  echo "[deploy] loopback healthz failed; recent journal:" >&2
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
  rollback_on_failure
fi

EFFECTIVE_TARGET="$(readlink -f "$APP_ROOT/current")"
if [[ "$EFFECTIVE_TARGET" != "$RELEASE_DIR" ]]; then
  echo "ERROR: current symlink mismatch: $EFFECTIVE_TARGET != $RELEASE_DIR" >&2
  rollback_on_failure
fi

TMP_STATE="${APP_ROOT}/deployment.json.tmp.$$"
python3 - "$RELEASE" "$SOURCE_SHA" "$ACTUAL_SHA256" "${APP_ROOT}/backups/${RELEASE}-before" "$TMP_STATE" <<'PY'
import datetime, json, sys
release, source_sha, archive_sha, backup_dir, out = sys.argv[1:6]
data = {
    "release": release,
    "sourceSha": source_sha,
    "archiveSha256": archive_sha,
    "backupDir": backup_dir,
    "status": "active",
    "deployedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
mv "$TMP_STATE" "$APP_ROOT/deployment.json"
chmod 0644 "$APP_ROOT/deployment.json"

echo "DEPLOY_OK release=${RELEASE} backupDir=${APP_ROOT}/backups/${RELEASE}-before"
