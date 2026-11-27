---
name: better-zentao-release
description: Safely inspect, bootstrap, build, deploy, verify, diagnose logs, back up, or roll back better-zentao Server 1.0 releases on an intranet Linux host. Use for better-zentao 发布、内网部署、首次部署、版本更新、运行检查、日志诊断、备份与回滚。Default to read-only inspection; never bootstrap, switch, or roll back without explicit user confirmation in the current conversation.
---

# Better-Zentao Release

Operate the maintainer release workflow for `better-zentao` Server 1.0 (multi-user intranet workbench). Source authority is GitHub `main` (merged commits only). The service runs as an isolated single-process Node 24 systemd service (`better-zentao.service`) behind an intranet HTTPS Nginx reverse proxy, with immutable release directories switched via an atomic `current` symlink.

**Public repository hygiene**: This Skill contains **only** generic workflows, scripts, and sanitized templates. Real intranet hosts, pinned SSH host keys, credentials, runtime `server.json`, and real `team.*.json` live **only** outside the Git repository in local protected config and on the target host. Never commit, print, or echo credentials or real intranet topology into the public repo, Issues, or PRs.

## Shared Linux/SSH base

`linux-server-ops` is the shared generic base for SSH/SCP/plink/pscp transport, host-key pinning, local credential injection (`invoke-with-local-credentials.ps1`), and error classification. `scripts/Invoke-BztRemote.ps1` is a thin transport shim invoked as a child of `linux-server-ops`'s credential wrapper; credentials never touch Python or command arguments.

Read [references/release-contract.md](references/release-contract.md) before any bootstrap, switch, or rollback. Read [references/topology.example.md](references/topology.example.md) to prepare the local target config (`%USERPROFILE%\.config\better-zentao-release\target.json`).

## Non-negotiable gates

- **Default to read-only inspection.** `probe` and `logs` are read-only and need no confirmation.
- **Explicit confirmation tokens** in the current conversation are required immediately before mutating actions:
  - First-time host setup: `--confirm BOOTSTRAP_BZT`
  - Production release switch: `--confirm DEPLOY_BZT`
  - Rollback: `--confirm ROLLBACK_BZT`
- **Merged `origin/main` only.** `build` verifies `git merge-base --is-ancestor <sha> origin/main` and builds in a clean detached worktree. Never package an uncommitted or unmerged local branch.
- **Pin the SSH host key.** `Invoke-BztRemote.ps1` requires `hostKeyMd5` from the local target config and fails closed on mismatch.
- **Default read-only mode.** Deployed `server.json` MUST keep `"readOnly": true` and `"notify": { "enabled": false }` unless the project owner explicitly authorizes enabling writes after read-only acceptance.
- **Zero interference with other services.** Only manage `/opt/better-zentao`, `better-zentao.service`, and `/etc/nginx/sites-available/better-zentao`. Always run `nginx -t` before `systemctl reload nginx`. Never touch other apps, ports, certs, or global Node installations.
- **No real Zentao writes.** Deployment verification uses health, bootstrap/status endpoints, and isolated read-only checks only.
- **Never delete old releases or backups automatically.** Keep previous immutable release directories and `<release>-before` backups intact for instant rollback.

## Local target configuration (outside Git)

Store real host parameters in `%USERPROFILE%\.config\better-zentao-release\target.json` (or pass `--target <path>` / set `BZT_RELEASE_TARGET`). Copy from [config/target.example.json](config/target.example.json).

## Workflow

Run from the `better-zentao` repository root (or pass `--repo <path>`):

1. **Inspect (read-only)**
   ```bash
   python ops/skills/better-zentao-release/scripts/bzt_release.py probe
   ```
   Reports host resources, Node 24 runtime, systemd service state, active release & `deployment.json`, non-secret `server.json` summary, `data/` SQLite count, Nginx status, and loopback/HTTPS `/healthz`.

2. **Diagnose logs (read-only)**
   ```bash
   python ops/skills/better-zentao-release/scripts/bzt_release.py logs --lines 100
   ```
   Reads recent `journalctl -u better-zentao.service` entries and Nginx error log tail.

3. **First-time host bootstrap (only once per host, requires confirmation)**
   ```bash
   python ops/skills/better-zentao-release/scripts/bzt_release.py bootstrap \
     --server-config <local-server.json> \
     --team-config <local-team.json> \
     --confirm BOOTSTRAP_BZT
   ```
   Creates system user `better-zentao`, `/opt/better-zentao/*` layout, isolated Node 24 runtime, dedicated self-signed TLS cert, uploads configs (`0640`), installs `better-zentao.service` and Nginx site (`nginx -t` + reload).

4. **Prepare release (build + upload + remote zero-write check; stops at `READY`)**
   ```bash
   python ops/skills/better-zentao-release/scripts/bzt_release.py release --commit origin/main
   ```
   Verifies commit ancestry on `origin/main`, builds `dist/` and production `node_modules` in a clean worktree, writes `release.json` (per-file SHA-256), uploads archive + `deploy.sh`, and runs `deploy.sh --check`. Reports `ALREADY_DEPLOYED` or `READY` without switching.

5. **Backup (standalone, optional before manual maintenance)**
   ```bash
   python ops/skills/better-zentao-release/scripts/bzt_release.py backup --tag manual-20261127
   ```
   Note: `release --confirm DEPLOY_BZT` also automatically runs a pre-switch backup (`<release>-before`).

6. **Switch release (requires explicit confirmation)**
   ```bash
   python ops/skills/better-zentao-release/scripts/bzt_release.py release \
     --confirm DEPLOY_BZT --skip-build \
     --archive <archive-path> --release-id <id> --sha256 <hex> --source-sha <40hex>
   ```
   Backs up current state + `data/`, extracts immutable release directory, switches `/opt/better-zentao/current` atomically, restarts `better-zentao.service`, verifies loopback `/healthz` (auto-rolls back on failure), then verifies external HTTPS `/healthz` and `/api/bootstrap` readback and writes `artifacts/bzt-release/<id>/deploy.json`.

7. **Rollback (requires explicit confirmation)**
   ```bash
   python ops/skills/better-zentao-release/scripts/bzt_release.py rollback \
     --backup-dir /opt/better-zentao/backups/<release>-before \
     [--restore-data] \
     --confirm ROLLBACK_BZT
   ```
   Restores the captured `current` symlink (and `data/` when `--restore-data` is set), restarts `better-zentao.service`, and verifies loopback + HTTPS `/healthz`.

## Script contracts

- `scripts/bzt_release.py` — main Python CLI: `probe`, `verify`, `logs`, `build`, `bootstrap`, `backup`, `release`, `rollback`.
- `scripts/Invoke-BztRemote.ps1` — thin PowerShell transport shim (child of `linux-server-ops` credential wrapper); executes LF-normalized bash via `plink` or uploads via `pscp` with pinned MD5 host key.
- `scripts/remote/probe.sh` — read-only host/service/config/health inspection (non-secret allowlist only).
- `scripts/remote/logs.sh` — read-only systemd journal and Nginx error log diagnostics.
- `scripts/remote/bootstrap.sh` — idempotent first-time host initialization.
- `scripts/remote/backup.sh` — captures `current.link`, `deployment.json`, `config/`, `data.tar.gz` (+ `SHA256SUMS`), systemd unit, and Nginx site.
- `scripts/remote/deploy.sh` — `--check` (zero-write integrity verification) or full switch with pre-switch backup and automatic rollback on failure.
- `scripts/remote/rollback.sh` — restores previous release symlink (and optionally `data/`) and verifies health.

## Failure handling

- If `deploy.sh` fails during extract, restart, or loopback health check, it automatically restores the previous `current` symlink and restarts `better-zentao.service`.
- Never blindly retry a failed switch. Run `probe` and `logs` first to inspect actual host state.
- Preserve failed release directories and backups until root cause is confirmed.
