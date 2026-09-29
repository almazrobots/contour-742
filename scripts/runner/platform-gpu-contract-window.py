"""T-244: bounded embedded-image probe, with a resumable collector pause.

Only the explicit teacher collector is paused; Reader and platform services are
never stopped. Preserve its SQLite checkpoint and exact unit, then resume even
if the probe fails. Interrupted uncommitted collector bands can be replayed;
they are not independent quality observations.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
import urllib.request

UNIT = "verification-corpus-t244.service"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--revision", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--redis-image", required=True)
    a = p.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r"[0-9a-f]{40}", a.revision):
        raise ValueError("root and pinned source revision required")
    if not all(re.fullmatch(r"sha256:[0-9a-f]{64}", v) for v in (a.image, a.redis_image)):
        raise ValueError("immutable image IDs required")
    if not re.fullmatch(r"/opt/resource-ocr/t236-platform-[a-zA-Z0-9_-]+", str(a.output)):
        raise ValueError("isolated probe output required")
    os.umask(0o077)
    a.output.mkdir(mode=0o700, exist_ok=False)
    evidence = {"schema": "platform-gpu-window/1", "queue_unit": UNIT,
                "revision": a.revision, "image": a.image,
                "started_utc": datetime.now(timezone.utc).isoformat()}
    def save():
        (a.output / "window.json").write_text(json.dumps(evidence, indent=2))
    pid = int(subprocess.check_output(["systemctl", "show", UNIT, "-p", "MainPID", "--value"], text=True))
    if pid <= 0:
        raise RuntimeError("expected collector is not running")
    proc = Path("/proc") / str(pid)
    argv = (proc / "cmdline").read_bytes().split(b"\0")
    if b"teacher.corpus_queue" not in argv:
        raise RuntimeError("unit is not the expected resumable collector")
    log = Path(os.readlink(proc / "fd/1"))
    if not str(log).startswith("/opt/w1-gate/eval/verification/") or log.name != "runner.log":
        raise RuntimeError("unexpected collector output path")
    queue_root = log.parent
    unit_file = a.output / UNIT
    unit_file.write_bytes(subprocess.check_output(["systemctl", "cat", UNIT]))
    source = sqlite3.connect(f"file:{queue_root / 'candidates.sqlite'}?mode=ro", uri=True, timeout=30)
    target = sqlite3.connect(a.output / "queue-before.sqlite")
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    evidence["queue_before"] = json.loads((queue_root / "status.json").read_text())
    evidence["previous_pid"] = pid
    save()
    code = a.output / "code"
    code.mkdir()
    archive = subprocess.Popen(["git", "archive", a.revision], stdout=subprocess.PIPE)
    try:
        subprocess.run(["tar", "-xf", "-", "-C", str(code)], stdin=archive.stdout, check=True)
        archive.stdout.close()
        if archive.wait() != 0:
            raise RuntimeError("pinned test-driver export failed")
    finally:
        if archive.poll() is None:
            archive.terminate()
            archive.wait()
    code.chmod(0o755)
    out = a.output / "output"
    out.mkdir(mode=0o700)
    os.chown(out, 10001, 10001)
    # From this point always attempt to restore the collector, including stop
    # failures/timeouts. systemd may collect a stopped transient unit, so its
    # original definition is kept for a runtime-only link if needed.
    try:
        subprocess.run(["systemctl", "stop", UNIT], check=True, timeout=35)
        evidence["paused_utc"] = datetime.now(timezone.utc).isoformat()
        save()
        deadline = time.monotonic() + 300
        while True:
            metrics = urllib.request.urlopen("http://127.0.0.1:8000/metrics", timeout=10).read().decode()
            rows = [l for l in metrics.splitlines() if l.startswith(("vllm:num_requests_running{", "vllm:num_requests_waiting{"))]
            if len(rows) >= 2 and all(float(l.rsplit(' ', 1)[1]) == 0 for l in rows):
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("resident Reader did not drain")
            time.sleep(2)
        env = dict(os.environ, BASELINE_ROOT=str(a.output), BASELINE_EMBEDDED_CODE="1",
                   BASELINE_IMAGE=a.image, REDIS_IMAGE=a.redis_image, BASELINE_REVISION=a.revision)
        with (a.output / "probe.log").open("w") as log_file:
            result = subprocess.run(["bash", "scripts/runner/resource-ocr-contracts.sh"],
                                    env=env, stdout=log_file, stderr=log_file, timeout=660)
        evidence["probe_exit_code"] = result.returncode
        save()
        if result.returncode:
            raise RuntimeError("embedded-image GPU contracts failed; private probe.log retained")
    finally:
        fragment = subprocess.check_output(["systemctl", "show", UNIT, "-p", "FragmentPath", "--value"], text=True).strip()
        if not fragment:
            subprocess.run(["systemctl", "link", "--runtime", str(unit_file)], check=True)
            evidence["resume_unit_source"] = "preserved runtime unit definition"
        subprocess.run(["systemctl", "start", UNIT], check=True, timeout=35)
        evidence["resumed_pid"] = int(subprocess.check_output(["systemctl", "show", UNIT, "-p", "MainPID", "--value"], text=True))
        evidence["resumed"] = evidence["resumed_pid"] > 0
        evidence["finished_utc"] = datetime.now(timezone.utc).isoformat()
        save()
        if not evidence["resumed"]:
            raise RuntimeError("collector resume not confirmed")
    print(json.dumps({"gpu_contracts_passed": True, "collector_resumed": True,
                      "reader_stopped": False, "platform_stopped": False}))


if __name__ == "__main__":
    main()
