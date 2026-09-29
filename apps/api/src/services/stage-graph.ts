// Runs inside commitStage's publication callback, after its artifact INSERT.
import { isDeepStrictEqual } from "node:util";
import type { DB } from "../db.ts";
import { nextPipelineStages, PipelineGraphError, type StageCheckpoint } from "../domain/pipeline-graph.ts";
import { PipelineReply, validatePipelineResult, type PipelineProgress } from "./pipeline-client.ts";
import { enqueueStage, type StageClaim } from "./stage-jobs.ts";
import type { MlResponse } from "./ml-client.ts";

const decoded = <T>(raw: unknown): T => typeof raw === "string" ? JSON.parse(raw) : raw as T;

/** Persist the frozen manifest/progress and atomically enqueue newly ready dependencies.
 * Returns a fully validated aggregate for the caller's SAME-transaction file publication.
 * The run lock taken by commitStage serializes simultaneous final-page completions.
 */
export async function advanceStageGraph(t: DB, claim: StageClaim, raw: unknown): Promise<MlResponse | null> {
  const reply = PipelineReply.parse(raw);
  const run = await t.get<any>("select * from pipeline_runs where id=$1", [claim.run_id]);
  const own = await t.get<any>(`select j.status,a.artifact_digest from stage_jobs j join stage_artifacts a on a.job_id=j.id
    where j.id=$1 and j.run_id=$2 and a.attempt_epoch=$3`, [claim.id, claim.run_id, claim.attempt_epoch]);
  if (!run || own?.status !== "SUCCEEDED" || own.artifact_digest !== reply.artifact ||
      reply.context.run_id !== claim.run_id || reply.context.sha256 !== run.sha256 ||
      !isDeepStrictEqual(decoded(run.context_json), reply.context) || reply.receipt.stage !== claim.stage ||
      reply.receipt.output_digest !== reply.artifact || reply.receipt.status !== "complete" || reply.receipt.reasons.length) {
    throw new PipelineGraphError("stage graph requires this attempt's committed, complete artifact");
  }
  const request = decoded<any>(claim.request_json);
  let plan: PipelineProgress;
  if (claim.stage === "preflight") {
    if (reply.receipt.region_id !== null || !isDeepStrictEqual(reply.receipt.input_digests,
      [reply.context.sha256, reply.context.request_fingerprint]) || request.run_id !== claim.run_id || request.request?.sha256 !== run.sha256) {
      throw new PipelineGraphError("preflight receipt differs from frozen request");
    }
    plan = reply;
    if (run.manifest_json && !isDeepStrictEqual(decoded(run.manifest_json), plan)) throw new PipelineGraphError("manifest cannot change");
    await t.run("update pipeline_runs set manifest_json=$1,status='RUNNING' where id=$2", [JSON.stringify(plan), claim.run_id]);
  } else {
    plan = PipelineReply.parse(decoded(run.manifest_json));
    const inputs = claim.stage === "parse" ? [plan.artifact] : request.inputs;
    if (!isDeepStrictEqual(request.context, plan.context) || request.plan !== plan.artifact ||
        reply.receipt.region_id !== (request.region_id ?? null) || !isDeepStrictEqual(reply.receipt.input_digests, inputs)) {
      throw new PipelineGraphError("stage receipt differs from frozen dependencies");
    }
  }
  const rows = await t.all<any>(`select j.stage,j.request_json,a.artifact_digest from stage_jobs j
    join stage_artifacts a on a.job_id=j.id and a.run_id=j.run_id and a.attempt_epoch=j.attempt_epoch
    where j.run_id=$1 and j.status='SUCCEEDED' and j.stage <> 'preflight'`, [claim.run_id]);
  const completed: StageCheckpoint[] = rows.map((row) => {
    const body = decoded<any>(row.request_json);
    if (!isDeepStrictEqual(body.context, plan.context) || body.plan !== plan.artifact) throw new PipelineGraphError("checkpoint belongs to another plan");
    return { stage: row.stage, regionId: body.region_id ?? null, digest: row.artifact_digest,
      inputs: row.stage === "parse" ? [body.plan] : body.inputs };
  });
  const next = nextPipelineStages({ runId: claim.run_id, digest: plan.artifact, regions: plan.regions.map((r) => r.id) }, completed);
  for (const job of next) await enqueueStage(t, claim.run_id, { logicalKey: job.logicalKey, stage: job.stage,
    request: { context: plan.context, plan: plan.artifact, inputs: job.inputs, region_id: job.regionId } });
  await t.run(`update pipeline_runs set progress_json=(progress_json::jsonb || $1::jsonb)::json where id=$2`,
    [JSON.stringify([{ at: new Date().toISOString(), receipt: reply.receipt }]), claim.run_id]);
  if (claim.stage !== "aggregate") return null;
  const ordered = [...plan.regions.map((r) => completed.find((c) => c.stage === "parse" && c.regionId === r.id)!),
    ...(["merge", "extract", "aggregate"] as const).map((stage) => completed.find((c) => c.stage === stage)!)];
  const receipts: PipelineProgress["receipt"][] = [plan.receipt, ...ordered.map((c) => ({ stage: c.stage,
    region_id: c.regionId, input_digests: c.inputs, output_digest: c.digest, status: "complete" as const, reasons: [], cached: false }))];
  const result = validatePipelineResult(plan, reply, receipts);
  await t.run("update pipeline_runs set trace_json=$1,result_json=$2 where id=$3",
    [JSON.stringify(reply.trace), JSON.stringify(result), claim.run_id]);
  return result;
}
