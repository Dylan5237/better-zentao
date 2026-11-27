# Target Topology Template (Sanitized)

Copy `config/target.example.json` to `%USERPROFILE%\.config\better-zentao-release\target.json` (outside the Git repository) and fill in your real intranet values.

## Fields

| Field | Description |
| --- | --- |
| `host` | Intranet Linux host IP or FQDN |
| `sshUser` | SSH user for deployment (typically `root`) |
| `hostKeyMd5` | Pinned PuTTY MD5 host key fingerprint (`xx:xx:...`) |
| `appRoot` | Remote installation root (default `/opt/better-zentao`) |
| `serviceName` | Systemd unit name (default `better-zentao.service`) |
| `nginxSiteName` | Nginx site file name (default `better-zentao`) |
| `backendPort` | Loopback port for `bzt serve` (default `17330`) |
| `httpsPort` | Intranet HTTPS port served by Nginx (default `17443`) |
| `httpsUrl` | External HTTPS origin matching `server.json` `externalOrigin` (no trailing slash) |
| `wrapperPath` | Path to `linux-server-ops` `invoke-with-local-credentials.ps1` |
| `allowedKeys` | Comma-separated allowed keys in `credentials.env` |
| `requiredKey` | Required SSH password key name (e.g. `FUXI_SSH_PASSWORD`) |
| `plinkPath` | Path to `plink.exe` |
| `pscpPath` | Path to `pscp.exe` |

## Runtime Configs on Host

- `<appRoot>/config/server.json`: Based on `config/server.example.json`, with `host: "127.0.0.1"`, `port: <backendPort>`, `externalOrigin: "<httpsUrl>"`, `allowInsecureHttp: false`, `trustedProxies: ["127.0.0.1", "::1", "::ffff:127.0.0.1"]`, `dataDir: "<appRoot>/data"`, `readOnly: true`, `notify: { "enabled": false }`.
- `<appRoot>/config/team.primary.json`: Team product/role/calendar configuration for the primary Zentao instance (never commit real team data to the public repo).
