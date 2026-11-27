#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/opt/better-zentao"
SERVICE_NAME="better-zentao.service"
NGINX_SITE="better-zentao"
HOST_IP=""
BACKEND_PORT="17330"
HTTPS_PORT="17443"
NODE_SOURCE_DIR="/opt/dsh-node"
SERVER_CONFIG_SRC=""
TEAM_CONFIG_SRC=""
ALLOW_WRITE_MODE="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root) APP_ROOT="$2"; shift 2 ;;
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --nginx-site) NGINX_SITE="$2"; shift 2 ;;
    --host-ip) HOST_IP="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --https-port) HTTPS_PORT="$2"; shift 2 ;;
    --node-source-dir) NODE_SOURCE_DIR="$2"; shift 2 ;;
    --server-config-src) SERVER_CONFIG_SRC="$2"; shift 2 ;;
    --team-config-src) TEAM_CONFIG_SRC="$2"; shift 2 ;;
    --allow-write-mode) ALLOW_WRITE_MODE="1"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$HOST_IP" ]] || { echo "ERROR: --host-ip is required" >&2; exit 2; }
[[ -f "$SERVER_CONFIG_SRC" ]] || { echo "ERROR: server config not found: $SERVER_CONFIG_SRC" >&2; exit 2; }
[[ -f "$TEAM_CONFIG_SRC" ]] || { echo "ERROR: team config not found: $TEAM_CONFIG_SRC" >&2; exit 2; }

if [[ "$ALLOW_WRITE_MODE" != "1" ]]; then
  python3 - "$SERVER_CONFIG_SRC" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], "r", encoding="utf-8"))
if d.get("readOnly") is not True:
    sys.exit("ERROR: server.json must have readOnly=true by default (pass --allow-write-mode if explicitly authorized)")
if (d.get("notify") or {}).get("enabled") is True:
    sys.exit("ERROR: server.json must have notify.enabled=false by default")
PY
fi

echo "[bootstrap] ensuring system user better-zentao..."
if ! id -u better-zentao >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin better-zentao
fi

echo "[bootstrap] creating directory layout under $APP_ROOT..."
mkdir -p "$APP_ROOT"/{releases,config,data,certs,incoming,backups,runtime}
chown root:better-zentao "$APP_ROOT" "$APP_ROOT/config" "$APP_ROOT/releases" "$APP_ROOT/runtime"
chmod 0755 "$APP_ROOT" "$APP_ROOT/releases" "$APP_ROOT/runtime"
chmod 0750 "$APP_ROOT/config"
chown better-zentao:better-zentao "$APP_ROOT/data"
chmod 0700 "$APP_ROOT/data"
chown root:root "$APP_ROOT/certs" "$APP_ROOT/incoming" "$APP_ROOT/backups"
chmod 0700 "$APP_ROOT/certs" "$APP_ROOT/incoming" "$APP_ROOT/backups"

echo "[bootstrap] preparing isolated Node 24 runtime..."
if [[ ! -x "$APP_ROOT/runtime/node/bin/node" ]]; then
  if [[ -x "$NODE_SOURCE_DIR/bin/node" ]]; then
    SRC_VER="$("$NODE_SOURCE_DIR/bin/node" -v)"
    if [[ "$SRC_VER" =~ ^v24\. ]]; then
      cp -a "$NODE_SOURCE_DIR" "$APP_ROOT/runtime/node"
    else
      echo "ERROR: $NODE_SOURCE_DIR node version $SRC_VER is not v24.x" >&2
      exit 1
    fi
  else
    echo "ERROR: Node 24 runtime not found at $APP_ROOT/runtime/node or $NODE_SOURCE_DIR" >&2
    exit 1
  fi
fi
NODE_BIN="$APP_ROOT/runtime/node/bin/node"
echo "[bootstrap] runtime node: $("$NODE_BIN" -v)"
"$NODE_BIN" -e "import('node:sqlite').then(() => console.log('[bootstrap] node:sqlite OK'))"

echo "[bootstrap] installing runtime configs (0640 root:better-zentao)..."
install -o root -g better-zentao -m 0640 "$SERVER_CONFIG_SRC" "$APP_ROOT/config/server.json"
install -o root -g better-zentao -m 0640 "$TEAM_CONFIG_SRC" "$APP_ROOT/config/team.primary.json"
rm -f "$SERVER_CONFIG_SRC" "$TEAM_CONFIG_SRC"

echo "[bootstrap] ensuring dedicated TLS certificate..."
if [[ ! -f "$APP_ROOT/certs/server.crt" || ! -f "$APP_ROOT/certs/server.key" ]]; then
  if [[ "$HOST_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    SAN="IP:${HOST_IP}"
  else
    SAN="DNS:${HOST_IP}"
  fi
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$APP_ROOT/certs/server.key" \
    -out "$APP_ROOT/certs/server.crt" \
    -subj "/O=Better-Zentao Intranet/CN=${HOST_IP}" \
    -addext "subjectAltName=${SAN}" 2>/dev/null
  chmod 0600 "$APP_ROOT/certs/server.key"
  chmod 0644 "$APP_ROOT/certs/server.crt"
fi
openssl x509 -in "$APP_ROOT/certs/server.crt" -noout -subject -dates

echo "[bootstrap] installing systemd unit /etc/systemd/system/$SERVICE_NAME..."
cat >"/etc/systemd/system/${SERVICE_NAME}" <<EOF
[Unit]
Description=better-zentao Server 1.0 (Intranet Multi-User Workbench)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=better-zentao
Group=better-zentao
WorkingDirectory=${APP_ROOT}/current
Environment=NODE_ENV=production
ExecStart=${APP_ROOT}/runtime/node/bin/node ${APP_ROOT}/current/dist/adapters/cli/bzt.js serve --server-config ${APP_ROOT}/config/server.json
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${APP_ROOT}/data
StandardOutput=journal
StandardError=journal
SyslogIdentifier=better-zentao

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "/etc/systemd/system/${SERVICE_NAME}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo "[bootstrap] installing nginx site /etc/nginx/sites-available/$NGINX_SITE..."
SITE_AVAIL="/etc/nginx/sites-available/${NGINX_SITE}"
SITE_EN="/etc/nginx/sites-enabled/${NGINX_SITE}"
SITE_BAK=""
if [[ -f "$SITE_AVAIL" ]]; then
  SITE_BAK="${APP_ROOT}/backups/nginx-${NGINX_SITE}-$(date +%Y%m%d%H%M%S).bak"
  cp -a "$SITE_AVAIL" "$SITE_BAK"
fi

cat >"$SITE_AVAIL" <<EOF
# Managed by better-zentao-release Skill
server {
    listen ${HOST_IP}:${HTTPS_PORT} ssl http2;
    server_name _;

    ssl_certificate     ${APP_ROOT}/certs/server.crt;
    ssl_certificate_key ${APP_ROOT}/certs/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    server_tokens off;
    client_max_body_size 256k;

    access_log /var/log/nginx/${NGINX_SITE}.access.log;
    error_log  /var/log/nginx/${NGINX_SITE}.error.log;

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;

        proxy_set_header Host ${HOST_IP}:${HTTPS_PORT};
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$remote_addr;

        proxy_read_timeout 35s;
        proxy_connect_timeout 10s;
    }
}
EOF
ln -sfn "$SITE_AVAIL" "$SITE_EN"

if ! nginx -t; then
  echo "ERROR: nginx -t failed; reverting site..." >&2
  if [[ -n "$SITE_BAK" && -f "$SITE_BAK" ]]; then
    cp -a "$SITE_BAK" "$SITE_AVAIL"
  else
    rm -f "$SITE_EN" "$SITE_AVAIL"
  fi
  exit 1
fi

systemctl reload nginx
echo "BOOTSTRAP_OK"
