"""T-244: validate the preserved old PostgreSQL volume in an isolated clone."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

IMAGE = "postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    name = "w1-feat-w3-t158-nginx-live_postgres-data.tar"
    manifest = json.loads((args.snapshot / "manifest.json").read_text())
    archive = args.snapshot / name
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != manifest["files"][name]["sha256"]:
        raise RuntimeError("cold-volume archive checksum differs")
    data = args.output / "data"
    data.mkdir()
    subprocess.run(["tar", "-xf", str(archive), "-C", str(data)], check=True)
    data.chmod(0o755)  # UID70 needs to traverse the bind mount; outer directory is700.
    if (data / "18/docker/PG_VERSION").read_text().strip() != "18":
        raise RuntimeError("unexpected PostgreSQL major version")
    hba = args.output / "restore-hba.conf"
    hba.write_text("local all all trust\n")
    hba.chmod(0o644)  # Local socket only, no network or host port.
    container = f"platform-restore-w3-{os.getpid()}"
    created = False
    def sql(query):
        return subprocess.check_output(["docker", "exec", container, "psql", "-XqAt",
                                        "-U", "postgres", "-d", "inspector", "-c", query],
                                       text=True, stderr=subprocess.DEVNULL).strip()
    try:
        subprocess.run(["docker", "run", "-d", "--name", container, "--network", "none",
                        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                        "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--pids-limit", "128",
                        "--user", "70:70", "--tmpfs", "/run/postgresql:uid=70,gid=70,mode=0755",
                        "-v", f"{data}:/data", "-v", f"{hba}:/run/restore-hba.conf:ro",
                        "--entrypoint", "postgres", IMAGE, "-D", "/data/18/docker",
                        "-c", "ssl=off", "-c", "listen_addresses=", "-c", "hba_file=/run/restore-hba.conf"],
                       check=True, stdout=subprocess.DEVNULL)
        created = True
        for attempt in range(30):
            try:
                if sql("select 1") == "1":
                    break
            except subprocess.CalledProcessError:
                time.sleep(1)
        else:
            raise RuntimeError("cold-volume clone did not become ready")
        tables = sql("select schemaname||'.'||tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1").splitlines()
        counts = {table: int(sql('select count(*) from '+'.'.join('"'+part+'"' for part in table.split('.')))) for table in tables}
        report = {"schema": "platform-cold-db-restore/1", "archive_sha256": digest,
                  "image": IMAGE, "network": "none", "source_changed": False,
                  "queryable": True, "table_counts": counts}
        (args.output / "restore.json").write_text(json.dumps(report, indent=2))
        print(json.dumps({"cold_volume_queryable": True, "tables": len(tables), "source_changed": False}))
    finally:
        if created:
            with (args.output / "postgres.log").open("w") as logs:
                subprocess.run(["docker", "logs", container], stdout=logs, stderr=logs)
            subprocess.run(["docker", "stop", "-t", "10", container], stdout=subprocess.DEVNULL, check=True)
            subprocess.run(["docker", "rm", container], stdout=subprocess.DEVNULL, check=True)


if __name__ == "__main__":
    main()
