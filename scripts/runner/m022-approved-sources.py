"""Read-only historical DB metadata export using the authorized eval.w1_real catalog.

User-approved scope: ALT-79B, POL-17, LOS-3A only. Development archive authorized on 2026-09-29; never an independent acceptance set.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--output', default='/opt/w1-gate/eval/m022/approved-sources.json', type=Path)
    args = ap.parse_args()
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ml'))
    from eval import w1_real
    root = Path(__file__).resolve().parents[2]
    digest_file = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    override = w1_real.EVAL / 'objects.json'
    overrides = {'path': str(override), 'exists': override.exists(),
                 'sha256': digest_file(override) if override.exists() else None}
    resolved = w1_real.objects()
    allowed = ('ALT-79B', 'POL-17', 'LOS-3A')
    sources = []
    catalogs = []
    for obj in allowed:
        # Use the authorized catalog resolver, but refuse an external alias override.
        if resolved[obj] != w1_real.OBJECTS[obj]:
            raise ValueError('scope override differs from authorized defaults')
        archive = w1_real.OBJECTS[obj]['archive']
        [catalog] = [p for p in (w1_real.CORPUS / 'catalog').glob('*.jsonl')
                     if p.name.startswith(archive + '_')]
        digest = hashlib.sha256(catalog.read_bytes()).hexdigest()
        catalogs.append({'object_id': obj, 'path': str(catalog), 'sha256': digest})
        for row in w1_real.catalog_files(obj):
            assert re.fullmatch('[0-9a-f]{64}', row['sha256'])
            sources.append({'catalog_object_id': obj, 'sha256': row['sha256'],
                            'original_path': row['path'], 'catalog_sha256': digest})
    approval = {'authority': 'User-approved eval.w1_real ALT/POL/LOS catalog membership',
                'catalogs': catalogs, 'evaluation_role': 'development_archive',
                'parameter': 'M-022'}
    # Pin metadata across selection; refuse concurrent catalog/override changes.
    for item in catalogs:
        if digest_file(Path(item['path'])) != item['sha256']:
            raise ValueError('metadata changed during selection')
    if override.exists() != overrides['exists'] or (override.exists() and digest_file(override) != overrides['sha256']):
        raise ValueError('override changed during selection')
    cohort = {'status': 'approved', 'catalogs': catalogs, 'overrides': overrides,
              'catalog_authority': {'verified': True, 'resolved_objects': {k: resolved[k] for k in allowed},
                                    'rule': 'eval.w1_real.catalog_files; exact single catalog per archive'},
              'evaluation_role': 'development_archive',
              'authorization': {'source': 'user_instruction', 'date': '2026-09-29'},
              'rule_digests': {'ml/eval/w1_real.py': digest_file(root / 'ml/eval/w1_real.py')}}
    assert sources
    # Input is metadata only, captured in a private artifact, never printed.
    payload = json.dumps(sources, ensure_ascii=True).replace("'", "''")
    sql = """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='30s';
WITH allowed AS (
 SELECT * FROM jsonb_to_recordset('%s'::jsonb)
 AS a(catalog_object_id text,sha256 text,original_path text,catalog_sha256 text)
), records AS (
 SELECT a.catalog_object_id,a.sha256,a.original_path,a.catalog_sha256,
 f.object_id AS actual_object_id,f.id AS file_id,f.inspection_id,
 i.object_id AS inspection_object_id,f.doc_stage AS stage,f.discipline,
 f.revision,f.revision_role AS currentness,f.approval_status AS approval,
 f.predecessor_id,f.successor_id,f.parse_status,
 to_jsonb(f)->>'pipeline_run_id' AS stored_current_run_id,
 to_jsonb(f)->>'pipeline_result_run_id' AS stored_result_run_id,
 NULL::text AS historical_model_version,
 'unknown_unless_separately_stored'::text AS historical_model_provenance,
 (SELECT count(*) FROM inspector.extractions e WHERE e.file_id=f.id AND e.param_code='M-022') AS stored_m022_mentions,
 CASE WHEN f.id IS NULL THEN 'catalog_only_no_db_link' ELSE 'matched_sha_db_link' END AS link_status
 FROM allowed a LEFT JOIN inspector.files f ON f.sha256=a.sha256
 LEFT JOIN inspector.inspections i ON i.id=f.inspection_id
)
SELECT json_build_object('snapshot_utc',transaction_timestamp(),'source_db',
 'nadzorium-gpu-postgres-1/inspector/inspector','records',coalesce(json_agg(records),'[]'::json)) FROM records;
COMMIT;
""" % payload
    snapshot_started = datetime.now(timezone.utc).isoformat()
    response = subprocess.run(['docker','exec','-i','-u','postgres','nadzorium-gpu-postgres-1',
        'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-d','inspector'],
        input=sql.encode(),capture_output=True,timeout=45)
    if response.returncode:
        raise RuntimeError('read-only database export failed')
    result = json.loads(response.stdout)
    result['pg_snapshot'] = {'source': 'nadzorium-gpu-postgres-1/inspector',
        'started_at': snapshot_started, 'finished_at': datetime.now(timezone.utc).isoformat(),
        'isolation': 'repeatable read read only'}
    result.update(schema='m022-approved-sources.v1',parameter='M-022',
        exported_utc=datetime.now(timezone.utc).isoformat(),approval=approval,cohort=cohort,
        selection='all approved catalog files, including zero stored M-022 mentions',
        notes=['SHA match does not establish a DB object alias as catalog authority.',
               'No historical model or absent run ID is inferred from current software.',
               'Stored extraction count is system output, not independent ground truth.'])
    output = args.output.resolve()
    assert output.parent == Path('/opt/w1-gate/eval/m022')
    output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    output.parent.chmod(0o700)
    fd = os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(result,stream,ensure_ascii=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'status':'exported','records':len(result['records']),
                      'catalog_sources':len(sources),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(), 'path':str(output)}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Neither SQL diagnostics nor catalog data may escape to runner stdout.
        raise SystemExit('M022 manifest export refused; verify private approval and database schema') from None
