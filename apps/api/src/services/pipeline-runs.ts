import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DB } from "../db.ts";
import { config } from "../config.ts";
import { MlError, type MlRequest, type MlResponse } from "./ml-client.ts";
import { runPipeline, type PipelineRunContext } from "./pipeline-client.ts";
import { enqueueStage } from "./stage-jobs.ts";
import { assertPipelineSourceLock } from "./pipeline-source-pins.ts";

const decoded = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) : value as T;

/** Called inside the existing processing-start transaction; env changes cannot reroute a retry. */
export async function preparePipelineRun(db: DB, fileId: string, request?: MlRequest): Promise<boolean> {
  const file = await db.get<{ sha256: string; kind: string }>("select sha256, kind from files where id = $1", [fileId]);
  if (!file) throw new Error("file missing while preparing pipeline run");
  if (config.pipelineRoute !== "staged-v1" || !["pdf", "docx", "xml"].includes(file.kind)) {
    await db.run("update files set pipeline_run_id = null where id = $1", [fileId]);
    return false;
  }
  const durable = config.pipelineExecution === "durable";
  if (durable) {
    assertPipelineSourceLock();
    if (!request || request.sha256 !== file.sha256) throw new Error("durable run requires its frozen ML request");
  }
  const runId = randomUUID();
  await db.run(`insert into pipeline_runs(id, file_id, sha256, route, execution_mode, request_json, policy)
    values ($1,$2,$3,'staged-v1',$4,$5,$6)`, [runId, fileId, file.sha256, durable ? "durable" : "inline", durable ? JSON.stringify(request) : null, config.pipelinePolicy]);
  await db.run("update files set pipeline_run_id = $1 where id = $2", [runId, fileId]);
  if (durable) {
    await db.run("insert into pipeline_source_pins(run_id,sha256) values ($1,$2)", [runId, file.sha256]);
    await enqueueStage(db, runId, { logicalKey: createHash("sha256").update(JSON.stringify([runId, "preflight"])).digest("hex"),
      stage: "preflight", request: { run_id: runId, request, policy: config.pipelinePolicy } });
  }
  return durable;
}

export async function analyzePipeline(db: DB, fileId: string, runId: string, request: MlRequest): Promise<MlResponse> {
  const run = await db.get<any>("select * from pipeline_runs where id = $1 and file_id = $2", [runId, fileId]);
  if (!run || run.sha256 !== request.sha256 || run.route !== "staged-v1") throw new MlError(409, "Запуск не соответствует файлу");
  if (run.execution_mode !== "inline") throw new MlError(409, "Долговечный запуск исполняется координатором стадий");
  const frozen = run.context_json ? decoded<PipelineRunContext>(run.context_json) : null;
  try {
    if (run.request_json && !isDeepStrictEqual(decoded(run.request_json), JSON.parse(JSON.stringify(request)))) throw new MlError(409, "Параметры запуска изменились; требуется новый run");
    await db.run("update pipeline_runs set status = 'RUNNING', request_json = $1, error = null, finished_at = null where id = $2", [JSON.stringify(request), runId]);
    return await runPipeline(runId, request, async (reply) => {
      // Summaries per stage; full page text is stored once, in the final trace.
      const progress = { at: new Date().toISOString(), receipt: reply.receipt };
      await db.run(`update pipeline_runs set context_json = $1,
        progress_json = (progress_json::jsonb || $2::jsonb)::json,
        trace_json = coalesce($3::json, trace_json), result_json = coalesce($4::json, result_json) where id = $5`,
      [JSON.stringify(reply.context), JSON.stringify([progress]), reply.trace ? JSON.stringify(reply.trace) : null,
        reply.result ? JSON.stringify(reply.result) : null, runId]);
    }, frozen, run.policy);
  } catch (error: any) {
    await db.run("update pipeline_runs set status = 'FAILED', error = $1, finished_at = now() where id = $2", [String(error.message).slice(0, 2000), runId]);
    throw error;
  }
}

/** Same transaction as extraction publication. COMPLETE never precedes file/card data. */
export async function publishPipelineRun(db: DB, fileId: string, runId: string | null): Promise<void> {
  if (runId) {
    const ready = await db.get(`update pipeline_runs set status = 'COMPLETE', error = null, finished_at = now()
      where id = $1 and file_id = $2 and status = 'RUNNING' and result_json is not null
      and trace_json::jsonb->'completeness'->>'publishable' = 'true'
      and exists (select 1 from files where id = $2 and pipeline_run_id = $1)
      returning id`, [runId, fileId]);
    if (!ready) throw new MlError(409, "Запуск не готов к публикации или заменён новым");
  }
  await db.run("update files set pipeline_result_run_id = $1 where id = $2", [runId, fileId]);
}

export async function listPipelineRuns(db: DB, fileId: string, limit: number, offset: number) {
  const rows = await db.all(`select id, file_id, sha256, route, policy, status, error, created_at, finished_at,
    context_json::jsonb->>'configuration_fingerprint' configuration_fingerprint,
    trace_json::jsonb->'completeness' completeness, progress_json
    from pipeline_runs where file_id = $1 order by created_at desc, id limit $2 offset $3`, [fileId, limit, offset]);
  return rows.map((row) => ({ ...row,
    completeness: row.completeness == null ? null : decoded(row.completeness),
    progress_json: decoded(row.progress_json),
  }));
}

export async function pipelineTracePage(db: DB, fileId: string, runId: string, page: number) {
  // Filter inside PostgreSQL: multi-page OCR text never rides on the hot card response.
  const row = await db.get<any>(`select id, status, error, context_json, progress_json,
    trace_json::jsonb->'completeness' completeness,
    (select p from jsonb_array_elements(coalesce(trace_json::jsonb->'pages','[]'::jsonb)) p
      where (p->'region'->>'page')::int = $3 limit 1) page,
    (select coalesce(jsonb_agg(p), '[]'::jsonb) from jsonb_array_elements(coalesce(trace_json::jsonb->'pages','[]'::jsonb)) p
      where (p->'region'->>'page')::int = $3) regions,
    (select coalesce(jsonb_agg(w), '[]'::jsonb) from jsonb_array_elements(coalesce(trace_json::jsonb->'word_bindings','[]'::jsonb)) w
      where (w->>'page')::int = $3) word_bindings,
    (select coalesce(jsonb_agg(o), '[]'::jsonb) from jsonb_array_elements(coalesce(trace_json::jsonb->'reader_observations','[]'::jsonb)) o
      where exists (select 1 from jsonb_array_elements(coalesce(trace_json::jsonb->'pages','[]'::jsonb)) p
        where (p->'region'->>'page')::int = $3 and p->'region'->>'id' = o->>'region_id')) reader_observations
    from pipeline_runs where id = $1 and file_id = $2`, [runId, fileId, page]);
  if (!row) return null;
  return { ...row, context: row.context_json ? decoded(row.context_json) : null,
    context_json: undefined, progress: decoded(row.progress_json), progress_json: undefined,
    reader_observations: decoded(row.reader_observations), regions: decoded(row.regions), word_bindings: decoded(row.word_bindings), completeness: row.completeness ? decoded(row.completeness) : null, page: row.page ? decoded(row.page) : null };
}
