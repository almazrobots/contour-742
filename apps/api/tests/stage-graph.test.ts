import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DB } from "../src/db.ts";
import { claimStage, commitStage, enqueueStage } from "../src/services/stage-jobs.ts";
import { advanceStageGraph } from "../src/services/stage-graph.ts";
import type { PipelineProgress } from "../src/services/pipeline-client.ts";
import { publishPipelineRun } from "../src/services/pipeline-runs.ts";

let db: DB;
const h = (n: number) => n.toString(16).padStart(64, "0");
beforeAll(async () => {
  process.env.INSPECTOR_DEMO_PASSWORD = "test-graph";
  db = await (await import("../src/db.ts")).openDb("memory");
  await db.run("insert into objects(id,name,created_at) values ('O-GRAPH','Synthetic graph',now())");
  await db.run("insert into inspections(id,object_id,status,created_at,updated_at) values ('I-GRAPH','O-GRAPH','PARSING',now(),now())");
});
afterAll(async () => { await db?.close(); });

async function graphFixture() {
  const file = randomUUID(), run = randomUUID();
  await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,uploaded_at)
    values ($1,'I-GRAPH','O-GRAPH',$1,'synthetic.pdf',$2,100,'pdf','PD','GRAPH','1',now())`, [file, h(1)]);
  await db.run(`insert into pipeline_runs(id,file_id,sha256,route,execution_mode)
    values ($1,$2,$3,'staged-v1','durable')`, [run, file, h(1)]);
  await db.run("update files set pipeline_run_id=$1 where id=$2", [run, file]);
  await db.run("update files set parse_status='PARSING' where id=$1", [file]);
  const context: PipelineProgress["context"] = { schema_version: "pipeline.v1", run_id: run, sha256: h(1),
    configuration: {}, configuration_fingerprint: h(2), request_fingerprint: h(3),
    policy: { name: "legacy-compatible-v1", required_ocr_engines: [], require_judge: false, coverage: "whole-page-legacy" } };
  const regions: PipelineProgress["regions"] = [1, 2].map((page) => ({ id: `region:${h(page + 10)}`, page_id: `page:${h(page + 20)}`,
    page, bbox: [0, 0, 1, 1], geometry: null }));
  const preflight = await db.tx((t) => enqueueStage(t, run, { logicalKey: h(4), stage: "preflight",
    request: { run_id: run, request: { sha256: h(1), params: [] } } }));
  const receipts: PipelineProgress["receipt"][] = [];
  const persist = async (job: string, output: string, inputs: string[], region: string | null = null, fail = false) => {
    const claim = (await claimStage(db, job, "coordinator"))!;
    const reply: PipelineProgress = { context, artifact: output, regions: claim.stage === "preflight" ? regions : [],
      result: null, trace: null, receipt: { stage: claim.stage as PipelineProgress["receipt"]["stage"], region_id: region,
        input_digests: inputs, output_digest: output, status: "complete", reasons: [], cached: false } };
    const artifact = { artifactDigest: output, blobSha256: h(50), byteLength: 100,
      schemaVersion: "pipeline.v1" as const, configurationFingerprint: h(2) };
    await commitStage(db, claim, artifact, [], async (t) => {
      await advanceStageGraph(t, claim, reply);
      if (fail) throw Error("crash before commit");
    }, context);
    receipts.push(reply.receipt);
  };
  return { file, run, context, regions, preflight, persist, receipts };
}
const decode = <T = any>(raw: unknown): T => typeof raw === "string" ? JSON.parse(raw) : raw as T;

it("committed pages advance the durable graph once, preserving order across recovery", async () => {
  const { run, regions, preflight, persist } = await graphFixture();
  await persist(preflight, h(5), [h(1), h(3)]);
  const pages = await db.all<any>("select id,request_json from stage_jobs where run_id=$1 and stage='parse' order by request_json::jsonb->>'region_id'", [run]);
  expect(pages).toHaveLength(2);
  await persist(pages[1].id, h(7), [h(5)], regions[1].id);
  expect(await db.all("select id from stage_jobs where run_id=$1 and stage='merge'", [run])).toHaveLength(0);
  // A coordinator restart/duplicate delivery only finds the remaining READY page.
  expect(await claimStage(db, pages[1].id, "restarted")).toBeNull();
  await persist(pages[0].id, h(6), [h(5)], regions[0].id);
  const merge = await db.get<any>("select id,request_json from stage_jobs where run_id=$1 and stage='merge'", [run]);
  expect(decode(merge.request_json).inputs).toEqual([h(6), h(7)]);
  await expect(persist(merge.id, h(8), [h(6), h(7)], null, true)).rejects.toThrow("crash before commit");
  expect(await db.all("select id from stage_jobs where run_id=$1 and stage='extract'", [run])).toHaveLength(0);
  expect(await db.all("select * from stage_artifacts where job_id=$1", [merge.id])).toHaveLength(0);
  expect(await db.all("select * from stage_artifacts where run_id=$1", [run])).toHaveLength(3);
});

async function readyAggregate() {
  const f = await graphFixture();
  await f.persist(f.preflight, h(5), [h(1), h(3)]);
  const pages = await db.all<any>("select id from stage_jobs where run_id=$1 and stage='parse' order by request_json::jsonb->>'region_id'", [f.run]);
  for (const [index, page] of pages.entries()) await f.persist(page.id, h(6 + index), [h(5)], f.regions[index].id);
  const merge = (await db.get<{ id: string }>("select id from stage_jobs where run_id=$1 and stage='merge'", [f.run]))!;
  await f.persist(merge.id, h(8), [h(6), h(7)]);
  const extract = (await db.get<{ id: string }>("select id from stage_jobs where run_id=$1 and stage='extract'", [f.run]))!;
  await f.persist(extract.id, h(9), [h(8)]);
  const aggregate = (await db.get<{ id: string }>("select id from stage_jobs where run_id=$1 and stage='aggregate'", [f.run]))!;
  const claim = (await claimStage(db, aggregate.id, "aggregate-worker"))!;
  const receipt: PipelineProgress["receipt"] = { stage: "aggregate", region_id: null, input_digests: [h(9)],
    output_digest: h(10), status: "complete", reasons: [], cached: false };
  const reply: PipelineProgress = { context: structuredClone(f.context), artifact: h(10), receipt, regions: [],
    result: { sha256: h(1), kind: "pdf", engine: "synthetic", ml_revision: "test", cached: false,
      pages: f.regions.map((region) => ({ page: region.page, width: 600, height: 300, rotation: 0,
        source: "text", quality: "OK", ocr_confidence: null, lines: 1 })), extractions: [], facts: [], rooms: [] },
    trace: { context: structuredClone(f.context), receipts: [...f.receipts, receipt],
      completeness: { coverage_scope: "whole-page-legacy", planned_regions: 2, completed_regions: 2,
        mandatory_stages_complete: true, publishable: true, reasons: [] },
      pages: f.regions.map((region, index) => ({ region, transcription_digest: h(60 + index), source: "text", quality: "OK",
        engines: [], agreement: null, execution_failures: [], lines: [{ id: `line:${h(70 + index)}`, region_id: region.id,
          text: `Synthetic page ${region.page}`, tokens: [] }] })) } };
  const artifact = { artifactDigest: h(10), blobSha256: h(50), byteLength: 100,
    schemaVersion: "pipeline.v1" as const, configurationFingerprint: h(2) };
  let publicationCalls = 0;
  const publish = async (failAfterPublication = false) => commitStage(db, claim, artifact, [], async (t) => {
    const result = await advanceStageGraph(t, claim, reply);
    expect(result).toEqual(reply.result);
    publicationCalls++;
    await publishPipelineRun(t, f.file, f.run);
    await t.run("update files set parse_status='DONE' where id=$1", [f.file]);
    if (failAfterPublication) throw Error("publication callback crashed after file writes");
  }, f.context);
  return { ...f, claim, reply, publish, publicationCalls: () => publicationCalls };
}

it("merge/extract/aggregate publish the validated result and file in one transaction", async () => {
  const f = await readyAggregate();
  expect((await db.get("select status,result_json,trace_json from pipeline_runs where id=$1", [f.run])))
    .toEqual({ status: "RUNNING", result_json: null, trace_json: null });
  await f.publish();
  const run = (await db.get("select status,result_json,trace_json,progress_json from pipeline_runs where id=$1", [f.run]))!;
  expect(run.status).toBe("COMPLETE");
  expect(decode(run.result_json)).toEqual(f.reply.result);
  expect(decode(run.trace_json)).toEqual(f.reply.trace);
  expect(decode<any[]>(run.progress_json).map((item) => item.receipt.stage))
    .toEqual(["preflight", "parse", "parse", "merge", "extract", "aggregate"]);
  expect(await db.get("select parse_status,pipeline_result_run_id from files where id=$1", [f.file]))
    .toEqual({ parse_status: "DONE", pipeline_result_run_id: f.run });
  expect(await db.all("select status from stage_jobs where run_id=$1", [f.run]))
    .toEqual(Array.from({ length: 6 }, () => ({ status: "SUCCEEDED" })));
  expect(await db.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(6);
  expect(await db.all("select o.id from pipeline_outbox o join stage_jobs j on j.id=o.job_id where j.run_id=$1", [f.run])).toHaveLength(6);
  expect(await claimStage(db, f.claim.id, "duplicate-after-publication")).toBeNull();
  expect(f.publicationCalls()).toBe(1);
});

async function expectAggregateUnpublished(f: Awaited<ReturnType<typeof readyAggregate>>) {
  const run = (await db.get("select status,result_json,trace_json,progress_json from pipeline_runs where id=$1", [f.run]))!;
  expect(run.status).toBe("RUNNING");
  expect(run.result_json).toBeNull();
  expect(run.trace_json).toBeNull();
  expect(decode<any[]>(run.progress_json)).toHaveLength(5);
  expect(await db.get("select parse_status,pipeline_result_run_id from files where id=$1", [f.file]))
    .toEqual({ parse_status: "PARSING", pipeline_result_run_id: null });
  expect(await db.get("select status from stage_jobs where id=$1", [f.claim.id])).toEqual({ status: "RUNNING" });
  expect(await db.get("select status from job_attempts where job_id=$1 and attempt_epoch=$2", [f.claim.id, f.claim.attempt_epoch]))
    .toEqual({ status: "RUNNING" });
  expect(await db.all("select * from stage_artifacts where job_id=$1", [f.claim.id])).toHaveLength(0);
  expect(await db.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(5);
  expect(await db.all("select o.id from pipeline_outbox o join stage_jobs j on j.id=o.job_id where j.run_id=$1", [f.run])).toHaveLength(6);
}

it("failure after result and file publication rolls back the entire aggregate, then the same owner can commit", async () => {
  const f = await readyAggregate();
  await expect(f.publish(true)).rejects.toThrow("publication callback crashed after file writes");
  expect(f.publicationCalls()).toBe(1);
  await expectAggregateUnpublished(f);
  // The transaction rolled back; no ML rerun or new attempt is required to retry the commit.
  await f.publish();
  expect((await db.get("select status from pipeline_runs where id=$1", [f.run]))?.status).toBe("COMPLETE");
  expect(await db.all("select * from job_attempts where job_id=$1", [f.claim.id])).toHaveLength(1);
});

it.each(["incomplete", "foreign-trace", "foreign-receipt", "missing-page"] as const)(
  "invalid aggregate %s rolls back without entering the file publication callback", async (damage) => {
    const f = await readyAggregate();
    const trace = f.reply.trace!;
    if (damage === "incomplete") {
      trace.completeness.publishable = false;
      trace.completeness.reasons = ["missing_required_stage"];
    }
    if (damage === "foreign-trace") trace.context.run_id = randomUUID();
    if (damage === "foreign-receipt") trace.receipts[3].output_digest = h(99);
    if (damage === "missing-page") trace.pages.pop();
    await expect(f.publish()).rejects.toThrow();
    expect(f.publicationCalls()).toBe(0);
    await expectAggregateUnpublished(f);
  });
