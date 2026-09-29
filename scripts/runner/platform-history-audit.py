"""Read-only historical linkage audit; never invent pipeline processing events.

Private file-level inventory preserves recorded ML revisions and unknowns.
Only aggregate counts are printed. The database transaction is repeatable-read
and read-only; blob checks only stat original files.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--container", required=True)
    p.add_argument("--blobs", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", a.container):
        raise ValueError("invalid source container")
    os.umask(0o077)
    a.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    started = datetime.now(timezone.utc).isoformat()
    query = """
    begin isolation level repeatable read read only;
    select json_build_object(
      'files', (select coalesce(json_agg(row_to_json(f)), '[]'::json) from
        (select id, inspection_id, object_id, sha256, size, parse_status, engine,
                ml_revision, uploaded_at, to_jsonb(files)->>'pipeline_result_run_id' recorded_pipeline_run_id
         from inspector.files order by id) f),
      'relationships', json_build_object(
        'file_inspection_missing', (select count(*) from inspector.files f left join inspector.inspections i on i.id=f.inspection_id where i.id is null),
        'file_object_mismatch', (select count(*) from inspector.files f join inspector.inspections i on i.id=f.inspection_id where f.object_id is distinct from i.object_id),
        'extraction_file_missing', (select count(*) from inspector.extractions e left join inspector.files f on f.id=e.file_id where f.id is null),
        'check_inspection_missing', (select count(*) from inspector.checks c left join inspector.inspections i on i.id=c.inspection_id where i.id is null),
        'fragment_check_missing', (select count(*) from inspector.evidence_fragments e left join inspector.checks c on c.id=e.check_id where c.id is null),
        'fragment_file_missing', (select count(*) from inspector.evidence_fragments e left join inspector.files f on f.id=e.file_id where f.id is null),
        'fragment_sha_mismatch', (select count(*) from inspector.evidence_fragments e join inspector.files f on f.id=e.file_id where e.sha256 is not null and e.sha256<>f.sha256),
        'fragment_inspection_mismatch', (select count(*) from inspector.evidence_fragments e join inspector.files f on f.id=e.file_id join inspector.checks c on c.id=e.check_id where f.inspection_id<>c.inspection_id),
        'active_decision_check_missing', (select count(*) from inspector.decisions d left join inspector.checks c on c.id=d.check_id where c.id is null and not d.superseded),
        'protocol_inspection_missing', (select count(*) from inspector.protocols p left join inspector.inspections i on i.id=p.inspection_id where i.id is null)),
      'protocols', json_build_object(
        'total',(select count(*) from inspector.protocols),
        'missing_model_version',(select count(*) from inspector.protocols where model_version is null or model_version=''),
        'missing_dataset_version',(select count(*) from inspector.protocols where dataset_version is null or dataset_version=''),
        'missing_matrix_version',(select count(*) from inspector.protocols where matrix_version is null or matrix_version=''),
        'missing_input_manifest_hash',(select count(*) from inspector.protocols where input_manifest_hash is null or input_manifest_hash='')),
      'extractions',(select count(*) from inspector.extractions),
      'fragments',(select count(*) from inspector.evidence_fragments));
    commit;
    """
    result = json.loads(subprocess.check_output(["docker", "exec", "-u", "postgres", a.container,
                                                "psql", "-XqAt", "-d", "inspector", "-c", query], text=True))
    inventory = []
    counts = {"files": len(result["files"]), "invalid_sha": 0, "missing_original": 0,
              "original_size_mismatch": 0, "recorded_ml_revision": 0,
              "unknown_ml_revision": 0, "recorded_engine": 0}
    for f in result.pop("files"):
        valid_sha = bool(re.fullmatch(r"[0-9a-f]{64}", f["sha256"]))
        counts["invalid_sha"] += int(not valid_sha)
        original = a.blobs / f["sha256"] if valid_sha else None
        exists = original is not None and original.is_file()
        counts["missing_original"] += int(not exists)
        size_matches = exists and original.stat().st_size == f["size"]
        counts["original_size_mismatch"] += int(exists and not size_matches)
        counts["recorded_ml_revision"] += int(bool(f["ml_revision"]))
        counts["unknown_ml_revision"] += int(not f["ml_revision"])
        counts["recorded_engine"] += int(bool(f["engine"]))
        run = f.pop("recorded_pipeline_run_id")
        inventory.append({**f, "origin": "historical_database", "trace_status": "published_run_recorded" if run else "legacy_untraced",
                          "original_exists": exists, "original_size_matches": size_matches,
                          "pipeline_run_id": run, "job_id": None, "attempt_epoch": None,
                          "processing_started_at": None, "processing_finished_at": None})
    report = {"schema": "platform-history-audit/1", "source_container": a.container,
              "started_utc": started, "finished_utc": datetime.now(timezone.utc).isoformat(),
              "isolation": "repeatable read read only", "counts": counts, **result,
              "pipeline_ids_assigned": False, "source_changed": False,
              "file_inventory": "files.json", "blob_check": "existence and size; not a byte-hash verification"}
    (a.output / "files.json").write_text(json.dumps(inventory, indent=2))
    (a.output / "audit.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"counts": counts, "relationships": report["relationships"],
                      "protocols": report["protocols"], "source_changed": False}))


if __name__ == "__main__":
    main()
