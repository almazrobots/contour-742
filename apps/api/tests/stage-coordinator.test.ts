import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DB } from "../src/db.ts";
import { config } from "../src/config.ts";
import { BlobIntegrityError, BlobStoreUnavailable, FsBlobStore } from "../src/services/blobstore.ts";
import { StageArtifactStore } from "../src/services/stage-artifacts.ts";
import { StageCoordinator } from "../src/services/stage-coordinator.ts";
import { MlError } from "../src/services/ml-client.ts";
import { enqueueStage, type StageClaim } from "../src/services/stage-jobs.ts";
import { publishPipelineRun } from "../src/services/pipeline-runs.ts";
import { withPipelineSourceLock } from "../src/services/pipeline-source-pins.ts";
import type { PipelineProgress } from "../src/services/pipeline-client.ts";
import type { StageExecutionSnapshot } from "../src/services/stage-execution-client.ts";

const h = (n: number) => n.toString(16).padStart(64, "0");
let db: DB, dir: string;
const previous = { blobDir: config.blobDir, workDir: config.blobAtRest.workDir };
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "stage-coordinator-"));
  config.blobDir = dir;
  config.blobAtRest.workDir = null;
  process.env.INSPECTOR_DEMO_PASSWORD = "synthetic-coordinator";
  db = await (await import("../src/db.ts")).openDb("memory");
  await db.run("insert into objects(id,name,created_at) values ('O-COORD','Synthetic coordinator',now())");
  await db.run("insert into inspections(id,object_id,status,created_at,updated_at) values ('I-COORD','O-COORD','PARSING',now(),now())");
});
afterEach(async () => {
  await db?.close();
  config.blobDir = previous.blobDir;
  config.blobAtRest.workDir = previous.workDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const bytes = Buffer.from("synthetic source, no real corpus");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const file = randomUUID(), run = randomUUID();
  const blobs = new FsBlobStore(dir);
  await blobs.put(sha, bytes);
  await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,uploaded_at)
    values ($1,'I-COORD','O-COORD',$1,'synthetic.pdf',$2,$3,'pdf','PD','COORD','1',now())`, [file, sha, bytes.length]);
  const preflight = await withPipelineSourceLock(() => db.tx(async (t) => {
    await t.run(`insert into pipeline_runs(id,file_id,sha256,route,execution_mode) values ($1,$2,$3,'staged-v1','durable')`, [run, file, sha]);
    await t.run("update files set pipeline_run_id=$1 where id=$2", [run, file]);
    await t.run("insert into pipeline_source_pins(run_id,sha256) values ($1,$2)", [run, sha]);
    return enqueueStage(t, run, { logicalKey: h(1), stage: "preflight", request: { run_id: run, request: { sha256: sha, params: [] } } });
  }));
  const context: PipelineProgress["context"] = { schema_version: "pipeline.v1", run_id: run, sha256: sha,
    configuration: {}, configuration_fingerprint: h(2), request_fingerprint: h(3),
    policy: { name: "legacy-compatible-v1", required_ocr_engines: [], require_judge: false, coverage: "whole-page-legacy" } };
  const region: PipelineProgress["regions"][number] = { id: `region:${h(4)}`, page_id: `page:${h(5)}`, page: 1, bbox: [0, 0, 1, 1], geometry: null };
  const replies = new Map<string, PipelineProgress>();
  const receipts: PipelineProgress["receipt"][] = [];
  const archived = new Set<string>();
  function done(claim: StageClaim): StageExecutionSnapshot {
    let reply = replies.get(claim.id);
    if (!reply) {
      const body = JSON.parse(claim.request_json);
      const output = h(10 + ["preflight", "parse", "merge", "extract", "aggregate"].indexOf(claim.stage));
      const receipt: PipelineProgress["receipt"] = { stage: claim.stage as PipelineProgress["receipt"]["stage"],
        region_id: body.region_id ?? null, input_digests: claim.stage === "preflight" ? [sha, h(3)] : claim.stage === "parse" ? [body.plan] : body.inputs,
        output_digest: output, status: "complete", reasons: [], cached: false };
      receipts.push(receipt);
      reply = { context, artifact: output, receipt, regions: claim.stage === "preflight" ? [region] : [], result: null, trace: null };
      if (claim.stage === "aggregate") {
        reply.result = { sha256: sha, kind: "pdf", engine: "synthetic", ml_revision: null, cached: false,
          pages: [{ page: 1, width: 600, height: 300, rotation: 0, source: "text", quality: "OK", ocr_confidence: null, lines: 0 }],
          extractions: [], facts: [], rooms: [] };
        reply.trace = { context, receipts: [...receipts], pages: [{ region, transcription_digest: h(20), source: "text", quality: "OK",
          engines: [], agreement: null, execution_failures: [], lines: [] }], completeness: { coverage_scope: "whole-page-legacy",
          planned_regions: 1, completed_regions: 1, mandatory_stages_complete: true, publishable: true, reasons: [] } };
      }
      replies.set(claim.id, reply);
    }
    return { job_id: claim.id, epoch: claim.attempt_epoch, status: "DONE", request_digest: h(30), reply,
      reason: null, requires_remote_quiescence: false };
  }
  const execution = { start: vi.fn(async (claim: StageClaim) => done(claim)), probe: vi.fn(async (claim: StageClaim) => done(claim)),
    cancelUnstarted: vi.fn(async (claim: StageClaim): Promise<StageExecutionSnapshot> => ({ job_id: claim.id, epoch: claim.attempt_epoch,
      status: "CANCELLED", request_digest: h(30), reply: null, reason: "sealed_unstarted", requires_remote_quiescence: false })) };
  const artifacts = { persist: vi.fn(async (reply: PipelineProgress) => {
    archived.add(reply.artifact);
    return { artifactDigest: reply.artifact, blobSha256: h(40), byteLength: 100,
      schemaVersion: "pipeline.v1" as const, configurationFingerprint: h(2) };
  }), restore: vi.fn(async (record: { artifactDigest: string }) => {
    if (!archived.has(record.artifactDigest)) throw Error("missing synthetic archive");
  }) };
  const publish = vi.fn(async (t: DB, fileId: string, runId: string) => {
    await publishPipelineRun(t, fileId, runId);
    await t.run("update files set parse_status='DONE' where id=$1", [fileId]);
  });
  const settled = vi.fn(async (_inspectionId: string) => undefined);
  const canRetry = vi.fn(async (_claim: StageClaim, _snapshot: StageExecutionSnapshot) => false);
  const report = vi.fn();
  const coordinator = new StageCoordinator({ db, blobs, execution, artifacts, publish, settled, canRetry, report });
  return { preflight, run, file, coordinator, execution, artifacts, publish, settled, canRetry, report, done };
}

const state = async (job: string) => db.get("select status,attempt_epoch from stage_jobs where id=$1", [job]);

it("handles the full graph, hydrates committed dependencies and publishes atomically before releasing pins", async () => {
  const f = await fixture();
  for (let count = 0; count < 5; count++) {
    const ready = await db.get<{ id: string }>("select id from stage_jobs where run_id=$1 and status='READY'", [f.run]);
    expect(ready).toBeDefined();
    await f.coordinator.handle(ready!.id);
  }
  expect(f.report).not.toHaveBeenCalled();
  expect(f.execution.start.mock.calls.map(([claim]) => claim.stage)).toEqual(["preflight", "parse", "merge", "extract", "aggregate"]);
  expect(f.artifacts.restore).toHaveBeenCalledTimes(7);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.settled).toHaveBeenCalledExactlyOnceWith("I-COORD");
  expect((await db.get("select status from pipeline_runs where id=$1", [f.run]))?.status).toBe("COMPLETE");
  expect(await db.get("select parse_status,pipeline_result_run_id from files where id=$1", [f.file]))
    .toEqual({ parse_status: "DONE", pipeline_result_run_id: f.run });
  expect((await db.get("select released_at from pipeline_source_pins where run_id=$1", [f.run]))?.released_at).not.toBeNull();
  expect(await db.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(5);
  await f.coordinator.handle(f.preflight);
  expect(f.execution.start).toHaveBeenCalledTimes(5);
});

it("HTTP timeout becomes RECOVERING; probe DONE adopts the same epoch without a second execution", async () => {
  const f = await fixture();
  f.execution.start.mockImplementationOnce(async (claim) => { f.done(claim); throw Error("HTTP timed out after ML completed"); });
  await f.coordinator.handle(f.preflight);
  expect(await state(f.preflight)).toEqual({ status: "RECOVERING", attempt_epoch: 1 });
  expect(await db.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(0);
  await f.coordinator.reconcile();
  expect(await state(f.preflight)).toEqual({ status: "SUCCEEDED", attempt_epoch: 1 });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(f.execution.probe).toHaveBeenCalledTimes(1);
  expect(f.execution.cancelUnstarted).not.toHaveBeenCalled();
  expect(await db.all("select * from job_attempts where job_id=$1", [f.preflight])).toHaveLength(1);
  expect(await db.all("select * from stage_jobs where run_id=$1 and stage='parse'", [f.run])).toHaveLength(1);
});

it("ABSENT followed by cancel racing with RUNNING never grants a new attempt", async () => {
  const f = await fixture();
  f.execution.start.mockRejectedValueOnce(Error("unknown transport outcome"));
  f.execution.probe.mockImplementation(async (claim) => ({ job_id: claim.id, epoch: claim.attempt_epoch,
    status: "ABSENT", request_digest: null, reply: null, reason: null, requires_remote_quiescence: false }));
  f.execution.cancelUnstarted.mockImplementation(async (claim) => ({ job_id: claim.id, epoch: claim.attempt_epoch,
    status: "RUNNING", request_digest: h(30), reply: null, reason: null, requires_remote_quiescence: true }));
  await f.coordinator.handle(f.preflight);
  await f.coordinator.reconcile();
  await f.coordinator.handle(f.preflight);
  expect(await state(f.preflight)).toEqual({ status: "RECOVERING", attempt_epoch: 1 });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(f.execution.cancelUnstarted).toHaveBeenCalledTimes(1);
  expect(f.canRetry).not.toHaveBeenCalled();
});

it.each(["RUNNING", "INTERRUPTED"] as const)("%s stays RECOVERING without evidence that remote work stopped", async (status) => {
  const f = await fixture();
  f.execution.start.mockRejectedValueOnce(Error("HTTP result unknown"));
  f.execution.probe.mockImplementation(async (claim): Promise<StageExecutionSnapshot> => status === "RUNNING"
    ? { job_id: claim.id, epoch: claim.attempt_epoch, status, request_digest: h(30), reply: null, reason: null, requires_remote_quiescence: true }
    : { job_id: claim.id, epoch: claim.attempt_epoch, status, request_digest: h(30), reply: null, reason: "owner_disappeared", requires_remote_quiescence: true });
  await f.coordinator.handle(f.preflight);
  await f.coordinator.reconcile();
  expect(await state(f.preflight)).toEqual({ status: "RECOVERING", attempt_epoch: 1 });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(f.execution.cancelUnstarted).not.toHaveBeenCalled();
  expect(f.canRetry).toHaveBeenCalledTimes(status === "INTERRUPTED" ? 1 : 0);
  expect((await db.get("select released_at from pipeline_source_pins where run_id=$1", [f.run]))?.released_at).toBeNull();
});

it("sealed CANCELLED permits a bounded retry, then diagnoses exhaustion and releases the pin", async () => {
  const f = await fixture();
  await db.run("update stage_jobs set max_attempts=2 where id=$1", [f.preflight]);
  f.execution.start.mockRejectedValue(Error("request never reached ML"));
  f.execution.probe.mockImplementation(async (claim) => ({ job_id: claim.id, epoch: claim.attempt_epoch,
    status: "ABSENT", request_digest: null, reply: null, reason: null, requires_remote_quiescence: false }));
  await f.coordinator.handle(f.preflight);
  await f.coordinator.reconcile();
  expect(await state(f.preflight)).toEqual({ status: "READY", attempt_epoch: 1 });
  expect((await db.get("select status from job_attempts where job_id=$1 and attempt_epoch=1", [f.preflight]))?.status).toBe("STOPPED");
  // Move only this synthetic job's retry deadline; don't sleep or alter coordinator timers.
  await db.run("update stage_jobs set not_before=clock_timestamp()-interval '1 second' where id=$1", [f.preflight]);
  await f.coordinator.handle(f.preflight);
  await f.coordinator.reconcile();
  expect(await state(f.preflight)).toEqual({ status: "FAILED", attempt_epoch: 2 });
  expect(f.execution.start).toHaveBeenCalledTimes(2);
  expect(f.execution.cancelUnstarted).toHaveBeenCalledTimes(2);
  expect(f.canRetry).not.toHaveBeenCalled();
  expect((await db.get("select error from stage_jobs where id=$1", [f.preflight]))?.error).toContain("attempts exhausted");
  expect((await db.get("select status from pipeline_runs where id=$1", [f.run]))?.status).toBe("FAILED");
  expect((await db.get("select released_at from pipeline_source_pins where run_id=$1", [f.run]))?.released_at).not.toBeNull();
  expect(await db.all("select * from pipeline_outbox where job_id=$1", [f.preflight])).toHaveLength(2);
  expect(f.settled).toHaveBeenCalledExactlyOnceWith("I-COORD");
});

async function runUntilAggregate(f: Awaited<ReturnType<typeof fixture>>) {
  for (let count = 0; count < 4; count++) {
    const ready = (await db.get<{ id: string }>("select id from stage_jobs where run_id=$1 and status='READY'", [f.run]))!;
    await f.coordinator.handle(ready.id);
  }
  return (await db.get<{ id: string }>("select id from stage_jobs where run_id=$1 and stage='aggregate'", [f.run]))!.id;
}

it("publication transaction failure rolls back file/result/artifact and recovery commits without rerunning ML", async () => {
  const f = await fixture();
  const aggregate = await runUntilAggregate(f);
  f.publish.mockImplementationOnce(async (t, fileId, runId) => {
    await publishPipelineRun(t, fileId, runId);
    await t.run("update files set parse_status='DONE' where id=$1", [fileId]);
    throw Error("DB publication callback failed after writes");
  });
  await f.coordinator.handle(aggregate);
  expect(await state(aggregate)).toEqual({ status: "RECOVERING", attempt_epoch: 1 });
  expect(await db.get("select status,result_json,trace_json from pipeline_runs where id=$1", [f.run]))
    .toEqual({ status: "RUNNING", result_json: null, trace_json: null });
  expect(await db.get("select parse_status,pipeline_result_run_id from files where id=$1", [f.file]))
    .toEqual({ parse_status: "PARSING", pipeline_result_run_id: null });
  expect(await db.all("select * from stage_artifacts where job_id=$1", [aggregate])).toHaveLength(0);
  expect((await db.get("select released_at from pipeline_source_pins where run_id=$1", [f.run]))?.released_at).toBeNull();
  expect(f.settled).not.toHaveBeenCalled();
  await f.coordinator.reconcile();
  expect(await state(aggregate)).toEqual({ status: "SUCCEEDED", attempt_epoch: 1 });
  expect(f.execution.start).toHaveBeenCalledTimes(5);
  expect(f.publish).toHaveBeenCalledTimes(2);
  expect(f.settled).toHaveBeenCalledExactlyOnceWith("I-COORD");
  expect((await db.get("select status from pipeline_runs where id=$1", [f.run]))?.status).toBe("COMPLETE");
});

it("foreign aggregate result is diagnosed FAILED and never publishes SUCCESS or file data", async () => {
  const f = await fixture();
  const aggregate = await runUntilAggregate(f);
  f.execution.start.mockImplementationOnce(async (claim) => {
    const snapshot = f.done(claim);
    if (snapshot.status !== "DONE" || !snapshot.reply.result) throw Error("invalid test fixture");
    snapshot.reply.result.sha256 = h(99);
    return snapshot;
  });
  await f.coordinator.handle(aggregate);
  expect(await state(aggregate)).toEqual({ status: "FAILED", attempt_epoch: 1 });
  expect(await db.get("select status,result_json,trace_json from pipeline_runs where id=$1", [f.run]))
    .toEqual({ status: "FAILED", result_json: null, trace_json: null });
  expect((await db.get("select pipeline_result_run_id from files where id=$1", [f.file]))?.pipeline_result_run_id).toBeNull();
  expect(await db.all("select * from stage_artifacts where job_id=$1", [aggregate])).toHaveLength(0);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.settled).toHaveBeenCalledExactlyOnceWith("I-COORD");
  expect((await db.get("select released_at from pipeline_source_pins where run_id=$1", [f.run]))?.released_at).not.toBeNull();
});


it.each(["missing", "corrupt", "oversized"])("diagnoses %s committed dependency without rerunning completed ML", async (damage) => {
  const f = await fixture();
  let exported: PipelineProgress;
  const store = new StageArtifactStore(new FsBlobStore(dir), async () => ({
    context: exported.context, reference: exported.artifact, stage: exported.receipt.stage,
    artifact: { context: exported.context, stage: exported.receipt.stage, region_id: exported.receipt.region_id,
      inputs: exported.receipt.input_digests, payload: { synthetic: true }, receipts: [] },
  }));
  f.artifacts.persist.mockImplementation(async (reply) => { exported = reply; return store.persist(reply); });
  await f.coordinator.handle(f.preflight);
  const committed = await db.all<{ blob_sha256: string }>("select * from stage_artifacts where run_id=$1", [f.run]);
  const ready = await db.get<{ id: string }>("select id from stage_jobs where run_id=$1 and stage='parse'", [f.run]);
  if (damage === "missing") rmSync(join(dir, committed[0].blob_sha256));
  else if (damage === "corrupt") writeFileSync(join(dir, committed[0].blob_sha256), "damaged archive");
  f.artifacts.restore.mockImplementation(async (record) => {
    if (damage === "oversized") throw new MlError(413, "request exceeds bounded spool");
    const descriptor = await db.get<any>("select * from stage_artifacts where artifact_digest=$1", [record.artifactDigest]);
    const reply = f.done(f.execution.start.mock.calls[0][0]);
    if (reply.status !== "DONE") throw Error("expected committed reply");
    await store.restore({ artifactDigest: descriptor.artifact_digest, blobSha256: descriptor.blob_sha256,
      byteLength: Number(descriptor.byte_length), schemaVersion: descriptor.schema_version,
      configurationFingerprint: descriptor.configuration_fingerprint }, reply.reply.context, "preflight");
  });
  await f.coordinator.handle(ready!.id);
  expect(await state(ready!.id)).toEqual({ status: "FAILED", attempt_epoch: 1 });
  expect(await state(f.preflight)).toEqual({ status: "SUCCEEDED", attempt_epoch: 1 });
  expect(await db.all("select * from stage_artifacts where run_id=$1", [f.run])).toEqual(committed);
  expect((await db.get("select status from pipeline_runs where id=$1", [f.run]))?.status).toBe("FAILED");
  expect((await db.get("select released_at from pipeline_source_pins where run_id=$1", [f.run]))?.released_at).not.toBeNull();
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(f.publish).not.toHaveBeenCalled();
  await f.coordinator.reconcile();
  expect(f.execution.probe).not.toHaveBeenCalled();
});

it("corrupt persisted response is diagnosed rather than endlessly adopted", async () => {
  const f = await fixture();
  f.artifacts.persist.mockRejectedValueOnce(new BlobIntegrityError(h(40), "corrupt stored bytes"));
  await f.coordinator.handle(f.preflight);
  expect(await state(f.preflight)).toEqual({ status: "FAILED", attempt_epoch: 1 });
  await f.coordinator.reconcile();
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(f.execution.probe).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it("temporary archive outage preserves recovery and pinned source", async () => {
  const f = await fixture();
  f.artifacts.persist.mockRejectedValueOnce(new BlobStoreUnavailable("get", "temporarily offline"));
  await f.coordinator.handle(f.preflight);
  expect(await state(f.preflight)).toEqual({ status: "RECOVERING", attempt_epoch: 1 });
  expect((await db.get("select released_at from pipeline_source_pins where run_id=$1", [f.run]))?.released_at).toBeNull();
  await f.coordinator.reconcile();
  expect(await state(f.preflight)).toEqual({ status: "SUCCEEDED", attempt_epoch: 1 });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
});


it("incomplete receipt preserves bounded diagnostics and never publishes", async () => {
  const f = await fixture();
  f.execution.start.mockImplementationOnce(async claim => {
    const snapshot = f.done(claim);
    snapshot.reply!.receipt.status = "incomplete";
    snapshot.reply!.receipt.reasons = ["missing_ocr:2:vl-reader", "x".repeat(5000)];
    return snapshot;
  });
  await f.coordinator.handle(f.preflight);
  const job = await db.get<{status:string;error:string}>("select status,error from stage_jobs where id=$1", [f.preflight]);
  expect(job?.status).toBe("FAILED");
  expect(job?.error).toContain("missing_ocr:2:vl-reader");
  expect(job!.error.length).toBeLessThan(250);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.artifacts.persist).not.toHaveBeenCalled();
});
