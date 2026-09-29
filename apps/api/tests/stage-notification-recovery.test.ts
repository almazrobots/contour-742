import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { DB } from "../src/db.ts";
import { claimStage, enqueueStage } from "../src/services/stage-jobs.ts";
import { dispatchPipelineOutbox, repairStageNotifications } from "../src/services/pipeline-outbox.ts";

let db: DB;
const sha = "a".repeat(64);
beforeAll(async () => {
  process.env.INSPECTOR_DEMO_PASSWORD = "synthetic-notification-recovery";
  db = await (await import("../src/db.ts")).openDb("memory");
  await db.run("insert into objects(id,name,created_at) values ('O-NOTIFY','Synthetic notifications',now())");
  await db.run("insert into inspections(id,object_id,status,created_at,updated_at) values ('I-NOTIFY','O-NOTIFY','PARSING',now(),now())");
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  // The database is an isolated PGlite instance or the existing random parity schema.
  await db.run("update pipeline_runs set status='FAILED'");
  await db.run("delete from pipeline_outbox");
});

async function fixture() {
  const file = randomUUID(), run = randomUUID();
  await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,uploaded_at)
    values ($1,'I-NOTIFY','O-NOTIFY',$1,'synthetic.pdf',$2,100,'pdf','PD','NOTIFY','1',now())`, [file, sha]);
  await db.run(`insert into pipeline_runs(id,file_id,sha256,route,execution_mode,status)
    values ($1,$2,$3,'staged-v1','durable','RUNNING')`, [run, file, sha]);
  await db.run("update files set pipeline_run_id=$1 where id=$2", [run, file]);
  const job = await db.tx((t) => enqueueStage(t, run, { logicalKey: sha, stage: "preflight", request: { run_id: run } }));
  return { file, run, job };
}

it("concurrent reconciliation restores one missing READY notification without creating another attempt", async () => {
  const f = await fixture();
  await db.run("delete from pipeline_outbox where job_id=$1", [f.job]);
  const counts = await Promise.all([repairStageNotifications(db), repairStageNotifications(db)]);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  expect(await db.all("select * from pipeline_outbox where job_id=$1", [f.job])).toHaveLength(1);
  expect(await db.all("select * from job_attempts where job_id=$1", [f.job])).toHaveLength(0);
  const publish = vi.fn(async () => undefined);
  expect((await dispatchPipelineOutbox(db, { publish })).confirmed).toBe(1);
  expect(publish).toHaveBeenCalledExactlyOnceWith(f.job);
  expect((await claimStage(db, f.job, "recovered-consumer"))?.attempt_epoch).toBe(1);
});

it("recent confirmation gets a delivery grace period; lost old delivery is repaired once", async () => {
  const f = await fixture();
  await dispatchPipelineOutbox(db, { publish: async () => undefined });
  expect(await repairStageNotifications(db)).toBe(0);
  await db.run("update pipeline_outbox set sent_at=clock_timestamp()-interval '61 seconds' where job_id=$1", [f.job]);
  expect(await repairStageNotifications(db)).toBe(1);
  expect(await repairStageNotifications(db)).toBe(0);
  expect(await db.all("select * from pipeline_outbox where job_id=$1", [f.job])).toHaveLength(2);
  const publish = vi.fn(async () => undefined);
  expect((await dispatchPipelineOutbox(db, { publish })).confirmed).toBe(1);
  expect(publish).toHaveBeenCalledExactlyOnceWith(f.job);
});

it("temporary broker failure retains the same notification and budget until a replacement publisher confirms", async () => {
  const f = await fixture();
  const before = (await db.get("select id from pipeline_outbox where job_id=$1", [f.job]))!;
  const disconnected = { publish: vi.fn(async () => { throw Error("injected broker connection closed"); }) };
  expect(await dispatchPipelineOutbox(db, disconnected)).toMatchObject({ failed: 1, confirmed: 0, exhausted: 0 });
  expect(await repairStageNotifications(db)).toBe(0);
  expect((await dispatchPipelineOutbox(db, disconnected)).claimed).toBe(0); // Backoff is real DB time.
  await db.run("update pipeline_outbox set available_at=clock_timestamp()-interval '1 second' where job_id=$1", [f.job]);
  const replacement = { publish: vi.fn(async () => undefined) };
  expect((await dispatchPipelineOutbox(db, replacement)).confirmed).toBe(1);
  const after = (await db.get("select * from pipeline_outbox where job_id=$1", [f.job]))!;
  expect(after.id).toBe(before.id);
  expect(after.send_attempts).toBe(2);
  expect(after.sent_at).not.toBeNull();
  expect(after.error).toBeNull();
  expect(replacement.publish).toHaveBeenCalledExactlyOnceWith(f.job);
});

it("ten failed sends remain exhausted across repeated repairs, preserving READY and its diagnostic", async () => {
  const f = await fixture();
  const unavailable = { publish: vi.fn(async () => { throw Error("injected persistent broker outage"); }) };
  for (let attempt = 1; attempt <= 10; attempt++) {
    await db.run("update pipeline_outbox set available_at=clock_timestamp()-interval '1 second' where job_id=$1", [f.job]);
    expect((await dispatchPipelineOutbox(db, unavailable)).failed).toBe(1);
    expect(await repairStageNotifications(db)).toBe(0);
  }
  const healthy = { publish: vi.fn(async () => undefined) };
  for (let tick = 0; tick < 3; tick++) {
    expect(await repairStageNotifications(db)).toBe(0);
    expect(await dispatchPipelineOutbox(db, healthy)).toMatchObject({ claimed: 0, confirmed: 0, exhausted: 1 });
  }
  expect(healthy.publish).not.toHaveBeenCalled();
  expect(unavailable.publish).toHaveBeenCalledTimes(10);
  const rows = await db.all("select * from pipeline_outbox where job_id=$1", [f.job]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ send_attempts: 10, sent_at: null, error: "injected persistent broker outage" });
  expect(await db.get("select status,attempt_epoch from stage_jobs where id=$1", [f.job]))
    .toEqual({ status: "READY", attempt_epoch: 0 });
});

// Inject transport failures at actual database IO boundaries, retaining the real transaction engine.
function failingDb(shouldFail: (method: keyof DB) => boolean): DB {
  return new Proxy(db, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (shouldFail(property as keyof DB)) return Promise.reject(Error("injected database unavailable"));
      return (value as (...args: unknown[]) => unknown).apply(target, args);
    };
  } });
}

it("database outage before claim sends nothing and consumes no notification budget", async () => {
  const f = await fixture();
  const unavailable = failingDb((method) => method === "tx");
  const publish = vi.fn(async () => undefined);
  await expect(dispatchPipelineOutbox(unavailable, { publish })).rejects.toThrow("database unavailable");
  await expect(repairStageNotifications(unavailable)).rejects.toThrow("database unavailable");
  expect(publish).not.toHaveBeenCalled();
  expect((await db.get("select send_attempts from pipeline_outbox where job_id=$1", [f.job]))?.send_attempts).toBe(0);
  expect((await dispatchPipelineOutbox(db, { publish })).confirmed).toBe(1);
});

it("database loss after broker confirmation preserves the lease, then recovery redelivers without losing READY", async () => {
  const f = await fixture();
  let databaseDown = false;
  const guarded = failingDb((method) => databaseDown && method === "run");
  const broker = { publish: vi.fn(async () => { databaseDown = true; }) };
  await expect(dispatchPipelineOutbox(guarded, broker)).rejects.toThrow("database unavailable");
  const pending = (await db.get("select * from pipeline_outbox where job_id=$1", [f.job]))!;
  expect(pending.sent_at).toBeNull();
  expect(pending.owner).not.toBeNull();
  expect(pending.send_attempts).toBe(1);
  expect(await repairStageNotifications(db)).toBe(0);
  const recovered = { publish: vi.fn(async () => undefined) };
  expect((await dispatchPipelineOutbox(db, recovered)).claimed).toBe(0);
  await db.run("update pipeline_outbox set lease_until=clock_timestamp()-interval '1 second' where job_id=$1", [f.job]);
  expect((await dispatchPipelineOutbox(db, recovered)).confirmed).toBe(1);
  expect(recovered.publish).toHaveBeenCalledExactlyOnceWith(f.job);
  expect(await db.all("select * from pipeline_outbox where job_id=$1", [f.job])).toHaveLength(1);
  expect((await claimStage(db, f.job, "first-delivery"))?.attempt_epoch).toBe(1);
  expect(await claimStage(db, f.job, "duplicate-delivery")).toBeNull();
});

it.each(["superseded", "failed", "inline", "future", "running"])("does not resurrect %s jobs", async (kind) => {
  const f = await fixture();
  await db.run("delete from pipeline_outbox where job_id=$1", [f.job]);
  if (kind === "superseded") await db.run("update files set pipeline_run_id=null where id=$1", [f.file]);
  if (kind === "failed") await db.run("update pipeline_runs set status='FAILED' where id=$1", [f.run]);
  if (kind === "inline") await db.run("update pipeline_runs set execution_mode='inline' where id=$1", [f.run]);
  if (kind === "future") await db.run("update stage_jobs set not_before=clock_timestamp()+interval '1 hour' where id=$1", [f.job]);
  if (kind === "running") await claimStage(db, f.job, "active-worker");
  expect(await repairStageNotifications(db)).toBe(0);
  expect(await db.all("select * from pipeline_outbox where job_id=$1", [f.job])).toHaveLength(0);
});

it("bounded repair batches eventually cover all READY jobs without duplicate pending rows", async () => {
  for (let count = 0; count < 35; count++) await fixture();
  await db.run("delete from pipeline_outbox");
  expect(await repairStageNotifications(db)).toBe(32);
  expect(await repairStageNotifications(db)).toBe(3);
  expect(await repairStageNotifications(db)).toBe(0);
  expect(await db.all("select job_id,count(*) n from pipeline_outbox group by job_id having count(*)<>1")).toHaveLength(0);
  expect(await db.all("select id from pipeline_outbox")).toHaveLength(35);
});
