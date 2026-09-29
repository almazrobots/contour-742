// T-238: PostgreSQL commit precedes broker publication; only publisher confirm marks delivery.
import { randomUUID } from "node:crypto";
import type { DB } from "../db.ts";

export const PIPELINE_QUEUE = "inspector.pipeline.stage";
const MAX_SEND_ATTEMPTS = 10;
export interface StagePublisher {
  /** Resolves only after broker confirmation, never after merely filling a local buffer. */
  publish(jobId: string): Promise<void>;
}
type Pending = { id: string; job_id: string; send_attempts: number };

/** Repair a lost delivered notification, while preserving the bounded retry budget of an unsent one. */
export async function repairStageNotifications(db: DB): Promise<number> {
  return db.tx(async (t) => {
    const jobs = await t.all<{ id: string }>(`select j.id from stage_jobs j join pipeline_runs r on r.id=j.run_id
      join files f on f.pipeline_run_id=r.id where j.status='READY' and j.not_before <= clock_timestamp()
      and r.status in ('PENDING','RUNNING') and r.execution_mode='durable'
      and not exists (select 1 from pipeline_outbox o where o.job_id=j.id
        and (o.sent_at is null or o.sent_at > clock_timestamp()-interval '60 seconds'))
      order by j.created_at,j.id limit 32 for update of j skip locked`);
    for (const job of jobs) await t.run("insert into pipeline_outbox(id,job_id) values ($1,$2)", [randomUUID(), job.id]);
    return jobs.length;
  });
}

export async function dispatchPipelineOutbox(db: DB, publisher: StagePublisher, limit = 16) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("invalid outbox batch size");
  const owner = randomUUID();
  const rows = await db.tx((t) => t.all<Pending>(`update pipeline_outbox set owner=$1,
    lease_until=clock_timestamp()+interval '60 seconds',send_attempts=send_attempts+1
    where id in (select id from pipeline_outbox where sent_at is null and available_at <= clock_timestamp()
      and (lease_until is null or lease_until <= clock_timestamp()) and send_attempts < $3
      order by created_at,id limit $2 for update skip locked)
    returning id,job_id,send_attempts`, [owner, limit, MAX_SEND_ATTEMPTS]));
  let confirmed = 0, failed = 0;
  // Bounded parallel confirms; each envelope holds only a job ID.
  await Promise.all(rows.map(async (row) => {
    try {
      await publisher.publish(row.job_id);
      const result = await db.run(`update pipeline_outbox set sent_at=clock_timestamp(),owner=null,lease_until=null,error=null
        where id=$1 and owner=$2 and sent_at is null and lease_until > clock_timestamp()`, [row.id, owner]);
      confirmed += result.rowCount;
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      const delay = Math.min(300, 2 ** row.send_attempts);
      await db.run(`update pipeline_outbox set owner=null,lease_until=null,error=$3,
        available_at=clock_timestamp()+$4*interval '1 second' where id=$1 and owner=$2 and sent_at is null`,
      [row.id, owner, message.slice(0, 2000), delay]);
    }
  }));
  const exhausted = await db.get<{ n: number }>("select count(*) n from pipeline_outbox where sent_at is null and send_attempts >= $1", [MAX_SEND_ATTEMPTS]);
  return { claimed: rows.length, confirmed, failed, exhausted: exhausted?.n ?? 0 };
}

/** Independent confirm channel; preserves the legacy queue adapter and its existing callers. */
export async function connectStagePublisher(url: string, queueName = PIPELINE_QUEUE): Promise<StagePublisher & { close(): Promise<void> }> {
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(queueName)) throw Error("invalid pipeline queue name");
  const amqp = await import("amqplib");
  const connection = await amqp.connect(url);
  let lastError: Error | null = null;
  connection.on("error", (error: Error) => { lastError = error; });
  connection.on("close", () => { lastError ??= Error("pipeline AMQP connection closed"); });
  try {
    const channel = await connection.createConfirmChannel();
    channel.on("error", (error: Error) => { lastError = error; });
    channel.on("close", () => { lastError ??= Error("pipeline confirm channel closed"); });
    await channel.assertQueue(queueName, { durable: true });
    return {
      publish: async (jobId) => {
        if (lastError) throw lastError;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            lastError = Error("pipeline broker confirmation timed out");
            reject(lastError);
            void channel.close().catch(() => undefined);
          }, 30_000);
          try {
            channel.sendToQueue(queueName, Buffer.from(JSON.stringify({ job_id: jobId })),
              { persistent: true, contentType: "application/json", messageId: jobId },
              (error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      },
      close: async () => { await connection.close(); },
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}
