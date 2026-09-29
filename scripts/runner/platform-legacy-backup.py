"""T-244: supplement current-runtime backup with older artifacts and corpus.

Private archive, never used as an independent acceptance dataset. Model/env
dependency caches are excluded; stopped database volumes are preserved as cold
recovery material, not claimed as a verified logical restore.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone
from runpy import run_path

snapshot = run_path(str(Path(__file__).with_name("platform-snapshot.py")))["snapshot"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--recipient", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("requires root")
    os.umask(0o077)
    args.output.mkdir(parents=True, mode=0o700, exist_ok=False)
    work = args.output / "snapshot"
    work.mkdir(mode=0o700)
    manifest = {"schema": "platform-legacy-backup/1", "started_utc": datetime.now(timezone.utc).isoformat(),
                "databases": {}, "files": {}, "scope": "historical development data and original corpus"}
    manifest["databases"]["w1-main"] = snapshot("w1-main-postgres-1", work / "w1-main.dump")
    sources = {
        "original-corpus.tar": (Path("/opt/corpus"), ["."], []),
        "older-inspector.tar": (Path("/opt/inspector"), ["."], ["./ml/.venv"]),
        "runner-history.tar": (Path("/opt/w1-gate"), ["logs", "passport", "priority-backups", "stand"], ["*.sock"]),
        "earlier-resource-backups.tar": (Path("/opt/resource-ocr/backups"), ["."], []),
    }
    reports = []
    for parent in Path("/opt/w1-gate/wt").iterdir():
        candidates = list(parent.iterdir()) if parent.name == "u" else [parent]
        for candidate in candidates:
            for suffix in ("apps/api/reports", "ml/artifacts", "var", "test-results", "playwright-report"):
                path = candidate / suffix
                if path.is_dir() and not path.is_symlink():
                    reports.append(str(path.relative_to("/opt/w1-gate/wt")))
    if reports:
        sources["earlier-worktree-reports.tar"] = (Path("/opt/w1-gate/wt"), sorted(reports), ["*.sock"])
    for volume in ("w1-main_api-blobs", "w1-main_ml-cache", "w1-feat-w3-t158-nginx-live_api-blobs",
                   "w1-feat-w3-t158-nginx-live_ml-cache", "w1-feat-w3-t158-nginx-live_postgres-data"):
        if volume.endswith("postgres-data"):
            users = subprocess.check_output(["docker", "ps", "--filter", "volume="+volume, "-q"], text=True).strip()
            if users:
                raise RuntimeError("cold database volume has an active writer")
        mount = subprocess.check_output(["docker", "volume", "inspect", volume, "--format", "{{.Mountpoint}}"], text=True).strip()
        if not mount.startswith("/var/lib/docker/volumes/"+volume+"/"):
            raise RuntimeError("unexpected volume mount")
        sources[volume+".tar"] = (Path(mount), ["."], ["*.sock"])
    for name, (root, entries, excludes) in sources.items():
        if not root.is_dir():
            raise FileNotFoundError(root)
        path = work / name
        subprocess.run(["tar", *("--exclude="+p for p in excludes), "-cf", str(path), "-C", str(root), *entries],
                       check=True, timeout=1800)
        with path.open("rb") as stream:
            sha = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest["files"][name] = {"sha256": sha, "bytes": path.stat().st_size,
                                   "source": str(root), "entries": entries, "excludes": excludes}
        print(json.dumps({"archive": name, "bytes": path.stat().st_size}), flush=True)
        (work / "manifest.json").write_text(json.dumps(manifest, indent=2))
    manifest["finished_utc"] = datetime.now(timezone.utc).isoformat()
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2))
    with (args.output / "encrypt.log").open("x") as errors:
        producer = subprocess.Popen(["tar", "-cf", "-", "-C", str(args.output), "snapshot"], stdout=subprocess.PIPE, stderr=errors)
        try:
            result = subprocess.run(["sh", "deploy/gpu/backup/at-rest-encrypt.sh", "-r", str(args.recipient),
                                     "-o", str(args.output / "encrypted")], stdin=producer.stdout, stderr=errors, timeout=3600)
            producer.stdout.close()
            if producer.wait(timeout=30) != 0 or result.returncode != 0:
                raise RuntimeError("legacy encryption failed")
        finally:
            if producer.poll() is None:
                producer.terminate()
                producer.wait(timeout=30)
    print(json.dumps({"legacy_backup_complete": True, "output": str(args.output)}))


if __name__ == "__main__":
    main()
