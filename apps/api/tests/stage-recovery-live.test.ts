// Opt-in only: real PostgreSQL + RabbitMQ; no application containers are stopped.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as amqp from "amqplib";
import type { DB } from "../src/db.ts";
import { claimStage, commitStage, enqueueStage, StaleStageAttempt } from "../src/services/stage-jobs.ts";
import { connectStagePublisher, dispatchPipelineOutbox } from "../src/services/pipeline-outbox.ts";

const enabled = process.env.INSPECTOR_STAGE_LIVE === "1";
const sha = "a".repeat(64), digest = "b".repeat(64);
const artifact = { artifactDigest: digest, blobSha256: sha, byteLength: 42,
  schemaVersion: "pipeline.v1" as const, configurationFingerprint: sha };
const child = { logicalKey: digest, stage: "merge" as const, request: { inputs: [digest] } };

describe.skipIf(!enabled)("T-238 real PostgreSQL/RabbitMQ recovery boundaries", () => {
  let db: DB, peer: DB, broker: Awaited<ReturnType<typeof amqp.connect>>;
  let channel: Awaited<ReturnType<typeof broker.createChannel>>;
  let publisher: Awaited<ReturnType<typeof connectStagePublisher>>;
  const queue = `inspector.test.t238.${randomUUID()}`;

  beforeAll(async () => {
    const pgUrl = process.env.INSPECTOR_TEST_DATABASE_URL;
    const rabbitUrl = process.env.INSPECTOR_STAGE_TEST_AMQP_URL;
    if (!pgUrl || !rabbitUrl) throw Error("Live tests require explicit PostgreSQL and RabbitMQ test URLs");
    process.env.INSPECTOR_DEMO_PASSWORD = "synthetic-stage-live";
    const { openDb } = await import("../src/db.ts");
    db = await openDb("memory"); // Existing parity path owns and drops its random t_* schema.
    expect(db.kind).toBe("postgres");
    const schema = (await db.get<{ name: string }>("select current_schema() name"))!.name;
    expect(schema).toMatch(/^t_[0-9a-f]{12}$/);
    const secondUrl = new URL(pgUrl);
    secondUrl.searchParams.set("schema", schema);
    peer = await openDb(secondUrl.toString(), { mode: "none" });
    broker = await amqp.connect(rabbitUrl);
    channel = await broker.createChannel();
    await channel.assertQueue(queue, { durable: true });
    publisher = await connectStagePublisher(rabbitUrl, queue);
    await db.run("insert into objects(id,name,created_at) values ('O-LIVE','Synthetic recovery',now())");
    await db.run("insert into inspections(id,object_id,status,created_at,updated_at) values ('I-LIVE','O-LIVE','PARSING',now(),now())");
  });

  afterAll(async () => {
    // Cleanup only the random queue and schema owned by this test invocation.
    const results = await Promise.allSettled([
      publisher?.close(), channel?.deleteQueue(queue), peer?.close(),
    ]);
    const final = await Promise.allSettled([broker?.close(), db?.close()]);
    const failures = [...results, ...final].filter((r) => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((r) => r.reason), "Live test cleanup failed");
  });

  async function fixture() {
    // All test data lives in the random schema. Isolate each test's pending outbox.
    await db.run("delete from pipeline_outbox");
    await channel.purgeQueue(queue);
    const file = randomUUID(), run = randomUUID();
    await db.run(`insert into files(id,inspection_id,object_id,client_file_id,file_name,sha256,size,kind,doc_stage,document_code,revision,uploaded_at)
      values ($1,'I-LIVE','O-LIVE',$1,'synthetic.pdf',$2,100,'pdf','PD','LIVE','1',now())`, [file, sha]);
    await db.run(`insert into pipeline_runs(id,file_id,sha256,route,execution_mode,status,context_json)
      values ($1,$2,$3,'staged-v1','durable','RUNNING',$4)`, [run, file, sha, JSON.stringify({ configuration_fingerprint: sha })]);
    await db.run("update files set pipeline_run_id=$1 where id=$2", [run, file]);
    const job = await db.tx((t) => enqueueStage(t, run, { logicalKey: sha, stage: "parse", request: { page: 1 } }));
    return { job, run };
  }

  it("real transaction rolls back artifact, success and dependent notification together", async () => {
    const f = await fixture();
    const claim = (await claimStage(db, f.job, "worker-a"))!;
    await expect(commitStage(db, claim, artifact, [child], async (t) => {
      expect(await t.all("select * from stage_artifacts where job_id=$1", [f.job])).toHaveLength(1);
      throw Error("injected failure before commit");
    })).rejects.toThrow("injected failure before commit");
    expect((await peer.get("select status from stage_jobs where id=$1", [f.job]))?.status).toBe("RUNNING");
    expect(await peer.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(0);
    expect(await peer.all("select * from stage_jobs where run_id=$1", [f.run])).toHaveLength(1);
    expect(await peer.all("select * from pipeline_outbox")).toHaveLength(1);
    await commitStage(db, claim, artifact, [child]);
    expect(await peer.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(1);
    expect(await peer.all("select * from pipeline_outbox")).toHaveLength(2);
  });

  it("independent database pools race for one owner; stale epoch cannot publish", async () => {
    const f = await fixture();
    const claims = await Promise.all([claimStage(db, f.job, "worker-a"), claimStage(peer, f.job, "worker-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const won = claims.find((c) => c !== null)!;
    await expect(commitStage(peer, { ...won, attempt_epoch: won.attempt_epoch + 1 }, artifact, [child]))
      .rejects.toBeInstanceOf(StaleStageAttempt);
    expect(await peer.all("select * from stage_artifacts where run_id=$1", [f.run])).toHaveLength(0);
    await commitStage(peer, won, artifact);
    expect(await claimStage(db, f.job, "late-redelivery")).toBeNull();
    expect(await peer.all("select * from job_attempts where job_id=$1", [f.job])).toHaveLength(1);
  });

  it("broker confirms production adapter; lost DB mark allows duplicate without duplicate execution", async () => {
    const f = await fixture();
    const first = await dispatchPipelineOutbox(db, { publish: async (id) => {
      await publisher.publish(id); // Real broker has durably accepted the message.
      // Inject crash boundary after confirm, before the dispatcher can mark sent_at.
      await peer.run("update pipeline_outbox set lease_until=clock_timestamp()-interval '1 second' where job_id=$1", [id]);
    } });
    expect(first.confirmed).toBe(0);
    expect((await peer.get("select sent_at from pipeline_outbox where job_id=$1", [f.job]))?.sent_at).toBeNull();
    expect((await dispatchPipelineOutbox(peer, publisher)).confirmed).toBe(1);
    const secondConsumer = await broker.createChannel();
    try {
    const one = await channel.get(queue, { noAck: false });
    const two = await secondConsumer.get(queue, { noAck: false });
    if (!one || !two) throw Error("Expected two real broker deliveries after lost confirmation bookkeeping");
    expect([one, two].map((m) => JSON.parse(m.content.toString()))).toEqual([{ job_id: f.job }, { job_id: f.job }]);
    expect(one.properties.deliveryMode).toBe(2);
    const claims = await Promise.all([claimStage(db, f.job, "consumer-a"), claimStage(peer, f.job, "consumer-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await commitStage(db, claims.find((c) => c !== null)!, artifact);
    channel.ack(one);
    secondConsumer.ack(two);
    expect(await db.all("select * from job_attempts where job_id=$1", [f.job])).toHaveLength(1);
    } finally { await secondConsumer.close(); }
  });

  it("an independent dispatcher cannot steal a publication awaiting confirmation bookkeeping", async () => {
    const f = await fixture();
    let observed!: () => void, release!: () => void;
    const published = new Promise<void>((resolve) => { observed = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const running = dispatchPipelineOutbox(db, { publish: async (jobId) => {
      await publisher.publish(jobId);
      observed();
      await hold;
    } });
    try {
      // If publishing fails, propagate its completion rather than waiting forever.
      await Promise.race([published, running.then(() => { throw Error("Publisher failed before the boundary"); })]);
      expect((await peer.get("select sent_at from pipeline_outbox where job_id=$1", [f.job]))?.sent_at).toBeNull();
      expect((await dispatchPipelineOutbox(peer, publisher)).claimed).toBe(0);
    } finally { release(); }
    expect((await running).confirmed).toBe(1);
    expect((await channel.checkQueue(queue)).messageCount).toBe(1);
  });

  it("closing only the test consumer after commit before ack redelivers without rerunning the stage", async () => {
    const f = await fixture();
    expect((await dispatchPipelineOutbox(db, publisher)).confirmed).toBe(1);
    const doomed = await broker.createChannel();
    try {
      const message = await doomed.get(queue, { noAck: false });
      if (!message) throw Error("Expected broker delivery");
      const claim = (await claimStage(db, f.job, "before-crash"))!;
      await commitStage(db, claim, artifact);
    } finally { await doomed.close(); } // Actual unacked channel loss, not a mock ack.
    const replacement = await broker.createChannel();
    try {
      const message = await replacement.get(queue, { noAck: false });
      if (!message) throw Error("Expected redelivery after channel close");
      expect(message.fields.redelivered).toBe(true);
      expect(JSON.parse(message.content.toString()).job_id).toBe(f.job);
      expect(await claimStage(peer, f.job, "after-crash")).toBeNull();
      expect(await peer.all("select * from stage_artifacts where job_id=$1", [f.job])).toHaveLength(1);
      expect(await peer.all("select * from job_attempts where job_id=$1", [f.job])).toHaveLength(1);
      replacement.ack(message);
    } finally { await replacement.close(); }
  });
});
