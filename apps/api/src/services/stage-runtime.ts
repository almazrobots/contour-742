import { z } from "zod";
import type { DB } from "../db.ts";
import { config } from "../config.ts";
import { log } from "./audit.ts";
import { blobStore } from "./blobstore.ts";
import { maybeFinishParsing, publishParsedFile } from "./inspections.ts";
import { StageArtifactStore } from "./stage-artifacts.ts";
import { StageExecutionClient } from "./stage-execution-client.ts";
import { StageCoordinator } from "./stage-coordinator.ts";
import { connectStagePublisher, dispatchPipelineOutbox, PIPELINE_QUEUE, repairStageNotifications } from "./pipeline-outbox.ts";

const Envelope = z.object({ job_id: z.string().uuid() }).strict();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const report = (error: unknown) => log("ERROR", "durable pipeline", { message: String(error).slice(0, 2000) });

async function consumer(db: DB, coordinator: StageCoordinator) {
  const amqp = await import("amqplib");
  const connection = await amqp.connect(config.amqpUrl!);
  let alive = true;
  connection.on("error", (error) => { alive = false; report(error); });
  connection.on("close", () => { alive = false; });
  try {
    const channel = await connection.createChannel();
    channel.on("error", (error) => { alive = false; report(error); });
    channel.on("close", () => { alive = false; });
    await channel.assertQueue(PIPELINE_QUEUE, { durable: true });
    // Initial durable pilot is serial; global GPU admission belongs to the next stage.
    await channel.prefetch(1);
    await channel.consume(PIPELINE_QUEUE, (message) => {
      if (!message) { alive = false; return; }
      let jobId: string;
      try { jobId = Envelope.parse(JSON.parse(message.content.toString("utf8"))).job_id; }
      catch (error) { report(error); channel.ack(message); return; }
      void (async () => {
        await coordinator.handle(jobId);
        while (alive) {
          const job = await db.get<{ status: string }>("select status from stage_jobs where id=$1", [jobId]);
          // READY here means a retry was durably scheduled with another outbox notification.
          if (!job || ["SUCCEEDED", "FAILED", "READY"].includes(job.status)) { channel.ack(message); return; }
          await delay(1_000);
        }
      })().catch(async (error) => {
        report(error);
        await delay(1_000);
        if (alive) channel.nack(message, false, true);
      }).catch(report);
    }, { noAck: false });
    return { alive: () => alive, close: async () => { alive = false; await connection.close().catch(report); } };
  } catch (error) { await connection.close().catch(report); throw error; }
}

/** One supervised loop owns reconnection, the outbox and recovery; ticks never overlap. */
export async function startStageRuntime(db: DB): Promise<{ close(): Promise<void> }> {
  const pending = await db.get("select id from pipeline_runs where execution_mode='durable' and status in ('PENDING','RUNNING') limit 1");
  if (config.readonly || (config.pipelineExecution !== "durable" && !pending)) return { close: async () => {} };
  if (config.queueMode !== "amqp") throw Error("durable pipeline runtime requires RabbitMQ");
  const blobs = blobStore();
  const execution = new StageExecutionClient();
  const coordinator = new StageCoordinator({ db, blobs, execution, artifacts: new StageArtifactStore(blobs),
    publish: publishParsedFile, settled: (inspection) => maybeFinishParsing(db, inspection), report,
    // ML rechecks its local journal, then seals external requests. UNKNOWN or a lost
    // proxy journal never authorizes another epoch merely because the lease expired.
    canRetry: (claim) => execution.quiescent(claim),
  });
  let receiver: Awaited<ReturnType<typeof consumer>> | null = null;
  let publisher: Awaited<ReturnType<typeof connectStagePublisher>> | null = null;
  let stopped = false, running: Promise<void> | null = null;
  const tick = async () => {
    await coordinator.reconcile();
    await repairStageNotifications(db);
    if (stopped) return;
    if (!receiver?.alive()) { await receiver?.close(); receiver = await consumer(db, coordinator); }
    publisher ??= await connectStagePublisher(config.amqpUrl!);
    const dispatched = await dispatchPipelineOutbox(db, publisher);
    if (dispatched.exhausted) report(Error(`${dispatched.exhausted} pipeline notifications exhausted their retry budget`));
    if (dispatched.failed) { await publisher.close().catch(report); publisher = null; }
    // Crash after aggregate commit but before recomputation must not strand the inspection.
    const inspections = await db.all<{ id: string }>(`select id from inspections i where status='PARSING'
      and not exists (select 1 from files f where f.inspection_id=i.id and f.parse_status in ('PENDING','PARSING'))`);
    for (const item of inspections) await maybeFinishParsing(db, item.id);
  };
  const launch = () => {
    if (!stopped && !running) running = tick().catch(report).finally(() => { running = null; });
  };
  const timer = setInterval(launch, 5_000).unref();
  launch();
  return { close: async () => {
    stopped = true; clearInterval(timer); await running;
    await receiver?.close(); await publisher?.close().catch(report);
  } };
}
