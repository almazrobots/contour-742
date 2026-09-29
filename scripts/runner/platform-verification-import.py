"""Restore preserved annotations into an empty, isolated release candidate.

Never imports users, migration journals or inspector processing results. The
source dump is restored in an ephemeral, network-isolated PostgreSQL instance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

TABLES = (
    "verification_ingestions", "verification_tasks", "verification_assignments",
    "verification_labels", "verification_adjudications", "verification_coverage",
    "verification_datasets", "verification_dataset_items", "verification_source_groups",
    "verification_library_marks",
)
IMAGE = "postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def sql(container, query):
    return subprocess.check_output(
        ["docker", "exec", "-u", "postgres", container, "psql", "-XqAt",
         "-v", "ON_ERROR_STOP=1", "-d", "inspector", "-c", query], text=True).strip()


def fingerprint_query(table):
    return ("select encode(sha256(convert_to(coalesce(string_agg(h,'' order by h),''),'UTF8')),'hex') "
            "from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h "
            "from inspector." + table + " t) hashes")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    # Deliberately reject both public PostgreSQL service names.
    if not re.fullmatch(r"(?:nadzorium-candidate|platform-install-v\d+)-postgres-1", args.target):
        raise ValueError("only an isolated candidate PostgreSQL is an import target")
    with args.dump.open("rb") as f:
        digest = hashlib.sha256()
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
        if digest.hexdigest() != args.sha256:
            raise ValueError("preserved dump checksum mismatch")
    os.umask(0o077)
    args.output.mkdir(parents=True, mode=0o700, exist_ok=False)
    report = {"schema": "platform-verification-import/1", "source_dump_sha256": args.sha256,
              "target": args.target, "users_changed": False, "source_changed": False,
              "migration_journal_imported": False, "completed": False}
    source = "t244-verification-restore-" + str(os.getpid())
    database_dir = args.output / "source-postgres"
    database_dir.mkdir(mode=0o700)
    os.chown(database_dir, 70, 70)
    try:
        run(["docker", "run", "-d", "--name", source, "--network", "none", "--memory", "768m",
             "--memory-swap", "768m", "--cpus", "1", "--pids-limit", "128",
             "-v", f"{database_dir.resolve()}:/var/lib/postgresql", "-e", "POSTGRES_DB=inspector",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-v", f"{args.dump.resolve()}:/source.dump:ro",
             IMAGE], stdout=subprocess.DEVNULL)
        for _ in range(60):
            if subprocess.run(["docker", "exec", source, "psql", "-U", "postgres", "-d", "inspector", "-Atc", "select 1"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("isolated source PostgreSQL did not become ready")
        with (args.output / "restore.log").open("w") as log:
            run(["docker", "exec", source, "pg_restore", "-U", "postgres", "--exit-on-error",
                 "--no-owner", "--no-acl", "-d", "inspector", "/source.dump"], stdout=log, stderr=log)
        def rows(c, query):
            return json.loads(sql(c, "select coalesce(json_agg(t),'[]') from (" + query + ") t"))
        users_before = rows(args.target, "select id,login,role from inspector.users order by id")
        source_users = rows(source, "select id,login,role from inspector.users order by id")
        identities = {r["id"]: r for r in users_before}
        if any(r["id"] not in identities or identities[r["id"]]["login"] != r["login"] for r in source_users):
            raise RuntimeError("source user attribution cannot be matched without changing accounts")
        report["identity_mapping_verified"] = True
        report["role_difference_count"] = sum(identities[r["id"]]["role"] != r["role"] for r in source_users)
        source_params = set(json.loads(sql(source, "select json_agg(code) from inspector.params")))
        target_params = set(json.loads(sql(args.target, "select json_agg(code) from inspector.params")))
        if not source_params <= target_params:
            raise RuntimeError("source parameters are absent from candidate")
        before = {t: int(sql(args.target, "select count(*) from inspector." + t)) for t in TABLES}
        if any(before.values()):
            raise RuntimeError("candidate annotation tables must be empty; refusing to overwrite or duplicate")
        source_counts = {t: int(sql(source, "select count(*) from inspector." + t)) for t in TABLES}
        fingerprints = {t: sql(source, fingerprint_query(t)) for t in TABLES}
        report["source_counts"] = source_counts
        report["source_fingerprints"] = fingerprints
        data = args.output / "annotations.sql"
        with data.open("wb") as out:
            out.write(b"BEGIN; SET LOCAL lock_timeout='10s';\n")
            for table in TABLES:
                run(["docker", "exec", "-u", "postgres", source, "pg_dump", "--data-only", "--no-owner",
                     "--no-acl", "-d", "inspector", "-t", "inspector." + table], stdout=out)
            # COPY preserves historical generated identity values; new IDs must advance past them.
            for table, column in (("verification_assignments", "buffer_order"), ("verification_adjudications", "id")):
                out.write(("SELECT setval(pg_get_serial_sequence('inspector." + table + "','" + column + "'),"
                           "coalesce((select max(" + column + ") from inspector." + table + "),1),"
                           "exists(select 1 from inspector." + table + "));\n").encode())
            for table, count in source_counts.items():
                out.write(("DO $$ BEGIN IF (SELECT count(*) FROM inspector." + table + ") <> " + str(count) +
                           " THEN RAISE EXCEPTION 'annotation count differs'; END IF; END $$;\n").encode())
                out.write(("DO $$ BEGIN IF (" + fingerprint_query(table) + ") <> '" + fingerprints[table] +
                           "' THEN RAISE EXCEPTION 'annotation contents differ'; END IF; END $$;\n").encode())
            out.write(b"COMMIT;\n")
        with data.open("rb") as inp, (args.output / "import.log").open("wb") as log:
            run(["docker", "exec", "-i", "-u", "postgres", args.target, "psql", "-Xq",
                 "-v", "ON_ERROR_STOP=1", "-d", "inspector"], stdin=inp, stdout=log, stderr=log)
        after = {t: int(sql(args.target, "select count(*) from inspector." + t)) for t in TABLES}
        if after != source_counts:
            raise RuntimeError("restored annotation counts differ")
        if rows(args.target, "select id,login,role from inspector.users order by id") != users_before:
            raise RuntimeError("candidate users changed")
        report["target_counts"] = after
        report["contents_verified"] = True
        report["completed"] = True
        print(json.dumps({"completed": True, "tasks": after["verification_tasks"],
                          "labels": after["verification_labels"], "users_changed": False}))
    except Exception as exc:
        report["error"] = str(exc)
        raise
    finally:
        (args.output / "evidence.json").write_text(json.dumps(report, indent=2))
        subprocess.run(["docker", "rm", "-f", source], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
