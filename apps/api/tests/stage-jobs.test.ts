import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DB } from "../src/db.ts";
import { adoptCompletedStage, claimStage, commitStage, enqueueStage, fenceExpiredStages, heartbeatStage, markStageUncertain, retryStoppedStage, StaleStageAttempt } from "../src/services/stage-jobs.ts";
import { dispatchPipelineOutbox } from "../src/services/pipeline-outbox.ts";

let db: DB;
const sha = "a".repeat(64), digest = "b".repeat(64);
const first = { logicalKey: sha, stage: "parse" as const, request: { page: 1 } };
const next = { logicalKey: digest, stage: "merge" as const, request: { inputs: [digest] } };
const artifact = { artifactDigest: digest, blobSha256: sha, byteLength: 42,
  schemaVersion: "pipeline.v1" as const, configurationFingerprint: sha };

beforeAll(async () => {
  process.env.INSPECTOR_DEMO_PASSWORD = "test-stage-jobs";
  db = await (await import("../src/db.ts")).openDb("memory");
  await db.run("insert into objects(id,name,created_at) values ('O-JOBS','Synthetic jobs',now())");
  await db.run("insert into inspections(id,object_id,status,created_at,updated_at) values ('I-JOBS','O-JOBS','PARSING',now(),now())");
});
afterAll(async () => { await db?.close(); });

async function fixture() {
  const file = randomUUID(), run = randomUUID();
  await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,uploaded_at)
    values ($1,'I-JOBS','O-JOBS',$1,'synthetic.pdf',$2,100,'pdf','PD','JOBS','1',now())`, [file, sha]);
  await db.run(`insert into pipeline_runs(id,file_id,sha256,route,execution_mode,status,context_json)
    values ($1,$2,$3,'staged-v1','durable','RUNNING',$4)`, [run, file, sha, JSON.stringify({ configuration_fingerprint: sha })]);
  await db.run("update files set pipeline_run_id=$1 where id=$2", [run, file]);
  const job = await db.tx((t) => enqueueStage(t, run, first));
  return { file, run, job };
}

describe("T-238: durable job transitions before runtime wiring", () => {
  it("recovery adopts a completed execution without a second attempt and fences its former owner", async () => {
    const f = await fixture();
    const original = (await claimStage(db, f.job, "original"))!;
    expect(await markStageUncertain(db, original, "HTTP disconnected")).toBe(true);
    expect(await heartbeatStage(db, original)).toBe(false);
    expect(await claimStage(db, f.job, "duplicate")).toBeNull();
    const adopted = (await adoptCompletedStage(db, f.job, original.attempt_epoch, "reconciler"))!;
    expect(adopted.attempt_epoch).toBe(original.attempt_epoch);
    await expect(commitStage(db, original, artifact)).rejects.toBeInstanceOf(StaleStageAttempt);
    expect(await adoptCompletedStage(db, f.job, original.attempt_epoch, "second-reconciler")).toBeNull();
    await commitStage(db, adopted, artifact);
    const attempts = await db.all<any>("select * from job_attempts where job_id=$1", [f.job]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ owner: "original", status: "SUCCEEDED" });
  });

  it("confirmed stopped retries are bounded and stale epochs cannot enqueue replacements", async () => {
    const f = await fixture();
    for (let epoch = 1; epoch <= 3; epoch++) {
      const claim = (await claimStage(db, f.job, `worker-${epoch}`))!;
      expect(claim.attempt_epoch).toBe(epoch);
      expect(await retryStoppedStage(db, f.job, epoch, "not fenced yet", 0)).toBe("stale");
      await markStageUncertain(db, claim, "connection lost");
      expect(await retryStoppedStage(db, f.job, epoch + 1, "foreign proof", 0)).toBe("stale");
      expect(await retryStoppedStage(db, f.job, epoch, "execution sealed, remote work drained", 0)).toBe(epoch < 3 ? "ready" : "exhausted");
    }
    expect(await claimStage(db, f.job, "fourth")).toBeNull();
    expect(await db.all("select * from job_attempts where job_id=$1", [f.job])).toHaveLength(3);
    expect(await db.all("select * from pipeline_outbox where job_id=$1", [f.job])).toHaveLength(3);
  });
  it("preflight freezes context atomically and stale owner cannot freeze it", async () => {
    const f = await fixture();
    await db.run("update pipeline_runs set context_json=null where id=$1", [f.run]);
    const job = await db.tx((t) => enqueueStage(t, f.run, { ...next, stage: "preflight" }));
    const claim = (await claimStage(db, job, "worker"))!;
    const context = { run_id: f.run, sha256: sha, schema_version: "pipeline.v1", configuration_fingerprint: sha };
    await expect(commitStage(db, { ...claim, owner: "foreign" }, artifact, [], undefined, context)).rejects.toBeInstanceOf(StaleStageAttempt);
    expect((await db.get("select context_json from pipeline_runs where id=$1", [f.run]))?.context_json).toBeNull();
    await commitStage(db, claim, artifact, [], undefined, context);
    expect(JSON.parse((await db.get("select context_json from pipeline_runs where id=$1", [f.run]))!.context_json)).toEqual(context);
  });
  it("job/outbox atomic; duplicate enqueue preserves inputs", async () => {
    const f = await fixture();
    expect(await db.tx((t) => enqueueStage(t, f.run, first))).toBe(f.job);
    expect(await db.all("select * from pipeline_outbox where job_id=$1", [f.job])).toHaveLength(1);
    await expect(db.tx((t) => enqueueStage(t, f.run, { ...first, request: { page: 2 } }))).rejects.toThrow("different inputs");
    await expect(db.tx(async (t) => { await enqueueStage(t, f.run, next); throw Error("rollback"); })).rejects.toThrow("rollback");
    expect(await db.get("select id from stage_jobs where run_id=$1 and logical_key=$2", [f.run, digest])).toBeUndefined();
  });

  it("concurrent deliveries produce one owner and attempt", async () => {
    const f = await fixture();
    const claims = await Promise.all([claimStage(db, f.job, "worker-a"), claimStage(db, f.job, "worker-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await db.all("select * from job_attempts where job_id=$1", [f.job])).toHaveLength(1);
    expect(claims.find(Boolean)?.attempt_epoch).toBe(1);
  });

  it("commit stores artifact and next job/outbox; duplicate commit rejected", async () => {
    const f = await fixture();
    const claim = (await claimStage(db, f.job, "worker"))!;
    await commitStage(db, claim, artifact, [next]);
    expect((await db.get("select status from stage_jobs where id=$1", [f.job]))?.status).toBe("SUCCEEDED");
    expect((await db.get("select blob_sha256 from stage_artifacts where job_id=$1", [f.job]))?.blob_sha256).toBe(sha);
    expect(await db.all("select o.id from pipeline_outbox o join stage_jobs j on j.id=o.job_id where j.run_id=$1", [f.run])).toHaveLength(2);
    await expect(commitStage(db, claim, artifact)).rejects.toBeInstanceOf(StaleStageAttempt);
    expect(await claimStage(db, f.job, "duplicate")).toBeNull();
  });

  it.each(["owner", "epoch", "fingerprint", "superseded"])("rejects invalid publication: %s", async (damage) => {
    const f = await fixture();
    const claim = (await claimStage(db, f.job, "worker"))!;
    if (damage === "owner") claim.owner = "foreign";
    if (damage === "epoch") claim.attempt_epoch += 1;
    if (damage === "superseded") await db.run("update files set pipeline_run_id=null where id=$1", [f.file]);
    await expect(commitStage(db, claim, { ...artifact, configurationFingerprint: damage === "fingerprint" ? digest : sha }, [next]))
      .rejects.toBeInstanceOf(StaleStageAttempt);
    expect(await db.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(0);
    expect(await db.all("select * from stage_jobs where run_id=$1", [f.run])).toHaveLength(1);
  });

  it("publication failure rolls back artifact, success and dependent outbox", async () => {
    const f = await fixture();
    const claim = (await claimStage(db, f.job, "worker"))!;
    await expect(commitStage(db, claim, artifact, [next], async () => { throw Error("publication failed"); }))
      .rejects.toThrow("publication failed");
    expect((await db.get("select status from stage_jobs where id=$1", [f.job]))?.status).toBe("RUNNING");
    expect(await db.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(0);
    expect(await db.all("select o.id from pipeline_outbox o join stage_jobs j on j.id=o.job_id where j.run_id=$1", [f.run])).toHaveLength(1);
  });

  it("expired lease fences commit/heartbeat without authorizing new execution", async () => {
    const f = await fixture();
    const claim = (await claimStage(db, f.job, "worker"))!;
    expect(await heartbeatStage(db, claim)).toBe(true);
    await db.run("update stage_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [f.job]);
    expect(await heartbeatStage(db, claim)).toBe(false);
    await expect(commitStage(db, claim, artifact)).rejects.toBeInstanceOf(StaleStageAttempt);
    await fenceExpiredStages(db);
    expect((await db.get("select status from stage_jobs where id=$1", [f.job]))?.status).toBe("RECOVERING");
    expect((await db.get("select status from job_attempts where job_id=$1", [f.job]))?.status).toBe("RECOVERING");
    expect(await claimStage(db, f.job, "replacement")).toBeNull();
  });

  it("inline runs and exhausted jobs cannot start durable execution", async () => {
    const f = await fixture();
    await db.run("update pipeline_runs set execution_mode='inline' where id=$1", [f.run]);
    expect(await claimStage(db, f.job, "worker")).toBeNull();
    await db.run("update pipeline_runs set execution_mode='durable' where id=$1", [f.run]);
    await db.run("update stage_jobs set attempt_epoch=max_attempts where id=$1", [f.job]);
    expect(await claimStage(db, f.job, "worker")).toBeNull();
  });

  it("outbox is marked sent only after broker confirm; second dispatcher cannot steal it", async () => {
    await db.run("delete from pipeline_outbox");
    const f = await fixture();
    let started!: () => void, confirm!: () => void;
    const seen = new Promise<void>((r) => { started = r; });
    const ack = new Promise<void>((r) => { confirm = r; });
    const running = dispatchPipelineOutbox(db, { publish: async (job) => { expect(job).toBe(f.job); started(); await ack; } });
    await seen;
    expect((await db.get("select sent_at from pipeline_outbox where job_id=$1", [f.job]))?.sent_at).toBeNull();
    expect((await dispatchPipelineOutbox(db, { publish: async () => { throw Error("duplicate publish"); } })).claimed).toBe(0);
    confirm();
    expect((await running).confirmed).toBe(1);
    expect((await db.get("select sent_at from pipeline_outbox where job_id=$1", [f.job]))?.sent_at).not.toBeNull();
  });

  it("broker failure leaves durable notification with bounded retries and diagnostics", async () => {
    await db.run("delete from pipeline_outbox");
    const f = await fixture();
    const failed = { publish: async () => { throw Error("broker unavailable"); } };
    expect((await dispatchPipelineOutbox(db, failed)).failed).toBe(1);
    const row = await db.get("select * from pipeline_outbox where job_id=$1", [f.job]);
    expect(row?.sent_at).toBeNull();
    expect(row?.owner).toBeNull();
    expect(row?.error).toBe("broker unavailable");
    expect((await dispatchPipelineOutbox(db, failed)).claimed).toBe(0);
    await db.run("update pipeline_outbox set send_attempts=10,available_at=clock_timestamp()-interval '1 second' where job_id=$1", [f.job]);
    const exhausted = await dispatchPipelineOutbox(db, failed);
    expect(exhausted.claimed).toBe(0);
    expect(exhausted.exhausted).toBe(1);
  });

  it("lost dispatcher lease cannot mark confirmed notification sent", async () => {
    await db.run("delete from pipeline_outbox");
    const f = await fixture();
    const result = await dispatchPipelineOutbox(db, { publish: async () => {
      await db.run("update pipeline_outbox set lease_until=clock_timestamp()-interval '1 second' where job_id=$1", [f.job]);
    } });
    expect(result.confirmed).toBe(0);
    expect((await db.get("select sent_at from pipeline_outbox where job_id=$1", [f.job]))?.sent_at).toBeNull();
    expect((await dispatchPipelineOutbox(db, { publish: async () => undefined })).confirmed).toBe(1);
  });
});
