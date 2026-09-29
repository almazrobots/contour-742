import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { DB } from "../src/db.ts";
import { preserveFileResult, preserveHistoricalResults, listFileResultSnapshots } from "../src/services/file-result-snapshots.ts";

let db: DB;
let app: ReturnType<typeof import("../src/app.ts").buildApp>, token: string;
let publish: typeof import("../src/services/inspections.ts").publishParsedFile;
const sha = "c".repeat(64);
const response = { sha256: sha, kind: "pdf", engine: "new", pages: [], extractions: [], facts: [], rooms: [],
  ml_revision: "r6-x15", cached: false };
beforeAll(async () => {
  db = await (await import("../src/db.ts")).openDb("memory");
  publish = (await import("../src/services/inspections.ts")).publishParsedFile;
  app = (await import("../src/app.ts")).buildApp(db);
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {
    login: "inspector", password: (await import("../src/config.ts")).config.demoPassword,
  } })).json().token;
  await db.run("insert into objects(id,name,created_at) values ('O-SNAPSHOT','Synthetic',now())");
  await db.run("insert into inspections(id,object_id,status,created_at,updated_at) values ('I-SNAPSHOT','O-SNAPSHOT','READY',now(),now())");
});
afterAll(async () => { await app?.close(); await db?.close(); });
async function file(old = false) {
  const id = randomUUID();
  await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,uploaded_at)
    values ($1,'I-SNAPSHOT','O-SNAPSHOT',$1,'synthetic.pdf',$2,10,'pdf','PD','SYN','1',now())`, [id, sha]);
  if (old) {
    await db.run("update files set parse_status='PARSING',engine='old',ml_revision='r4-x7',pages_json='[]' where id=$1", [id]);
    await db.run("insert into extractions(file_id,param_code,kind,raw,value_num,page,confidence) values ($1,'M-007','param','OLD_VALUE',12,1,0.9)", [id]);
    await db.run("insert into rooms(file_id,number,name,page) values ($1,'1','SYNTHETIC_ROOM',1)", [id]);
  }
  return id;
}
describe("immutable snapshots before result replacement", () => {
  it("captures beyond one batch and safely resumes without changing source results", async () => {
    await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,
      doc_stage,document_code,revision,uploaded_at,engine)
      select 'BATCH-'||n,'I-SNAPSHOT','O-SNAPSHOT','BATCH-'||n,'synthetic.pdf',$1,10,'pdf','PD','SYN','1',now(),'historical'
      from generate_series(1,103) n`, [sha]);
    await db.tx(t => preserveFileResult(t, "BATCH-1")); // Simulate a previously interrupted pass.
    const first = await preserveHistoricalResults(db);
    const second = await preserveHistoricalResults(db);
    expect(first.visited).toBeGreaterThanOrEqual(103);
    expect(second).toEqual(first);
    expect((await db.get("select count(*)::int count from file_result_snapshots where file_id like 'BATCH-%'"))?.count).toBe(103);
    expect((await db.get("select count(*)::int count from files where id like 'BATCH-%' and engine='historical' and ml_revision is null and pipeline_result_run_id is null"))?.count).toBe(103);
    expect(await db.all("select id from pipeline_runs where file_id like 'BATCH-%'")).toEqual([]);
  });
  it("does not invent a historical result for an unprocessed file", async () => {
    const id = await file();
    await db.tx(t => publish(t, id, null, response));
    expect(await listFileResultSnapshots(db, id, 20, 0)).toEqual([]);
  });
  it("preserves actual old values and unknown run identity when publishing new data", async () => {
    const id = await file(true);
    await db.tx(t => publish(t, id, null, response));
    const snapshot = (await db.all("select *,payload_json::text payload_text from file_result_snapshots where file_id=$1", [id]))[0];
    const body = JSON.parse(snapshot.payload_text);
    expect(snapshot).toMatchObject({ sha256: sha, source_run_id: null, ml_revision: "r4-x7", engine: "old" });
    expect(body.file).toMatchObject({ ml_revision: "r4-x7", pipeline_result_run_id: null });
    expect(body.file).toMatchObject({ doc_stage: "PD", document_code: "SYN", revision: "1", file_name: "synthetic.pdf" });
    expect(body.file).not.toHaveProperty("parse_status");
    expect(body.file).not.toHaveProperty("pipeline_run_id");
    expect(body.extractions[0]).toMatchObject({ raw: "OLD_VALUE", value_num: 12 });
    expect(body.rooms[0].name).toBe("SYNTHETIC_ROOM");
    expect(body.file).not.toHaveProperty("processing_started_at");
    expect((await db.get("select engine,ml_revision from files where id=$1", [id]))).toMatchObject({ engine: "new", ml_revision: "r6-x15" });
    expect(await db.all("select id from extractions where file_id=$1", [id])).toEqual([]);
    expect(await db.all("select id from pipeline_runs where file_id=$1", [id])).toEqual([]);
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(snapshot.payload_text).digest("hex")).toBe(snapshot.payload_sha256);
  });
  it("rolls preservation and replacement back together when publication fails", async () => {
    const id = await file(true);
    const bad = { ...response, extractions: [{ code: "M-007", raw: "NEW_VALUE", value_num: 99,
      value_text: null, page: 1, bbox: null, anchor_bbox: null, line_text: "synthetic", confidence: 2 }] };
    await expect(db.tx(t => publish(t, id, null, bad))).rejects.toThrow();
    expect((await db.get("select raw from extractions where file_id=$1", [id]))?.raw).toBe("OLD_VALUE");
    expect(await listFileResultSnapshots(db, id, 20, 0)).toEqual([]);
    expect((await db.get("select engine from files where id=$1", [id]))?.engine).toBe("old");
  });
  it("deduplicates the same preserved state and rejects mutation or truncation", async () => {
    const id = await file(true);
    await db.tx(t => preserveFileResult(t, id));
    await db.tx(t => preserveFileResult(t, id));
    const rows = await listFileResultSnapshots(db, id, 20, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ extractions: 1, rooms: 1, hidden_works: 0, requisites: 0, change_marks: 0 });
    await expect(db.run("update file_result_snapshots set engine='forged' where file_id=$1", [id])).rejects.toThrow();
    await expect(db.run("delete from file_result_snapshots where file_id=$1", [id])).rejects.toThrow();
    await expect(db.exec("truncate file_result_snapshots")).rejects.toThrow();
  });
  it("does not fill absent historical model or engine values from the new response", async () => {
    const id = await file(true);
    await db.run("update files set ml_revision=null,engine=null where id=$1", [id]);
    await db.tx(t => publish(t, id, null, response));
    expect((await listFileResultSnapshots(db, id, 20, 0))[0]).toMatchObject({ ml_revision: null, engine: null, source_run_id: null });
  });
  it("serves old extractions with authentication, file binding and database pagination", async () => {
    const id = await file(true), another = await file();
    await db.run("insert into extractions(file_id,param_code,kind,raw,value_num,page,confidence) values ($1,'M-007','param','OLD_SECOND',13,2,0.8)", [id]);
    await db.tx(t => publish(t, id, null, response));
    const url = `/api/v1/files/${id}/result-snapshots`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${token}` };
    const list = await app.inject({ url, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().snapshots[0]).toMatchObject({ file_id: id, extractions: 2, source_run_id: null });
    const snapshot = list.json().snapshots[0].id;
    const old = await app.inject({ url: `${url}/${snapshot}/extractions?limit=1&offset=1`, headers });
    expect(old.statusCode).toBe(200);
    expect(old.json().extractions).toHaveLength(1);
    expect(old.json().extractions[0].raw).toBe("OLD_SECOND");
    expect((await app.inject({ url: `/api/v1/files/${another}/result-snapshots/${snapshot}/extractions`, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: `${url}/${snapshot}/extractions?limit=0`, headers })).statusCode).toBe(400);
  });
});
