# Better-Zentao Release Contract

## 1. Source Authority & Build Integrity

- Releases MUST be built from a commit merged into `origin/main` (`git merge-base --is-ancestor <sha> origin/main`).
- Builds run in an isolated detached git worktree under `.worktrees/bzt-release-<sha8>` so uncommitted local edits never enter a release.
- Archive naming: `bzt-release-<YYYYMMDD>-<sha8>.tar.gz`.
- Archive contents:
  - `package.json`
  - `dist/**` (compiled TypeScript output)
  - `web/**` (static web portal assets)
  - `skills/**` (agent skill metadata)
  - `templates/**` (report/template files)
  - `node_modules/**` (production dependencies only; pure JS, zero devDependencies, zero `.env` or `.git`)
  - `release.json` (manifest containing `release`, `sourceSha`, `builtAt`, `nodeVersion`, and `files`: map of relative POSIX path → SHA-256 hex for all non-`node_modules` app files plus `package.json`).

## 2. Host Layout (Immutable Releases)

```text
<appRoot>/                       # default: /opt/better-zentao
  runtime/node/                  # isolated Node 24 LTS (>=24.11.0 <25)
  releases/<YYYYMMDD>-<sha8>/    # immutable release directories (never overwritten)
  current -> releases/<id>       # atomic symlink switched on deploy / rollback
  config/
    server.json                  # 0640 root:better-zentao (readOnly: true by default)
    team.primary.json            # 0640 root:better-zentao
  data/                          # 0700 better-zentao:better-zentao (SQLite state.db + .server.lock)
  certs/                         # 0700 root:root (dedicated TLS cert & key)
  incoming/                      # uploaded archives & remote scripts
  backups/<tag>/                 # pre-switch & manual backups
  deployment.json                # atomic JSON state record of active release
```

## 3. Security & Isolation Invariants

1. **Single-process + local disk**: `bzt serve` binds `127.0.0.1:<backendPort>` only; external traffic enters exclusively via HTTPS Nginx reverse proxy.
2. **Host & forwarded headers**: Nginx overwrites `Host` to match `externalOrigin`'s host:port, `X-Forwarded-Proto https`, and `X-Forwarded-For $remote_addr`.
3. **Default read-only**: `server.json` defaults to `"readOnly": true` and `"notify": { "enabled": false }`.
4. **Least privilege**: `better-zentao.service` runs as unprivileged system user `better-zentao` with `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ReadWritePaths=<appRoot>/data`.
5. **No secrets in repo or logs**: `probe.sh` prints only an explicit non-secret allowlist of `server.json` keys. `credentials.env` is accessed solely via `linux-server-ops`'s `invoke-with-local-credentials.ps1`.

## 4. Backup & Rollback Contract

- Every switch creates `<appRoot>/backups/<release>-before/` containing:
  - `current.link` (previous release target, or `NONE` on first install)
  - `deployment.json` (if present)
  - `config/` copy (`server.json`, `team.*.json`)
  - `data.tar.gz` (consistent snapshot of `<appRoot>/data`) + `SHA256SUMS`
  - `better-zentao.service` + `nginx-site.conf`
- Automatic rollback triggers if `systemctl restart better-zentao.service` or loopback `/healthz` fails after switching `current`.
- Manual rollback (`rollback --backup-dir <dir> --confirm ROLLBACK_BZT`) restores `current` symlink and restarts the service. Pass `--restore-data` only when reverting a release that migrated SQLite schemas (stops service before extracting `data.tar.gz` so WAL files stay consistent).

## 5. Verification Assertions

A deployment is `DEPLOYED_AND_VERIFIED` only when all of the following pass:
1. Archive SHA-256 and manifest file hashes match on the remote host.
2. `better-zentao.service` is `active` and `current` symlink resolves to `/opt/better-zentao/releases/<release>`.
3. Loopback `GET http://127.0.0.1:<backendPort>/healthz` returns HTTP 200 with `{"ok":true,"mode":"server"}`.
4. External HTTPS `GET <httpsUrl>/healthz` returns HTTP 200 with `{"ok":true,"mode":"server"}`.
5. External HTTPS `GET <httpsUrl>/` returns HTTP 200 HTML workbench shell.
6. External HTTPS `GET <httpsUrl>/api/startup` confirms `mode: "server"` and `readOnly: true` (when read-only mode is configured), and unauthenticated `GET <httpsUrl>/api/session` returns HTTP 401.
