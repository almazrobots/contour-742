import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PipelineTransport } from "../src/services/pipeline-client.ts";

const TMP = mkdtempSync(join(tmpdir(), "pipeline-tests-"));
const sha = "a".repeat(64), ref = "b".repeat(64);
const region = { id: `region:${sha}`, page_id: `page:${sha}`, page: 1, bbox: [0, 0, 1, 1], geometry: null };
const request = { sha256: sha, params: [], facts: [] };
let db: any, app: any, token: string, cfg: any, store: any, client: any;
const makeTransport = (damage?: string): PipelineTransport => {
  let context: any;
  const receipts: any[] = [];
  return async (stage: string, body: any) => {
    if (stage === "preflight") context = { schema_version: "pipeline.v1", run_id: body.run_id, sha256: sha,
      configuration: { revision: "test" }, configuration_fingerprint: sha, request_fingerprint: sha,
      policy: { name: body.policy ?? "legacy-compatible-v1", required_ocr_engines: ["anchor", "reader"], require_judge: false, coverage: body.policy === "regional-v1" ? "regional-full-coverage" : "whole-page-legacy" } };
    const receipt = { stage, region_id: stage === "parse" ? region.id : null, input_digests: [sha], output_digest: ref,
      status: "complete", reasons: [], cached: false };
    receipts.push(receipt);
    const result = { sha256: sha, kind: "pdf", engine: "test", ml_revision: "r6", cached: false,
      pages: [{ page: 1, width: 600, height: 300, rotation: 0, source: "text", quality: "OK", ocr_confidence: null, lines: 1 }],
      extractions: [], facts: [], rooms: [] };
    const trace = { context, receipts, completeness: { coverage_scope: context.policy.coverage, planned_regions: 1, completed_regions: 1,
      mandatory_stages_complete: true, publishable: true, reasons: [] as string[] }, pages: [{ region, transcription_digest: sha,
      source: "text", quality: "OK", engines: [], agreement: null, execution_failures: [],
      lines: [{ id: `line:${sha}`, region_id: region.id, text: "PRIVATE_TRANSCRIPTION", tokens: [] }] }] };
    const reply: any = { context: structuredClone(context), artifact: ref, receipt, regions: stage === "preflight" ? [region] : [],
      result: stage === "aggregate" ? result : null, trace: stage === "aggregate" ? trace : null };
    if (stage === "aggregate") {
      if (damage === "incomplete") { trace.completeness.publishable = false; trace.completeness.reasons.push("missing_reader"); reply.result = null; }
      if (damage === "foreign") reply.context.sha256 = "f".repeat(64);
      if (damage === "schema") reply.artifact = 42;
      if (damage === "coverage") trace.pages = [];
      if (damage === "receipts") trace.receipts = trace.receipts.filter((r) => r.stage !== "extract");
      if (damage === "trace-context") trace.context = { ...context, request_fingerprint: ref };
      if (damage === "region") trace.pages[0].region = { ...region, page: 2 };
      if (damage === "reader") trace.pages[0].source = "ocr";
    }
    return reply;
  };
};

beforeAll(async () => {
  Object.assign(process.env, { INSPECTOR_DEMO_PASSWORD: "test-pass", INSPECTOR_ROOT: undefined,
    INSPECTOR_BLOB_DIR: join(TMP, "blobs"), INSPECTOR_PIPELINE_ROUTE: "staged-v1", INSPECTOR_ML_URL: "http://127.0.0.1:9" });
  delete process.env.INSPECTOR_ROOT;
  cfg = (await import("../src/config.ts")).config;
  db = await (await import("../src/db.ts")).openDb("memory");
  store = await import("../src/services/pipeline-runs.ts");
  client = await import("../src/services/pipeline-client.ts");
  app = (await import("../src/app.ts")).buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "inspector", password: "test-pass" } })).json().token;
  await db.run("insert into objects(id,name,created_at) values ('O-TRACE','Trace',now())");
  await db.run("insert into inspections(id,object_id,status,created_at,updated_at) values ('I-TRACE','O-TRACE','READY',now(),now())");
});
afterAll(async () => { await app?.close(); await db?.close(); rmSync(TMP, { recursive: true, force: true }); });

async function file(route = "staged-v1") {
  cfg.pipelineRoute = route;
  const id = randomUUID();
  await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,uploaded_at)
    values ($1,'I-TRACE','O-TRACE',$1,'synthetic.pdf',$2,100,'pdf','PD','TRACE','1',now())`, [id, sha]);
  await db.tx((t: any) => store.preparePipelineRun(t, id));
  return { id, run: (await db.get("select pipeline_run_id from files where id = $1", [id])).pipeline_run_id };
}

describe("T-237: сохранённый запуск, публикация и защищённая трасса", () => {
  it("исторический результат показывает сохранённую версию и неизвестные поля без создания запуска", async () => {
    const f = await file("legacy");
    await db.run("update files set parse_status='DONE',ml_revision='r4-x7',engine='legacy-pdf' where id=$1", [f.id]);
    const url = `/api/v1/files/${f.id}/runs`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const response = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runs: [], recorded_result: {
      sha256: sha, parse_status: "DONE", ml_revision: "r4-x7", engine: "legacy-pdf",
      pipeline_run_id: null, trace_status: "untraced",
    } });
    await db.run("update files set ml_revision=null,engine=null where id=$1", [f.id]);
    const unknown = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    expect(unknown.json().recorded_result).toMatchObject({ ml_revision: null, engine: null, pipeline_run_id: null });
    expect(await db.all("select id from pipeline_runs where file_id=$1", [f.id])).toEqual([]);
  });
  it("не выдаёт запуск другого файла за происхождение сохранённого результата", async () => {
    const f = await file("legacy"), other = await file();
    await db.run("update files set pipeline_result_run_id=$1 where id=$2", [other.run, f.id]);
    const response = await app.inject({ url: `/api/v1/files/${f.id}/runs`, headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runs: [], recorded_result: { trace_status: "inconsistent" } });
  });
  it("durable request, first job, notification and source pin commit together; mode stays frozen", async () => {
    const f = await file();
    const { withPipelineSourceLock } = await import("../src/services/pipeline-source-pins.ts");
    cfg.pipelineExecution = "durable";
    try {
      await expect(db.tx((t: any) => store.preparePipelineRun(t, f.id, request))).rejects.toThrow("filesystem lock");
      await expect(withPipelineSourceLock(() => db.tx(async (t: any) => {
        await store.preparePipelineRun(t, f.id, request);
        throw Error("crash before commit");
      }))).rejects.toThrow("crash before commit");
      expect((await db.get("select pipeline_run_id from files where id=$1", [f.id])).pipeline_run_id).toBe(f.run);
      expect(await db.all("select id from stage_jobs")).toHaveLength(0);
      await withPipelineSourceLock(() => db.tx((t: any) => store.preparePipelineRun(t, f.id, request)));
      const run = (await db.get("select pipeline_run_id from files where id=$1", [f.id])).pipeline_run_id;
      expect((await db.get("select execution_mode from pipeline_runs where id=$1", [run])).execution_mode).toBe("durable");
      expect(await db.all("select * from pipeline_source_pins where run_id=$1 and released_at is null", [run])).toHaveLength(1);
      const jobs = await db.all("select * from stage_jobs where run_id=$1", [run]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].stage).toBe("preflight");
      const body = typeof jobs[0].request_json === "string" ? JSON.parse(jobs[0].request_json) : jobs[0].request_json;
      expect(body.request).toEqual(request);
      expect(await db.all("select * from pipeline_outbox where job_id=$1", [jobs[0].id])).toHaveLength(1);
      cfg.pipelineExecution = "inline";
      await expect(store.analyzePipeline(db, f.id, run, request)).rejects.toThrow("координатором стадий");
    } finally { cfg.pipelineExecution = "inline"; }
  });
  it("смена флага не меняет уже созданный запуск; COMPLETE фиксируется вместе с публикацией", async () => {
    const f = await file();
    cfg.pipelineRoute = "legacy";
    client.setPipelineTransportForTests(makeTransport());
    await store.analyzePipeline(db, f.id, f.run, request);
    expect((await db.get("select status from pipeline_runs where id=$1", [f.run])).status).toBe("RUNNING");
    await db.tx((t: any) => store.publishPipelineRun(t, f.id, f.run));
    expect((await db.get("select status from pipeline_runs where id=$1", [f.run])).status).toBe("COMPLETE");
    expect((await db.get("select pipeline_result_run_id from files where id=$1", [f.id])).pipeline_result_run_id).toBe(f.run);
    const url = `/api/v1/files/${f.id}/runs/${f.run}/trace?page=1`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const read = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    expect(read.statusCode).toBe(200);
    expect(read.json().page.lines[0].text).toBe("PRIVATE_TRANSCRIPTION");
    expect(read.json().progress).toHaveLength(5);
    expect((await app.inject({ url: `/api/v1/files/wrong/runs/${f.run}/trace`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
    const list = await app.inject({ url: `/api/v1/files/${f.id}/runs`, headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().recorded_result).toMatchObject({ sha256: sha, pipeline_run_id: f.run, trace_status: "pipeline_linked" });
    expect(list.json().runs[0].completeness.publishable).toBe(true);
    expect(list.json().runs[0].progress_json).toHaveLength(5);
    expect(list.body).not.toContain("PRIVATE_TRANSCRIPTION");
    cfg.pipelineRoute = "staged-v1";
    await db.tx((t: any) => store.preparePipelineRun(t, f.id));
    const ids = await db.all("select id from pipeline_runs where file_id=$1", [f.id]);
    expect(ids).toHaveLength(2);
    expect((await db.get("select pipeline_result_run_id from files where id=$1", [f.id])).pipeline_result_run_id).toBe(f.run);
  });

  it("regional policy stays frozen and protected trace returns every region of a page", async () => {
    cfg.pipelinePolicy = "regional-v1";
    let f: any;
    try { f = await file(); } finally { cfg.pipelinePolicy = "legacy-compatible-v1"; }
    const transport = makeTransport();
    client.setPipelineTransportForTests(async (stage: string, body: any) => {
      if (stage === "preflight") expect(body.policy).toBe("regional-v1");
      return transport(stage, body);
    });
    await store.analyzePipeline(db, f.id, f.run, request);
    expect((await db.get("select policy from pipeline_runs where id=$1", [f.run])).policy).toBe("regional-v1");
    const row = await db.get("select trace_json from pipeline_runs where id=$1", [f.run]);
    const trace = typeof row.trace_json === "string" ? JSON.parse(row.trace_json) : row.trace_json;
    trace.pages.push({ ...trace.pages[0], region: { ...region, id: `region:${ref}` } });
    trace.reader_observations = [{region_id: region.id, text: "VISIBLE_DIAGNOSTIC", status: "unlocalized"},
      {region_id: "foreign-region", text: "OTHER_PAGE_PRIVATE", status: "unlocalized"}];
    await db.run("update pipeline_runs set trace_json=$1 where id=$2", [JSON.stringify(trace), f.run]);
    const result = await store.pipelineTracePage(db, f.id, f.run, 1);
    expect(result.regions).toHaveLength(2);
    expect(result.reader_observations).toEqual([trace.reader_observations[0]]);
    expect((await store.pipelineTracePage(db, f.id, f.run, 2)).reader_observations).toEqual([]);
    expect(result.regions.map((p: any) => p.region.id)).toEqual([region.id, `region:${ref}`]);
    expect((await store.pipelineTracePage(db, f.id, f.run, 2)).regions).toEqual([]);
  });

  it.each(["incomplete", "foreign", "schema", "coverage", "receipts", "trace-context", "region", "reader"])("не публикует некорректный ответ %s", async (damage) => {
    const f = await file();
    client.setPipelineTransportForTests(makeTransport(damage));
    await expect(store.analyzePipeline(db, f.id, f.run, request)).rejects.toThrow();
    expect((await db.get("select status from pipeline_runs where id=$1", [f.run])).status).toBe("FAILED");
    expect((await db.get("select pipeline_result_run_id from files where id=$1", [f.id])).pipeline_result_run_id).toBeNull();
  });

  it("откат транзакции не оставляет успешного запуска без данных файла", async () => {
    const f = await file();
    client.setPipelineTransportForTests(makeTransport());
    await store.analyzePipeline(db, f.id, f.run, request);
    await expect(db.tx(async (t: any) => { await store.publishPipelineRun(t, f.id, f.run); throw Error("rollback"); })).rejects.toThrow("rollback");
    expect((await db.get("select status from pipeline_runs where id=$1", [f.run])).status).toBe("RUNNING");
  });

  it("не публикует незавершённый или заменённый запуск", async () => {
    const f = await file();
    await expect(db.tx((t: any) => store.publishPipelineRun(t, f.id, f.run))).rejects.toThrow("не готов");
    client.setPipelineTransportForTests(makeTransport());
    await store.analyzePipeline(db, f.id, f.run, request);
    await db.tx((t: any) => store.preparePipelineRun(t, f.id));
    await expect(db.tx((t: any) => store.publishPipelineRun(t, f.id, f.run))).rejects.toThrow("заменён");
    expect((await db.get("select pipeline_result_run_id from files where id=$1", [f.id])).pipeline_result_run_id).toBeNull();
  });
});
