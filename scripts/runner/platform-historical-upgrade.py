"""T-244: apply candidate migrations only to a restored, isolated database.

Original PostgreSQL remains running; the original inspector database is never
the migration target. Existing data columns are fingerprinted before/after.
"""
import argparse
import atexit
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

SOURCE = "nadzorium-gpu-postgres-1"
POSTGRES_IMAGE = "postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"
SEED_TABLES = {"inspector.schema_migrations", "inspector.meta", "inspector.params",
               "inspector.legal_acts", "inspector.normative_base", "inspector.logical_rules"}


def sql(container, database, query):
    return subprocess.check_output(["docker", "exec", "-u", "postgres", container,
                                    "psql", "-XqAt", "-d", database, "-c", query], text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--api-image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--export", action="store_true", help="Export verified migrated copy for the readonly CPU preview")
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.api_image):
        raise ValueError("API must be an immutable image ID")
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    database = "inspector"
    container = "t244-upgrade-" + str(os.getpid())
    network = container + "-db"
    dump = args.snapshot / "nadzorium-gpu.dump"
    snapshot = json.loads((args.snapshot / "manifest.json").read_text())
    with dump.open("rb") as stream:
        dump_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    if dump_sha != snapshot["databases"]["nadzorium-gpu"]["dump_sha256"]:
        raise RuntimeError("historical dump checksum differs from snapshot")
    report = {"schema": "platform-historical-upgrade/2", "database": database,
              "container": container, "network": network, "postgres_image": POSTGRES_IMAGE,
              "dump_sha256": dump_sha,
              "api_image": args.api_image, "source_database_changed": False}
    def save():
        (args.output / "evidence.json").write_text(json.dumps(report, indent=2))
    with dump.open("rb") as stream:
        toc = subprocess.check_output(["docker", "run", "--rm", "-i", "--network", "none",
                                       "--entrypoint", "pg_restore", POSTGRES_IMAGE, "-l"], stdin=stream, text=True)
    # public belongs to pg_database_owner, not the application schema owner.
    # The role initializer has already revoked PUBLIC privileges; restore all
    # application ACLs, keeping this one bootstrap ACL and verifying it below.
    public_acl_rows = [line for line in toc.splitlines() if " ACL - SCHEMA public " in line]
    if len(public_acl_rows) != 1:
        raise RuntimeError("unexpected public schema ACL in snapshot")
    restore_list = args.output / "restore.list"
    restore_list.write_text('\n'.join(line for line in toc.splitlines() if line not in public_acl_rows)+'\n')
    restore_list.chmod(0o644)
    report["bootstrap_public_acl_retained"] = True
    # The production HBA deliberately admits only database inspector. A new
    # cluster preserves that contract without weakening the original server.
    data_dir = args.output / "postgres-data"
    data_dir.mkdir(mode=0o700)
    os.chown(data_dir, 70, 70)
    init_dir = args.output / "init"
    shutil.copytree("deploy/gpu/postgres/init", init_dir)
    init_dir.chmod(0o755)
    for path in init_dir.iterdir():
        path.chmod(0o755 if path.suffix == ".sh" else 0o644)
    hba = args.output / "pg_hba.conf"
    shutil.copyfile("deploy/gpu/postgres/pg_hba.conf", hba)
    hba.chmod(0o644)
    subprocess.run(["docker", "network", "create", "--internal", network], check=True,
                   stdout=subprocess.DEVNULL)
    def cleanup():
        # Only this probe's uniquely named resources; retain private clone files
        # and server logs for diagnosis, regardless of the migration outcome.
        with (args.output / "postgres.log").open("w") as logs:
            subprocess.run(["docker", "logs", container], stdout=logs, stderr=logs, timeout=20)
        subprocess.run(["docker", "stop", "-t", "10", container],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        subprocess.run(["docker", "rm", container],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        subprocess.run(["docker", "network", "rm", network],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    atexit.register(cleanup)
    run = ["docker", "run", "-d", "--name", container, "--network", network,
           "--network-alias", "postgres", "--user", "70:70", "--memory", "2g",
           "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "256",
           "--shm-size", "256m", "--security-opt", "no-new-privileges:true",
           "--tmpfs", "/tmp", "--tmpfs", "/var/run/postgresql:uid=70,gid=70",
           "-e", "POSTGRES_DB=inspector", "-e", "POSTGRES_USER=postgres",
           "-e", "POSTGRES_PASSWORD_FILE=/run/secrets/pg_superuser_password",
           "-e", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=peer --encoding=UTF8 --locale=C.UTF-8",
           "-v", f"{data_dir}:/var/lib/postgresql",
           "-v", f"{init_dir}:/docker-entrypoint-initdb.d:ro",
           "-v", f"{restore_list}:/run/restore.list:ro",
           "-v", f"{hba}:/etc/postgresql/pg_hba.conf:ro",
           "-v", "/opt/stand-gpu/tls/postgres:/run/pg-tls:ro"]
    for secret in ("pg_superuser_password", "pg_migrator_password", "pg_app_password"):
        run.extend(["-v", f"/opt/stand-gpu/secrets/{secret}:/run/secrets/{secret}:ro"])
    run.extend([POSTGRES_IMAGE, "postgres", "-c", "listen_addresses=*",
                "-c", "hba_file=/etc/postgresql/pg_hba.conf", "-c", "ssl=on",
                "-c", "ssl_cert_file=/run/pg-tls/server.crt", "-c", "ssl_key_file=/run/pg-tls/server.key",
                "-c", "ssl_min_protocol_version=TLSv1.3"])
    subprocess.run(run, check=True, stdout=subprocess.DEVNULL)
    for _ in range(90):
        ready = subprocess.run(["docker", "exec", "-u", "postgres", container,
                                "psql", "-XqAt", "-d", database, "-c",
                                "select 1 from pg_roles where rolname='inspector_migrator'"],
                               capture_output=True, text=True)
        if ready.returncode == 0 and ready.stdout.strip() == "1":
            # Wait until the temporary init server has shut down and the final
            # server accepts TLS connections (socket readiness alone races init).
            logs = subprocess.check_output(["docker", "logs", container], stderr=subprocess.STDOUT, text=True)
            if "PostgreSQL init process complete" in logs:
                break
        time.sleep(1)
    else:
        raise RuntimeError("isolated PostgreSQL initialization did not complete")
    sql(container, database, "drop schema inspector cascade")
    sql(container, database, "grant create on database inspector to inspector_owner")
    public_acl_before = sql(container, database, "select nspacl::text from pg_namespace where nspname='public'")
    report["restored"] = False
    save()
    with dump.open("rb") as data, (args.output / "restore.log").open("w") as errors:
        subprocess.run(["docker", "exec", "-i", "-u", "postgres", container,
                        "pg_restore", "--exit-on-error", "--no-owner", "--role=inspector_owner",
                        "--use-list=/run/restore.list",
                        "-d", database], stdin=data, stderr=errors, check=True, timeout=600)
    sql(container, database, "revoke create on database inspector from inspector_owner")
    if public_acl_before != sql(container, database, "select nspacl::text from pg_namespace where nspname='public'"):
        raise RuntimeError("bootstrap public ACL changed during restore")
    report["restored"] = True
    columns = {}
    tables = sql(container, database, "select schemaname||'.'||tablename from pg_tables "
                 "where schemaname not in ('pg_catalog','information_schema') order by 1").splitlines()
    for qualified in tables:
        if not re.fullmatch(r"\w+\.\w+", qualified):
            raise RuntimeError("unsupported table identifier")
        schema, table = qualified.split('.')
        names = sql(container, database, "select column_name from information_schema.columns "
                    f"where table_name='{table}' and table_schema='{schema}' "
                    "order by ordinal_position").splitlines()
        if not all(re.fullmatch(r"\w+", name) for name in [schema, table, *names]):
            raise RuntimeError("unsupported identifier")
        columns[f"{schema}.{table}"] = names
    def fingerprints():
        result = {}
        for table, names in columns.items():
            qualified = '.'.join('"'+part+'"' for part in table.split('.'))
            fields = ','.join('"'+name+'"' for name in names)
            query = ("select count(*),coalesce(md5(string_agg(fingerprint,'' order by fingerprint)),md5('')) "
                     f"from (select md5(row({fields})::text) fingerprint from {qualified}) old_columns")
            count, digest = sql(container, database, query).split("|")
            result[table] = {"count": int(count), "original_columns_md5": digest}
        return result
    report["before"] = fingerprints()
    save()
    migrate_command = ["docker", "run", "--rm", "--network", network,
                                 "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                                 "--memory", "1g", "--memory-swap", "1g", "--cpus", "2", "--pids-limit", "256",
                                 "--tmpfs", "/tmp",
                                 "-e", "INSPECTOR_PROFILE=gpu",
                                 "-e", "INSPECTOR_ML_URL=https://ml-gpu:48811",
                                 "-e", f"INSPECTOR_DATABASE_URL=postgres://inspector_migrator@postgres:5432/{database}",
                                 "-e", "INSPECTOR_DATABASE_PASSWORD_FILE=/run/secrets/pg_migrator_password",
                                 "-e", "INSPECTOR_DATABASE_SSL_CA_FILE=/run/tls/ca.crt",
                                 "-v", "/opt/stand-gpu/secrets/pg_migrator_password:/run/secrets/pg_migrator_password:ro",
                                 "-v", "/opt/stand-gpu/tls/ca.crt:/run/tls/ca.crt:ro",
                                 args.api_image, "node", "apps/api/dist/migrate.mjs"]
    with (args.output / "migrate.log").open("w") as logs:
        result = subprocess.run(migrate_command, stdout=logs, stderr=logs, timeout=600)
    report["migration_exit_code"] = result.returncode
    save()  # Diagnostic failures must not hide the original migration result.
    report["after"] = fingerprints()
    changed = [table for table in columns if report["before"][table] != report["after"][table]]
    report["changed_tables"] = changed
    report["seed_and_journal_changes"] = sorted(set(changed) & SEED_TABLES)
    report["unexpected_data_changes"] = sorted(set(changed) - SEED_TABLES)
    report["original_data_preserved"] = not report["unexpected_data_changes"]
    report["preserved_historical_tables"] = sorted(set(columns) - SEED_TABLES)
    journal = sql(container, database, "select schemaname from pg_tables where tablename='schema_migrations'")
    if not re.fullmatch(r"\w+", journal):
        raise RuntimeError("migration journal has ambiguous schema")
    report["schema_version"] = int(sql(container, database, f'select max(version) from "{journal}".schema_migrations'))
    save()
    if result.returncode != 0 or not report["original_data_preserved"]:
        raise RuntimeError("candidate upgrade failed; isolated clone retained for diagnosis")
    with (args.output / "migrate-repeat.log").open("w") as logs:
        repeated = subprocess.run(migrate_command, stdout=logs, stderr=logs, timeout=600)
    report["repeat_migration_exit_code"] = repeated.returncode
    report["repeat_after"] = fingerprints()
    report["repeat_data_unchanged"] = report["after"] == report["repeat_after"]
    save()
    if repeated.returncode != 0 or not report["repeat_data_unchanged"]:
        raise RuntimeError("repeat migration changed existing data or failed")
    if report["schema_version"] >= 24:
        # Exercise the exact shipped CLI against real historical data. This
        # writes only the isolated clone and never starts an ML/API worker.
        # migrate_command ends with image,node,entry; replace only the entry.
        capture_command = migrate_command[:-1] + ["apps/api/dist/cli/history-preserve.mjs", "--capture"]
        before_capture = fingerprints()
        with (args.output / "history-capture.log").open("w") as logs:
            capture = subprocess.run(capture_command, stdout=logs, stderr=logs, timeout=600)
        report["history_capture_exit_code"] = capture.returncode
        report["history_capture_source_unchanged"] = fingerprints() == before_capture
        save()
        if capture.returncode or not report["history_capture_source_unchanged"]:
            raise RuntimeError("historical capture failed or modified original result tables")
        # Compare every archived result relation to the real source rows. No
        # document contents or file IDs are printed or exported in this report.
        query = """select count(*),count(*) filter (where
          s.sha256<>f.sha256 or s.ml_revision is distinct from f.ml_revision
          or s.engine is distinct from f.engine
          or s.source_run_id is distinct from f.pipeline_result_run_id
          or (s.payload_json->'file')::jsonb <> to_jsonb(f)-'parse_status'-'parse_attempts'-'parse_error'-'pipeline_run_id'
          or (s.payload_json->'file'->'pages_json')::jsonb is distinct from coalesce(f.pages_json::jsonb,'null'::jsonb)
          or (s.payload_json->'extractions')::jsonb <> coalesce((select jsonb_agg(e order by e.id) from inspector.extractions e where e.file_id=f.id),'[]'::jsonb)
          or (s.payload_json->'rooms')::jsonb <> coalesce((select jsonb_agg(r order by r.id) from inspector.rooms r where r.file_id=f.id),'[]'::jsonb)
          or (s.payload_json->'hidden_works')::jsonb <> coalesce((select jsonb_agg(h order by h.id) from inspector.hidden_works h where h.file_id=f.id),'[]'::jsonb)
          or (s.payload_json->'requisites')::jsonb <> coalesce((select jsonb_agg(q order by q.id) from inspector.requisites q where q.file_id=f.id),'[]'::jsonb)
          or (s.payload_json->'change_marks')::jsonb <> coalesce((select jsonb_agg(m order by m.id) from inspector.change_marks m where m.file_id=f.id),'[]'::jsonb)
          or s.payload_sha256<>encode(sha256(convert_to(s.payload_json::text,'UTF8')),'hex')
        ) from inspector.file_result_snapshots s join inspector.files f on f.id=s.file_id"""
        count, mismatch = map(int, sql(container, database, query).split('|'))
        expected = int(sql(container, database, """select count(*) from inspector.files f where
          pages_json is not null or engine is not null or ml_revision is not null or pipeline_result_run_id is not null
          or exists(select 1 from inspector.extractions where file_id=f.id)
          or exists(select 1 from inspector.rooms where file_id=f.id)
          or exists(select 1 from inspector.hidden_works where file_id=f.id)
          or exists(select 1 from inspector.requisites where file_id=f.id)
          or exists(select 1 from inspector.change_marks where file_id=f.id)"""))
        report["historical_baseline"] = {"snapshots": count, "eligible_files": expected, "mismatches": mismatch}
        save()
        if mismatch or count != expected:
            raise RuntimeError("historical baseline differs from source results or is incomplete")
        snapshot_digest = sql(container, database, "select md5(string_agg(id||payload_sha256||captured_at::text,'' order by id)) from inspector.file_result_snapshots")
        with (args.output / "history-capture-repeat.log").open("w") as logs:
            repeat_capture = subprocess.run(capture_command, stdout=logs, stderr=logs, timeout=600)
        report["history_capture_repeat_exit_code"] = repeat_capture.returncode
        report["history_capture_repeat_unchanged"] = snapshot_digest == sql(container, database,
            "select md5(string_agg(id||payload_sha256||captured_at::text,'' order by id)) from inspector.file_result_snapshots")
        report["history_capture_source_unchanged"] = fingerprints() == before_capture
        save()
        if repeat_capture.returncode or not report["history_capture_repeat_unchanged"] or not report["history_capture_source_unchanged"]:
            raise RuntimeError("repeat historical capture changed its baseline or source")
    if args.export:
        exported = args.output / "cpu-publish.dump"
        with exported.open("wb") as stream:
            subprocess.run(["docker", "exec", "-u", "postgres", container,
                            "pg_dump", "-Fc", "-d", database], stdout=stream, check=True, timeout=600)
        with exported.open("rb") as stream:
            export_sha = hashlib.file_digest(stream, "sha256").hexdigest()
        report["cpu_export"] = {"path": str(exported), "bytes": exported.stat().st_size, "sha256": export_sha}
        save()
    print(json.dumps({"migration_passed": True, "schema_version": report["schema_version"],
                      "original_data_preserved": True, "source_database_changed": False,
                      "preserved_historical_tables": len(report["preserved_historical_tables"]),
                      "repeat_data_unchanged": True,
                      "seed_and_journal_changes": report["seed_and_journal_changes"]}))


if __name__ == "__main__":
    main()
