import { randomUUID } from "node:crypto";
import type { DB } from "../db.ts";

/** Caller owns the publication transaction. Lock before reading old result rows.
 * Build/hash in PostgreSQL so a large legacy result is not copied into Node RAM.
 * A failed replacement rolls this snapshot back with the replacement itself.
 */
export async function preserveFileResult(db: DB, fileId: string): Promise<void> {
  if (!(await db.get("select id from files where id=$1 for update", [fileId]))) throw new Error("file missing before result preservation");
  await db.run(`with old_result as (
    select f.sha256, f.pipeline_result_run_id source_run_id, f.ml_revision, f.engine,
      json_build_object('schema','file-result-snapshot/1',
        -- Preserve source/revision/approval metadata too. These operational
        -- fields already describe the new attempt and must not impersonate
        -- the processing state that originally produced the archived result.
        'file', to_jsonb(f)-'parse_status'-'parse_attempts'-'parse_error'-'pipeline_run_id',
        'extractions',(select coalesce(json_agg(e order by e.id),'[]'::json) from extractions e where e.file_id=f.id),
        'rooms',(select coalesce(json_agg(r order by r.id),'[]'::json) from rooms r where r.file_id=f.id),
        'hidden_works',(select coalesce(json_agg(h order by h.id),'[]'::json) from hidden_works h where h.file_id=f.id),
        'requisites',(select coalesce(json_agg(q order by q.id),'[]'::json) from requisites q where q.file_id=f.id),
        'change_marks',(select coalesce(json_agg(m order by m.id),'[]'::json) from change_marks m where m.file_id=f.id)
      ) payload
    from files f where f.id=$2 and (
      f.pages_json is not null or f.engine is not null or f.ml_revision is not null or f.pipeline_result_run_id is not null
      or exists(select 1 from extractions where file_id=f.id)
      or exists(select 1 from rooms where file_id=f.id)
      or exists(select 1 from hidden_works where file_id=f.id)
      or exists(select 1 from requisites where file_id=f.id)
      or exists(select 1 from change_marks where file_id=f.id)
    )
  ) insert into file_result_snapshots(id,file_id,sha256,source_run_id,ml_revision,engine,payload_json,payload_sha256)
    select $1,$2,sha256,source_run_id,ml_revision,engine,payload,
      encode(sha256(convert_to(payload::text,'UTF8')),'hex') from old_result
    on conflict(file_id,payload_sha256) do nothing`, [randomUUID(), fileId]);
}

export async function listFileResultSnapshots(db: DB, fileId: string, limit: number, offset: number) {
  return db.all(`select id,file_id,sha256,source_run_id,ml_revision,engine,captured_at,payload_sha256,
    json_array_length(payload_json->'extractions') extractions,
    json_array_length(payload_json->'rooms') rooms,
    json_array_length(payload_json->'hidden_works') hidden_works,
    json_array_length(payload_json->'requisites') requisites,
    json_array_length(payload_json->'change_marks') change_marks
    from file_result_snapshots where file_id=$1 order by captured_at desc,id limit $2 offset $3`, [fileId, limit, offset]);
}

/** Bounded, resumable archival pass. Each capture is atomic; no processing is started. */
export async function preserveHistoricalResults(db: DB): Promise<{ visited: number; snapshots: number }> {
  let after: string | null = null;
  let visited = 0;
  while (true) {
    const files: Array<{ id: string }> = await db.all("select id from files where ($1::text is null or id>$1) order by id limit 100", [after]);
    if (!files.length) break;
    for (const file of files) {
      await db.tx(async (tx) => { await preserveFileResult(tx, file.id); });
      after = file.id;
      visited++;
    }
  }
  const count = await db.get<{ count: number }>("select count(*)::int count from file_result_snapshots");
  return { visited, snapshots: count!.count };
}
