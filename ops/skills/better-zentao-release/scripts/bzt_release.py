#!/usr/bin/env python3
"""better-zentao Server 1.0 release orchestrator.

All orchestration logic lives in Python; remote operations go through
linux-server-ops's invoke-with-local-credentials.ps1 + Invoke-BztRemote.ps1.
Real target host, hostKeyMd5, and paths are loaded from local target.json
outside the Git repository.

Subcommands:
  probe       read-only inspection of host, service, nginx, config, and health
  verify      read-only external HTTPS health, startup, and auth-guard verification
  logs        read-only systemd journal and nginx error log diagnostics
  build       build + package an immutable archive from a merged origin/main commit
  bootstrap   first-time host setup (user, dirs, Node 24, TLS, systemd, nginx, configs)
  backup      standalone backup of data (SQLite-consistent), config, and active release
  release     build/upload/check (stops at READY); with --confirm DEPLOY_BZT, switch + readback
  rollback    restore a previous release from a backup directory (requires --confirm ROLLBACK_BZT)
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shlex
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
SHIM = SKILL_ROOT / "scripts" / "Invoke-BztRemote.ps1"
REMOTE = SKILL_ROOT / "scripts" / "remote"
POWERSHELL = "powershell"
DEFAULT_TARGET_FILE = Path.home() / ".config" / "better-zentao-release" / "target.json"

RELEASE_RE = re.compile(r"^[0-9]{8}-[a-f0-9]{7,40}$")
SHA40_RE = re.compile(r"^[a-f0-9]{40}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
TAG_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
SAFE_POSIX_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]+$")
SAFE_UNIT_RE = re.compile(r"^[A-Za-z0-9._@-]{1,128}$")
SAFE_HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$")


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def _validate_posix_path(value: str, name: str) -> str:
    if not SAFE_POSIX_PATH_RE.match(value) or ".." in value.split("/"):
        die(f"invalid {name}: {value}")
    return value.rstrip("/") or "/"


def _validate_port(value, name: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        die(f"invalid {name}: {value}")
    if port < 1 or port > 65535:
        die(f"port out of range for {name}: {port}")
    return port


def load_target(target_path: str | None) -> dict:
    p = Path(target_path or os.environ.get("BZT_RELEASE_TARGET") or DEFAULT_TARGET_FILE)
    if not p.is_file():
        die(f"target config not found: {p} (copy config/target.example.json there first)")
    data = json.loads(p.read_text(encoding="utf-8"))
    for k in ("host", "hostKeyMd5", "httpsUrl", "wrapperPath"):
        if not data.get(k):
            die(f"target config missing required key: {k}")
    if not SAFE_HOST_RE.match(str(data["host"])):
        die(f"invalid target host: {data['host']}")
    data["sshUser"] = str(data.get("sshUser") or "root")
    if not SAFE_UNIT_RE.match(data["sshUser"]):
        die(f"invalid sshUser: {data['sshUser']}")
    data["appRoot"] = _validate_posix_path(str(data.get("appRoot") or "/opt/better-zentao"), "appRoot")
    data["serviceName"] = str(data.get("serviceName") or "better-zentao.service")
    if not SAFE_UNIT_RE.match(data["serviceName"]):
        die(f"invalid serviceName: {data['serviceName']}")
    data["nginxSiteName"] = str(data.get("nginxSiteName") or "better-zentao")
    if not SAFE_UNIT_RE.match(data["nginxSiteName"]):
        die(f"invalid nginxSiteName: {data['nginxSiteName']}")
    data["backendPort"] = _validate_port(data.get("backendPort", 17330), "backendPort")
    data["httpsPort"] = _validate_port(data.get("httpsPort", 17443), "httpsPort")
    data.setdefault("allowedKeys", "FUXI_SSH_PASSWORD,FUXI_USERNAME,FUXI_PASSWORD")
    data.setdefault("requiredKey", "FUXI_SSH_PASSWORD")
    data.setdefault("plinkPath", r"C:\Program Files (x86)\PuTTY\plink.exe")
    data.setdefault("pscpPath", r"C:\Program Files (x86)\PuTTY\pscp.exe")
    data.setdefault("sshKeyPath", "")
    data["httpsUrl"] = str(data["httpsUrl"]).rstrip("/")
    if not data["httpsUrl"].startswith("https://"):
        die(f"httpsUrl must start with https://: {data['httpsUrl']}")
    return data


def _runner(command: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".sh", prefix="bzt-runner-")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write("#!/usr/bin/env bash\nset -euo pipefail\n" + command + "\n")
    return path


def _quote_cmd(parts: list[str]) -> str:
    return " ".join(shlex.quote(str(x)) for x in parts)


def remote(target: dict, action: str, file_path: str | Path, remote_dir: str | None = None, capture: bool = False):
    incoming = f"{target['appRoot']}/incoming/"
    params = {
        "action": action,
        "host": target["host"],
        "user": target["sshUser"],
        "hostKeyMd5": target["hostKeyMd5"],
        "plinkPath": target["plinkPath"],
        "pscpPath": target["pscpPath"],
        "sshKeyPath": target.get("sshKeyPath", ""),
        "requiredKey": target["requiredKey"],
        "file": str(file_path),
        "remoteDir": remote_dir or incoming,
    }
    fd, pj = tempfile.mkstemp(suffix=".json", prefix="bzt-params-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(params, f)
    cmd = [
        POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(target["wrapperPath"]),
        "-ScriptPath", str(SHIM),
        "-ArgumentList", pj,
        "-AllowedKey", target["allowedKeys"],
        "-RequiredKey", target["requiredKey"],
    ]
    try:
        if capture:
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            return r.returncode, (r.stdout or "") + (r.stderr or "")
        r = subprocess.run(cmd)
        return r.returncode, ""
    finally:
        if os.path.exists(pj):
            os.unlink(pj)


def upload(target: dict, local_path: str | Path, remote_dir: str | None = None) -> None:
    rc, out = remote(target, "upload", local_path, remote_dir=remote_dir, capture=True)
    if rc != 0:
        die(f"upload failed ({local_path}): {out}")


def run_remote_cmd(target: dict, command: str, capture: bool = False):
    runner = _runner(command)
    try:
        return remote(target, "run", runner, capture=capture)
    finally:
        if os.path.exists(runner):
            os.unlink(runner)


def git(repo: Path, *args: str):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def verify_origin_main_ancestor(repo: Path, commit_ref: str) -> str:
    rc, _, err = git(repo, "fetch", "-q", "origin")
    if rc != 0:
        die(f"git fetch failed: {err}")
    rc, sha, _ = git(repo, "rev-parse", f"{commit_ref}^{{commit}}")
    if rc != 0 or not SHA40_RE.match(sha):
        die(f"cannot resolve commit: {commit_ref}")
    rc, _, _ = git(repo, "merge-base", "--is-ancestor", sha, "origin/main")
    if rc != 0:
        die(f"commit is not merged into origin/main: {sha}")
    return sha


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def build_release(repo: Path, commit: str, date_str: str) -> dict:
    sha = verify_origin_main_ancestor(repo, commit)
    sha8 = sha[:8]
    release_id = f"{date_str}-{sha8}"
    worktree = repo / ".worktrees" / f"bzt-release-{sha8}"

    if worktree.exists():
        rc, head, _ = git(worktree, "rev-parse", "HEAD")
        if head != sha:
            die(f"worktree sha mismatch: {worktree} at {head}, expected {sha}")
        rc, status, _ = git(worktree, "status", "--porcelain")
        if status:
            die(f"worktree dirty: {worktree}")
    else:
        rc, _, err = git(repo, "worktree", "add", "--detach", str(worktree), sha)
        if rc != 0:
            die(f"git worktree add failed: {err}")

    main_modules = repo / "node_modules"
    wt_modules = worktree / "node_modules"
    if not main_modules.exists():
        die("main repo node_modules missing; run corepack pnpm install --frozen-lockfile first")
    if not wt_modules.exists():
        r = subprocess.run(
            [POWERSHELL, "-NoProfile", "-Command",
             f"New-Item -ItemType Junction -Path '{wt_modules}' -Target '{main_modules}' | Out-Null"],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            die(f"junction failed: {r.stderr}")

    print(f"[build] compiling {release_id} in {worktree} ...", flush=True)
    r = subprocess.run("corepack pnpm run build", cwd=str(worktree), shell=True)
    if r.returncode != 0:
        die("corepack pnpm run build failed")

    stage_root = Path(tempfile.mkdtemp(prefix=f"bzt-stage-{sha8}-"))
    try:
        deploy_dir = stage_root / "prod"
        r = subprocess.run(
            f'corepack pnpm deploy --prod --legacy "{deploy_dir}"',
            cwd=str(worktree), shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if r.returncode != 0 or not (deploy_dir / "node_modules").exists():
            deploy_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(worktree / "package.json", deploy_dir / "package.json")
            r2 = subprocess.run(
                "npm install --omit=dev --ignore-scripts --no-audit --no-fund",
                cwd=str(deploy_dir), shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            if r2.returncode != 0:
                die(f"prod dependency staging failed:\npnpm: {r.stderr}\nnpm: {r2.stderr}")

        native_bins = list((deploy_dir / "node_modules").rglob("*.node"))
        if native_bins:
            die(f"unexpected native binaries in prod node_modules: {native_bins[:3]}")

        pkg_root = stage_root / "pkg"
        pkg_root.mkdir(parents=True, exist_ok=True)
        shutil.copy2(worktree / "package.json", pkg_root / "package.json")
        for sub in ("dist", "web", "skills", "templates"):
            src = worktree / sub
            if src.exists():
                shutil.copytree(src, pkg_root / sub)
        shutil.copytree(deploy_dir / "node_modules", pkg_root / "node_modules", symlinks=False)

        files_manifest = {"package.json": sha256_file(pkg_root / "package.json")}
        for sub in ("dist", "web", "skills", "templates"):
            sub_dir = pkg_root / sub
            if not sub_dir.exists():
                continue
            for fp in sorted(sub_dir.rglob("*")):
                if fp.is_file():
                    rel = fp.relative_to(pkg_root).as_posix()
                    files_manifest[rel] = sha256_file(fp)

        node_ver = subprocess.run("node -v", shell=True, capture_output=True, text=True).stdout.strip()
        manifest = {
            "release": release_id,
            "sourceSha": sha,
            "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "buildNodeVersion": node_ver,
            "files": files_manifest,
        }
        (pkg_root / "release.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        out_dir = repo / "artifacts" / "bzt-release" / release_id
        out_dir.mkdir(parents=True, exist_ok=True)
        archive_path = out_dir / f"bzt-release-{release_id}.tar.gz"

        with tarfile.open(archive_path, "w:gz") as tar:
            for item in sorted(pkg_root.iterdir()):
                tar.add(item, arcname=item.name)

        archive_sha = sha256_file(archive_path)
        result = {
            "release": release_id,
            "sourceSha": sha,
            "archive": str(archive_path),
            "sha256": archive_sha,
            "manifestFileCount": len(files_manifest),
            "worktree": str(worktree),
            "sourceOnMain": True,
        }
        (out_dir / "build.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return result
    finally:
        shutil.rmtree(stage_root, ignore_errors=True)


def https_readback(target: dict, require_read_only: bool = True) -> dict:
    ctx = ssl._create_unverified_context()
    base = target["httpsUrl"]

    def fetch(path: str):
        req = urllib.request.Request(f"{base}{path}")
        try:
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                return resp.status, resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", errors="replace")

    st_h, body_h = fetch("/healthz")
    if st_h != 200 or '"ok":true' not in body_h or '"mode":"server"' not in body_h:
        die(f"HTTPS /healthz failed: status={st_h} body={body_h[:200]}")

    st_idx, body_idx = fetch("/")
    if st_idx != 200 or "<html" not in body_idx.lower():
        die(f"HTTPS / failed: status={st_idx}")

    st_start, body_start = fetch("/api/startup")
    if st_start != 200:
        die(f"HTTPS /api/startup failed: status={st_start} body={body_start[:200]}")
    startup_data = json.loads(body_start)
    if startup_data.get("mode") != "server":
        die(f"HTTPS /api/startup unexpected mode: {startup_data.get('mode')}")
    if require_read_only and startup_data.get("readOnly") is not True:
        die(f"HTTPS /api/startup expected readOnly=true, got {startup_data.get('readOnly')} (pass --allow-write-mode if intentional)")

    st_sess, _ = fetch("/api/session")
    if st_sess != 401:
        die(f"HTTPS /api/session unauthenticated expected 401, got {st_sess}")

    return {
        "healthzStatus": st_h,
        "healthzBody": json.loads(body_h),
        "indexStatus": st_idx,
        "indexBytes": len(body_idx),
        "startupStatus": st_start,
        "startupMode": startup_data.get("mode"),
        "startupReadOnly": startup_data.get("readOnly"),
        "startupInstances": [i.get("id") for i in (startup_data.get("instances") or []) if isinstance(i, dict)],
        "unauthSessionStatus": st_sess,
    }


def cmd_probe(args):
    target = load_target(args.target)
    probe_text = (REMOTE / "probe.sh").read_text(encoding="utf-8").replace("\r\n", "\n")
    set_args = _quote_cmd([
        "set", "--",
        "--app-root", target["appRoot"],
        "--service", target["serviceName"],
        "--nginx-site", target["nginxSiteName"],
        "--backend-port", str(target["backendPort"]),
        "--https-url", target["httpsUrl"],
    ])
    rc, out = run_remote_cmd(target, set_args + "\n" + probe_text, capture=True)
    print(out)
    sys.exit(rc)


def cmd_verify(args):
    target = load_target(args.target)
    readback = https_readback(target, require_read_only=not args.allow_write_mode)
    print(json.dumps(readback, ensure_ascii=False, indent=2))


def cmd_logs(args):
    target = load_target(args.target)
    lines = max(1, min(int(args.lines), 2000))
    logs_text = (REMOTE / "logs.sh").read_text(encoding="utf-8").replace("\r\n", "\n")
    set_args = _quote_cmd([
        "set", "--",
        "--service", target["serviceName"],
        "--nginx-site", target["nginxSiteName"],
        "--lines", str(lines),
    ])
    rc, out = run_remote_cmd(target, set_args + "\n" + logs_text, capture=True)
    print(out)
    sys.exit(rc)


def cmd_build(args):
    result = build_release(Path(args.repo), args.commit, args.date)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_bootstrap(args):
    if args.confirm != "BOOTSTRAP_BZT":
        die("confirmation required: --confirm BOOTSTRAP_BZT")
    target = load_target(args.target)
    srv_cfg = Path(args.server_config)
    team_cfg = Path(args.team_config)
    if not srv_cfg.is_file():
        die(f"server config not found: {srv_cfg}")
    if not team_cfg.is_file():
        die(f"team config not found: {team_cfg}")

    srv_data = json.loads(srv_cfg.read_text(encoding="utf-8"))
    if not args.allow_write_mode:
        if srv_data.get("readOnly") is not True:
            die("bootstrap requires readOnly=true in server.json by default (pass --allow-write-mode if explicitly authorized)")
        if (srv_data.get("notify") or {}).get("enabled") is True:
            die("bootstrap requires notify.enabled=false in server.json by default (pass --allow-write-mode if explicitly authorized)")

    incoming = f"{target['appRoot']}/incoming/"
    rc, out = run_remote_cmd(target, f"mkdir -p {shlex.quote(incoming)} && chmod 0700 {shlex.quote(incoming)}", capture=True)
    if rc != 0:
        die(f"failed to create incoming dir: {out}")

    upload(target, REMOTE / "bootstrap.sh", incoming)
    upload(target, srv_cfg, incoming + "server.json.upload")
    upload(target, team_cfg, incoming + "team.primary.json.upload")

    cmd_parts = [
        "bash", incoming + "bootstrap.sh",
        "--app-root", target["appRoot"],
        "--service", target["serviceName"],
        "--nginx-site", target["nginxSiteName"],
        "--host-ip", target["host"],
        "--backend-port", str(target["backendPort"]),
        "--https-port", str(target["httpsPort"]),
        "--server-config-src", incoming + "server.json.upload",
        "--team-config-src", incoming + "team.primary.json.upload",
    ]
    if args.allow_write_mode:
        cmd_parts.append("--allow-write-mode")
    rc, out = run_remote_cmd(target, _quote_cmd(cmd_parts), capture=True)
    print(out)
    if rc != 0 or "BOOTSTRAP_OK" not in out:
        die("bootstrap failed")


def cmd_backup(args):
    target = load_target(args.target)
    tag = args.tag or f"manual-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
    if not TAG_RE.match(tag):
        die(f"invalid backup tag: {tag}")
    incoming = f"{target['appRoot']}/incoming/"
    upload(target, REMOTE / "backup.sh", incoming)
    cmd_parts = [
        "bash", incoming + "backup.sh",
        "--app-root", target["appRoot"],
        "--service", target["serviceName"],
        "--nginx-site", target["nginxSiteName"],
        "--tag", tag,
    ]
    rc, out = run_remote_cmd(target, _quote_cmd(cmd_parts), capture=True)
    print(out)
    if rc != 0 or "BACKUP_OK" not in out:
        die("backup failed")


def cmd_release(args):
    target = load_target(args.target)
    repo = Path(args.repo)
    if args.skip_build:
        for name in ("archive", "release_id", "sha256", "source_sha"):
            if not getattr(args, name):
                die(f"--skip-build requires --{name.replace('_', '-')}")
        if not RELEASE_RE.match(args.release_id):
            die(f"invalid release id: {args.release_id}")
        if not SHA40_RE.match(args.source_sha.lower()):
            die(f"invalid source sha: {args.source_sha}")
        if not SHA256_RE.match(args.sha256.lower()):
            die(f"invalid archive sha256: {args.sha256}")
        # Verify sourceSha is genuinely merged into origin/main
        verified_sha = verify_origin_main_ancestor(repo, args.source_sha.lower())
        archive_p = Path(args.archive).resolve()
        if not archive_p.is_file():
            die(f"archive not found: {archive_p}")
        actual = sha256_file(archive_p)
        if actual != args.sha256.lower():
            die("archive sha256 mismatch")
        # Require a matching local build receipt produced by build_release()
        receipt_p = repo / "artifacts" / "bzt-release" / args.release_id / "build.json"
        if not receipt_p.is_file():
            die(f"missing trusted build receipt: {receipt_p} (run build first)")
        receipt = json.loads(receipt_p.read_text(encoding="utf-8"))
        if (
            receipt.get("release") != args.release_id
            or receipt.get("sourceSha") != verified_sha
            or receipt.get("sha256") != actual
            or receipt.get("sourceOnMain") is not True
            or Path(receipt.get("archive", "")).resolve() != archive_p
        ):
            die(f"build receipt mismatch in {receipt_p}; refuse to deploy unverified archive")
        b = {
            "archive": str(archive_p),
            "release": args.release_id,
            "sha256": actual,
            "sourceSha": verified_sha,
        }
    else:
        b = build_release(repo, args.commit, args.date)

    release_id = b["release"]
    if not RELEASE_RE.match(release_id):
        die(f"invalid release id: {release_id}")

    incoming = f"{target['appRoot']}/incoming/"
    upload(target, b["archive"], incoming)
    upload(target, REMOTE / "deploy.sh", incoming)
    upload(target, REMOTE / "backup.sh", incoming)

    remote_archive = incoming + Path(b["archive"]).name
    base_deploy_args = [
        "bash", incoming + "deploy.sh",
        "--app-root", target["appRoot"],
        "--service", target["serviceName"],
        "--nginx-site", target["nginxSiteName"],
        "--backend-port", str(target["backendPort"]),
        "--archive", remote_archive,
        "--sha256", b["sha256"],
        "--release", release_id,
        "--source-sha", b["sourceSha"],
    ]
    rc, out = run_remote_cmd(target, _quote_cmd(base_deploy_args + ["--check"]), capture=True)
    print(out)
    if "CHECK_ALREADY_DEPLOYED" in out:
        print(f"ALREADY_DEPLOYED: {release_id} is current; nothing to do.")
        return
    if rc != 0 or "CHECK_READY" not in out:
        die("remote check failed")

    if args.confirm != "DEPLOY_BZT":
        print(f"\nREADY: {release_id} passed all remote integrity checks. Service NOT switched.")
        print(
            f'To switch: python ops/skills/better-zentao-release/scripts/bzt_release.py release '
            f'--confirm DEPLOY_BZT --skip-build --archive "{b["archive"]}" '
            f'--release-id {release_id} --sha256 {b["sha256"]} --source-sha {b["sourceSha"]}'
        )
        return

    rc, out = run_remote_cmd(target, _quote_cmd(base_deploy_args), capture=True)
    print(out)
    if rc != 0 or "DEPLOY_OK" not in out:
        die("remote switch failed (auto-rollback attempted; run probe to confirm state)")

    readback = https_readback(target, require_read_only=not args.allow_write_mode)
    evidence_dir = repo / "artifacts" / "bzt-release" / release_id
    evidence_dir.mkdir(parents=True, exist_ok=True)
    record = {
        "status": "DEPLOYED_AND_VERIFIED",
        "release": release_id,
        "sourceSha": b["sourceSha"],
        "archiveSha256": b["sha256"],
        "httpsReadback": readback,
        "backupDir": f"{target['appRoot']}/backups/{release_id}-before",
        "deployedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    (evidence_dir / "deploy.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nRELEASE_VERIFIED: {release_id} — loopback & HTTPS healthz OK.")
    print(f"Evidence: {evidence_dir / 'deploy.json'}")


def cmd_rollback(args):
    if args.confirm != "ROLLBACK_BZT":
        die("confirmation required: --confirm ROLLBACK_BZT")
    target = load_target(args.target)
    backup_dir = _validate_posix_path(args.backup_dir, "backup-dir")
    prefix = f"{target['appRoot']}/backups/"
    if not backup_dir.startswith(prefix):
        die(f"--backup-dir must start with {prefix}")
    incoming = f"{target['appRoot']}/incoming/"
    upload(target, REMOTE / "rollback.sh", incoming)
    cmd_parts = [
        "bash", incoming + "rollback.sh",
        "--app-root", target["appRoot"],
        "--service", target["serviceName"],
        "--backend-port", str(target["backendPort"]),
        "--backup-dir", backup_dir,
    ]
    if args.restore_data:
        cmd_parts.append("--restore-data")
    rc, out = run_remote_cmd(target, _quote_cmd(cmd_parts), capture=True)
    print(out)
    if rc != 0 or "ROLLBACK_OK" not in out:
        die("rollback failed")
    readback = https_readback(target, require_read_only=not args.allow_write_mode)
    print(f"ROLLBACK_VERIFIED: HTTPS healthz OK ({readback['healthzBody']})")


def main():
    p = argparse.ArgumentParser(description="better-zentao Server 1.0 release orchestrator")
    p.add_argument("--target", default=None, help="Path to local target.json (default: ~/.config/better-zentao-release/target.json)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("probe", help="read-only host/service/nginx/health inspection")
    sp.set_defaults(func=cmd_probe)

    sp = sub.add_parser("verify", help="read-only external HTTPS health/startup/auth-guard check")
    sp.add_argument("--allow-write-mode", action="store_true", help="Do not fail if server reports readOnly=false")
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("logs", help="read-only systemd journal & nginx error log diagnostics")
    sp.add_argument("--lines", type=int, default=100)
    sp.set_defaults(func=cmd_logs)

    sp = sub.add_parser("build", help="build + package a merged origin/main commit")
    sp.add_argument("--repo", default=str(Path.cwd()))
    sp.add_argument("--commit", default="origin/main")
    sp.add_argument("--date", default=datetime.date.today().strftime("%Y%m%d"))
    sp.set_defaults(func=cmd_build)

    sp = sub.add_parser("bootstrap", help="first-time host initialization (requires --confirm BOOTSTRAP_BZT)")
    sp.add_argument("--server-config", required=True)
    sp.add_argument("--team-config", required=True)
    sp.add_argument("--allow-write-mode", action="store_true", help="Explicitly permit readOnly=false or notify.enabled=true")
    sp.add_argument("--confirm", default="")
    sp.set_defaults(func=cmd_bootstrap)

    sp = sub.add_parser("backup", help="standalone SQLite-consistent backup of data, config, and active release")
    sp.add_argument("--tag", default="")
    sp.set_defaults(func=cmd_backup)

    sp = sub.add_parser("release", help="prepare (READY) or, with --confirm DEPLOY_BZT, switch + verify")
    sp.add_argument("--repo", default=str(Path.cwd()))
    sp.add_argument("--commit", default="origin/main")
    sp.add_argument("--date", default=datetime.date.today().strftime("%Y%m%d"))
    sp.add_argument("--confirm", default="")
    sp.add_argument("--skip-build", action="store_true")
    sp.add_argument("--archive")
    sp.add_argument("--release-id")
    sp.add_argument("--sha256")
    sp.add_argument("--source-sha")
    sp.add_argument("--allow-write-mode", action="store_true", help="Do not fail verify if server reports readOnly=false")
    sp.set_defaults(func=cmd_release)

    sp = sub.add_parser("rollback", help="restore a previous release from backup (requires --confirm ROLLBACK_BZT)")
    sp.add_argument("--backup-dir", required=True)
    sp.add_argument("--restore-data", action="store_true")
    sp.add_argument("--allow-write-mode", action="store_true", help="Do not fail verify if server reports readOnly=false")
    sp.add_argument("--confirm", default="")
    sp.set_defaults(func=cmd_rollback)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
