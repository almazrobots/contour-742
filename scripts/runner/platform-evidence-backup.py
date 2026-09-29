"""T-244: preserve private experiment evidence separately from runtime data.

Does not include model weights or previously generated backup directories.
Uses the existing CMS encryption format; only a public certificate is needed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--recipient", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("private evidence backup requires root")
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    work = args.output / "snapshot"
    work.mkdir(mode=0o700)
    resource = Path("/opt/resource-ocr")
    entries = sorted(p.name for p in resource.iterdir()
                     if not p.name.startswith("platform-")
                     and p.name not in {"backups", "backup-recipient-20260929.crt.pem"})
    archives = {"experiment-evidence.tar": (resource, entries),
                "evaluation-evidence.tar": (Path("/opt/w1-gate/eval"), ["."])}
    manifest = {"schema": "platform-evidence-backup/1",
                "started_utc": datetime.now(timezone.utc).isoformat(),
                "scope": "private experimental artifacts; not an acceptance dataset",
                "files": {}}
    for name, (root, names) in archives.items():
        path = work / name
        subprocess.run(["tar", "--exclude=*.sock", "-cf", str(path),
                        "-C", str(root), *names], check=True, timeout=1200)
        with path.open("rb") as stream:
            sha = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest["files"][name] = {"bytes": path.stat().st_size,
                                   "sha256": sha, "source": str(root),
                                   "entries": names}
    manifest["finished_utc"] = datetime.now(timezone.utc).isoformat()
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2))
    with (args.output / "encrypt.log").open("x") as errors:
        producer = subprocess.Popen(["tar", "-cf", "-", "-C", str(args.output),
                                     "snapshot"], stdout=subprocess.PIPE, stderr=errors)
        try:
            encrypted = subprocess.run(["sh", "deploy/gpu/backup/at-rest-encrypt.sh",
                                        "-r", str(args.recipient), "-o", str(args.output / "encrypted")],
                                       stdin=producer.stdout, stderr=errors, timeout=1800)
            producer.stdout.close()
            if producer.wait(timeout=30) != 0 or encrypted.returncode != 0:
                raise RuntimeError("evidence encryption failed")
        finally:
            if producer.poll() is None:
                producer.terminate()
                producer.wait(timeout=30)
    print(json.dumps({"output": str(args.output),
                      "archive_bytes": sum(v["bytes"] for v in manifest["files"].values())}))


if __name__ == "__main__":
    main()
