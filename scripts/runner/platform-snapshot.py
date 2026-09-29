"""T-244: non-destructive snapshots of historical and pilot platform data.

No model downloads, runtime stops, migrations or source status changes.
Each database dump and its counts share an exported read-only snapshot.
Restore runs in a temporary database, then that database is removed.
Encryption uses the existing CMS AES-GCM backup filters and public recipient.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import time
from datetime import datetime, timezone


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def sql(container, database, query):
    return run("docker", "exec", "-u", "postgres", container, "psql", "-XqAt", "-d", database, "-c", query)


def snapshot(container, output):
    tables = sql(container, "inspector", "select schemaname||'.'||tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1").splitlines()
    assert all(re.fullmatch(r"\w+\.\w+", table) for table in tables)
    query = " union all ".join(f"select '{table}',count(*) from " + ".".join('"'+s+'"' for s in table.split('.')) for table in tables)
    temporary = "t244_restore_" + str(os.getpid()) + "_" + str(int(time.time()))
    with (output.parent/(container+".psql.log")).open("x") as errors:
        proc = subprocess.Popen(["docker", "exec", "-i", "-u", "postgres", container, "psql", "-XqAt", "-d", "inspector"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, bufsize=0)
        def line():
            if not select.select([proc.stdout], [], [], 30)[0]:
                raise TimeoutError("snapshot SQL did not return")
            value = proc.stdout.readline().decode().strip()
            if not value:
                raise RuntimeError("snapshot SQL terminated")
            return value
        try:
            proc.stdin.write(b"begin isolation level repeatable read read only; select pg_export_snapshot();\n"); proc.stdin.flush()
            identity = line()
            assert re.fullmatch(r"[0-9A-Fa-f-]+", identity), "invalid exported snapshot"
            proc.stdin.write((query+";\n").encode()); proc.stdin.flush()
            counts = dict(line().split("|") for _ in tables)
            with output.open("xb") as dump:
                subprocess.run(["docker", "exec", "-u", "postgres", container, "pg_dump", "-Fc", "--snapshot="+identity, "inspector"], stdout=dump, stderr=errors, check=True, timeout=600)
            proc.stdin.write(b"rollback;\n"); proc.stdin.close()
            assert proc.wait(timeout=30) == 0
        finally:
            if proc.poll() is None:
                proc.terminate(); proc.wait(timeout=30)
        created = False
        try:
            run("docker", "exec", "-u", "postgres", container, "createdb", temporary); created = True
            with output.open("rb") as dump:
                subprocess.run(["docker", "exec", "-i", "-u", "postgres", container, "pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "-d", temporary], stdin=dump, stderr=errors, check=True, timeout=600)
            restored = dict(row.split("|") for row in sql(container, temporary, query).splitlines())
            assert restored == counts, "restored table counts differ from frozen snapshot"
        finally:
            if created:
                run("docker", "exec", "-u", "postgres", container, "dropdb", temporary)
    with output.open("rb") as dump:
        sha = hashlib.file_digest(dump, "sha256").hexdigest()
    return {"source_container": container, "snapshot": identity, "counts": counts, "dump_sha256": sha, "dump_bytes": output.stat().st_size, "restore_verified": True}


def tar(output, directory, entries):
    assert all((directory/name).exists() for name in entries)
    subprocess.run(["tar", "--exclude=*.sock", "-cf", str(output), "-C", str(directory), *entries], check=True, timeout=1200)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--recipient", type=Path, required=True)
    parser.add_argument("--sources", type=Path, required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    work = args.output/"snapshot"; work.mkdir(mode=0o700)
    manifest = {"schema": "platform-backup/1", "started_utc": datetime.now(timezone.utc).isoformat(), "weights_included": False, "databases": {}}
    with open("/opt/resource-ocr/platform-backup.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        base = Path("/opt/stand-gpu")
        pilot = Path("/opt/w1-gate/stand/w1-feat-resource-ocr-incremental")
        state = json.loads((pilot/"var/pipeline-cache/node-admission-v1/state.json").read_text())["state"]
        assert not state["queue"] and not state["reservations"], "pilot processing active"
        for service in ("api", "ml"):
            assert run("docker", "inspect", "--format", "{{.State.Running}}", "nadzorium-gpu-"+service+"-1") == "false", "historical source is receiving processing; choose a coordinated snapshot"
        for name in ("nadzorium-gpu", "w1-feat-resource-ocr-incremental"):
            manifest["databases"][name] = snapshot(name+"-postgres-1", work/(name+".dump"))
            (work/"database-snapshots.json").write_text(json.dumps(manifest, indent=2))
            print(json.dumps({"database": name, "restore_verified": True, "dump_bytes": manifest["databases"][name]["dump_bytes"]}), flush=True)
        shutil.copytree(args.sources, work/"source-recovery")
        with (work/"runtime-containers.json").open("x") as output:
            subprocess.run(["docker", "inspect", "nadzorium-gpu-api-1", "nadzorium-gpu-ml-1", "nadzorium-gpu-web-1", "vllm-reader"], stdout=output, check=True)
        with (work/"redis-snapshot.log").open("x") as output:
            subprocess.run(["docker", "exec", "nadzorium-gpu-redis-1", "redis-cli", "--tls", "--cacert", "/run/tls/ca.crt", "-h", "127.0.0.1", "--rdb", "/data/.t244-historical-cache.rdb"], stdout=output, stderr=output, check=True, timeout=600)
        subprocess.run(["docker", "cp", "nadzorium-gpu-redis-1:/data/.t244-historical-cache.rdb", str(work/"historical-cache.rdb")], check=True)
        subprocess.run(["docker", "exec", "nadzorium-gpu-redis-1", "rm", "/data/.t244-historical-cache.rdb"], check=True)
        print(json.dumps({"historical_redis_snapshot_bytes": (work/"historical-cache.rdb").stat().st_size}), flush=True)
        cache = Path("/opt/inspector/cache")
        if cache.exists():
            tar(work/"historical-parser-cache.tar", cache, ["."])
        entries = [name for name in ("blobs", "readers", "src", "tls", "secrets", "caddy", "pkg", "load-reports", "rabbitmq-auth.conf", "stand.env", "tuning.env", "revision", "revision-api", "revision-web", "revision-ml") if (base/name).exists()]
        tar(work/"historical-state.tar", base, entries)
        tar(work/"pilot-state.tar", pilot, [name for name in ("var", "override.yml", "gpu-override.yml") if (pilot/name).exists()])
        volume = run("docker", "volume", "inspect", "w1-feat-resource-ocr-incremental_api-blobs", "--format", "{{.Mountpoint}}")
        assert volume.startswith("/var/lib/docker/volumes/w1-feat-resource-ocr-incremental_api-blobs/")
        tar(work/"pilot-blobs.tar", Path(volume), ["."])
        manifest["files"] = {}
        for path in work.glob("*.tar"):
            with path.open("rb") as stream:
                sha = hashlib.file_digest(stream, "sha256").hexdigest()
            manifest["files"][path.name] = {"bytes": path.stat().st_size, "sha256": sha}
        manifest["finished_utc"] = datetime.now(timezone.utc).isoformat()
        (work/"manifest.json").write_text(json.dumps(manifest, indent=2))
        with (args.output/"encrypt.log").open("x") as errors:
            producer = subprocess.Popen(["tar", "-cf", "-", "-C", str(args.output), "snapshot"], stdout=subprocess.PIPE, stderr=errors)
            try:
                result = subprocess.run(["sh", "deploy/gpu/backup/at-rest-encrypt.sh", "-r", str(args.recipient), "-o", str(args.output/"encrypted")], stdin=producer.stdout, stderr=errors, timeout=1800)
                producer.stdout.close()
                assert producer.wait(timeout=30) == 0 and result.returncode == 0, "backup encryption failed"
            finally:
                if producer.poll() is None:
                    producer.terminate(); producer.wait(timeout=30)
        print(json.dumps({"output": str(args.output), "database_restore_verified": True, "archive_bytes": sum(x["bytes"] for x in manifest["files"].values()), "encrypted_parts": len(list((args.output/"encrypted").glob("part-*.cms")))}))


if __name__ == "__main__":
    main()
