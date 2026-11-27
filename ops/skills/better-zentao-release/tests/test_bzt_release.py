#!/usr/bin/env python3
"""Offline unit tests for ops/skills/better-zentao-release/scripts/bzt_release.py.

Zero network calls, zero remote SSH, zero real intranet topology.
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "bzt_release.py"
SPEC = importlib.util.spec_from_file_location("bzt_release", SCRIPT_PATH)
bzt_release = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(bzt_release)


class TestBztReleaseOffline(unittest.TestCase):
    def _write_target(self, tmpdir: Path, overrides: dict | None = None) -> Path:
        data = {
            "host": "192.0.2.10",
            "sshUser": "root",
            "hostKeyMd5": "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
            "appRoot": "/opt/better-zentao",
            "serviceName": "better-zentao.service",
            "nginxSiteName": "better-zentao",
            "backendPort": 17330,
            "httpsPort": 17443,
            "httpsUrl": "https://192.0.2.10:17443",
            "wrapperPath": "C:\\example\\invoke-with-local-credentials.ps1",
        }
        if overrides:
            data.update(overrides)
        p = tmpdir / "target.json"
        p.write_text(json.dumps(data), encoding="utf-8")
        return p

    def test_load_target_valid(self):
        with tempfile.TemporaryDirectory() as td:
            p = self._write_target(Path(td))
            cfg = bzt_release.load_target(str(p))
            self.assertEqual(cfg["host"], "192.0.2.10")
            self.assertEqual(cfg["backendPort"], 17330)
            self.assertEqual(cfg["httpsUrl"], "https://192.0.2.10:17443")

    def test_load_target_rejects_shell_metacharacters(self):
        with tempfile.TemporaryDirectory() as td:
            for bad in (
                {"host": "192.0.2.10;id"},
                {"appRoot": "/opt/better-zentao;rm -rf /"},
                {"appRoot": "/opt/../etc"},
                {"serviceName": "bzt.service$(whoami)"},
                {"backendPort": 70000},
                {"httpsUrl": "http://192.0.2.10:17443"},
            ):
                p = self._write_target(Path(td), bad)
                with self.assertRaises(SystemExit):
                    bzt_release.load_target(str(p))

    def test_quote_cmd_escapes_spaces_and_metachars(self):
        quoted = bzt_release._quote_cmd(["bash", "/opt/a b/deploy.sh", "--tag", "v1;id"])
        self.assertIn("'/opt/a b/deploy.sh'", quoted)
        self.assertIn("'v1;id'", quoted)

    def test_bootstrap_rejects_missing_confirm_and_write_mode(self):
        with tempfile.TemporaryDirectory() as td:
            td_p = Path(td)
            t_path = self._write_target(td_p)
            srv = td_p / "server.json"
            team = td_p / "team.json"
            srv.write_text(json.dumps({"readOnly": False, "notify": {"enabled": False}}), encoding="utf-8")
            team.write_text("{}", encoding="utf-8")

            # Missing confirmation token
            args = mock.MagicMock(
                target=str(t_path),
                server_config=str(srv),
                team_config=str(team),
                confirm="",
                allow_write_mode=False,
            )
            with self.assertRaises(SystemExit):
                bzt_release.cmd_bootstrap(args)

            # Valid confirm, but readOnly=false without --allow-write-mode
            args.confirm = "BOOTSTRAP_BZT"
            with self.assertRaises(SystemExit):
                bzt_release.cmd_bootstrap(args)

    def test_rollback_rejects_missing_confirm_and_outside_backup_dir(self):
        with tempfile.TemporaryDirectory() as td:
            t_path = self._write_target(Path(td))
            args = mock.MagicMock(
                target=str(t_path),
                backup_dir="/opt/better-zentao/backups/20261127-abc12345-before",
                restore_data=False,
                allow_write_mode=False,
                confirm="WRONG",
            )
            with self.assertRaises(SystemExit):
                bzt_release.cmd_rollback(args)

            args.confirm = "ROLLBACK_BZT"
            args.backup_dir = "/etc/passwd"
            with self.assertRaises(SystemExit):
                bzt_release.cmd_rollback(args)

    def test_skip_build_requires_origin_main_and_build_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            td_p = Path(td)
            t_path = self._write_target(td_p)
            arch = td_p / "bzt-release-20261127-abcdef12.tar.gz"
            arch.write_bytes(b"dummy-archive-bytes")
            arch_sha = bzt_release.sha256_file(arch)
            src_sha = "a" * 40

            args = mock.MagicMock(
                target=str(t_path),
                repo=str(td_p),
                skip_build=True,
                archive=str(arch),
                release_id="20261127-abcdef12",
                sha256=arch_sha,
                source_sha=src_sha,
                confirm="",
                allow_write_mode=False,
            )
            # Even if origin/main ancestry passes, missing build.json receipt must fail
            with mock.patch.object(bzt_release, "verify_origin_main_ancestor", return_value=src_sha):
                with self.assertRaises(SystemExit):
                    bzt_release.cmd_release(args)


if __name__ == "__main__":
    unittest.main()
