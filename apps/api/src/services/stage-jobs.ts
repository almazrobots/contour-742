// T-238: PostgreSQL owns execution. Broker deliveries are only notifications.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { DB } from "../db.ts";

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const JobSpec = z.object({ logicalKey: Digest,
  stage: z.enum(["preflight", "parse", "merge", "extract", "aggregate"]),
  request: z.record(z.string(), z.unknown()), maxAttempts: z.number().int().min(1).max(10).default(3) }).strict();
export type StageJobSpec = z.input<typeof JobSpec>;
export type StageClaim = { id: string; run_id: string; stage: string; request_json: string;
  attempt_epoch: number; owner: string; lease_until: string };
const Artifact = z.object({ artifactDigest: Digest, blobSha256: Digest,
  byteLength: z.number().int().positive().safe(), schemaVersion: z.literal("pipeline.v1"), configurationFingerprint: Digest }).strict();
export type CommittedArtifact = z.input<typeof Artifact>;
export class StaleStageAttempt extends Error {}
const decode = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
function leaseSeconds(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("lease must be 1..3600 seconds");
  return seconds;
}

// Serialize with a replacement run: an EXISTS snapshot alone cannot fence that race.
async function lockCurrentRun(t: DB, runId: string) {
  return t.get<any>(`select r.* from pipeline_runs r join files f on f.id=r.file_id
    where r.id=$1 and f.pipeline_run_id=r.id and r.execution_mode='durable'
      and r.status in ('PENDING','RUNNING') for update of f,r`, [runId]);
}

/** Called in the caller's transaction: job and notification cannot be separated. */
export async function enqueueStage(t: DB, runId: string, input: StageJobSpec): Promise<string> {
  const spec = JobSpec.parse(input);
  const id = randomUUID();
  const added = await t.get<{ id: string }>(`insert into stage_jobs(id,run_id,logical_key,stage,request_json,max_attempts)
    values ($1,$2,$3,$4,$5,$6) on conflict (run_id,logical_key) do nothing returning id`,
  [id, runId, spec.logicalKey, spec.stage, JSON.stringify(spec.request), spec.maxAttempts]);
  if (!added) {
    const existing = await t.get<any>("select * from stage_jobs where run_id=$1 and logical_key=$2", [runId, spec.logicalKey]);
    if (!existing || existing.stage !== spec.stage || existing.max_attempts !== spec.maxAttempts ||
        !isDeepStrictEqual(decode(existing.request_json), JSON.parse(JSON.stringify(spec.request)))) {
      throw new Error("logical stage identity reused with different inputs");
    }
    return existing.id;
  }
  await t.run("insert into pipeline_outbox(id,job_id) values ($1,$2)", [randomUUID(), id]);
  return id;
}

export async function claimStage(db: DB, jobId: string, owner: string, seconds = 60): Promise<StageClaim | null> {
  if (!owner || owner.length > 200) throw new Error("invalid stage owner");
  leaseSeconds(seconds);
  return db.tx(async (t) => {
    const job = await t.get<{ run_id: string }>("select run_id from stage_jobs where id=$1", [jobId]);
    if (!job || !await lockCurrentRun(t, job.run_id)) return null;
    const claim = await t.get<StageClaim>(`update stage_jobs j set status='RUNNING', owner=$2,
      lease_until=clock_timestamp() + $3 * interval '1 second', attempt_epoch=attempt_epoch+1, error=null
      where id=$1 and status='READY' and not_before <= clock_timestamp() and attempt_epoch < max_attempts
      and exists (select 1 from pipeline_runs r join files f on f.id=r.file_id
        where r.id=j.run_id and r.execution_mode='durable' and r.status in ('PENDING','RUNNING') and f.pipeline_run_id=r.id)
      returning id,run_id,stage,request_json,attempt_epoch,owner,lease_until`, [jobId, owner, seconds]);
    if (!claim) return null;
    await t.run("insert into job_attempts(job_id,attempt_epoch,owner,status) values ($1,$2,$3,'RUNNING')",
      [claim.id, claim.attempt_epoch, owner]);
    return claim;
  });
}

export async function heartbeatStage(db: DB, claim: StageClaim, seconds = 60): Promise<boolean> {
  leaseSeconds(seconds);
  return db.tx(async (t) => {
    const row = await t.get(`update stage_jobs set lease_until=clock_timestamp() + $4 * interval '1 second'
      where id=$1 and attempt_epoch=$2 and owner=$3 and status='RUNNING' and lease_until > clock_timestamp() returning id`,
    [claim.id, claim.attempt_epoch, claim.owner, seconds]);
    if (!row) return false;
    await t.run("update job_attempts set heartbeat_at=clock_timestamp() where job_id=$1 and attempt_epoch=$2", [claim.id, claim.attempt_epoch]);
    return true;
  });
}

/** The blob is already durable and checksum/schema-verified before entering this transaction. */
export async function commitStage(db: DB, claim: StageClaim, input: CommittedArtifact, next: StageJobSpec[] = [],
  publish?: (t: DB) => Promise<void>, frozenContext?: Record<string, unknown>): Promise<void> {
  const artifact = Artifact.parse(input);
  await db.tx(async (t) => {
    const run = await lockCurrentRun(t, claim.run_id);
    if (!run) throw new StaleStageAttempt("run is no longer current");
    if (!run.context_json) {
      // Preflight creates the first frozen context in the SAME commit as its artifact.
      if (claim.stage !== "preflight" || !frozenContext || frozenContext.run_id !== claim.run_id ||
          frozenContext.sha256 !== run.sha256 || frozenContext.schema_version !== artifact.schemaVersion ||
          frozenContext.configuration_fingerprint !== artifact.configurationFingerprint) {
        throw new StaleStageAttempt("preflight must commit its verified context");
      }
      await t.run("update pipeline_runs set context_json=$1 where id=$2", [JSON.stringify(frozenContext), claim.run_id]);
    } else if (frozenContext && !isDeepStrictEqual(decode(run.context_json), JSON.parse(JSON.stringify(frozenContext)))) {
      throw new StaleStageAttempt("run context cannot change");
    }
    const won = await t.get(`update stage_jobs j set status='SUCCEEDED', owner=null,lease_until=null,finished_at=clock_timestamp()
      where id=$1 and run_id=$2 and attempt_epoch=$3 and owner=$4 and status='RUNNING' and lease_until > clock_timestamp()
      and exists (select 1 from pipeline_runs r join files f on f.id=r.file_id where r.id=j.run_id
        and r.status in ('PENDING','RUNNING') and f.pipeline_run_id=r.id
        and r.context_json::jsonb->>'configuration_fingerprint'=$5) returning id`,
    [claim.id, claim.run_id, claim.attempt_epoch, claim.owner, artifact.configurationFingerprint]);
    if (!won) throw new StaleStageAttempt("attempt no longer owns this stage/run/configuration");
    await t.run(`insert into stage_artifacts(job_id,run_id,attempt_epoch,artifact_digest,blob_sha256,byte_length,schema_version,configuration_fingerprint)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`, [claim.id, claim.run_id, claim.attempt_epoch, artifact.artifactDigest,
      artifact.blobSha256, artifact.byteLength, artifact.schemaVersion, artifact.configurationFingerprint]);
    await t.run("update job_attempts set status='SUCCEEDED',finished_at=clock_timestamp() where job_id=$1 and attempt_epoch=$2", [claim.id, claim.attempt_epoch]);
    for (const spec of next) await enqueueStage(t, claim.run_id, spec);
    if (publish) await publish(t);
  });
}

/** Expiry fences publication, but does NOT authorize replacement of a possibly live ML execution. */
export async function fenceExpiredStages(db: DB, limit = 100): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid reconcile limit");
  return db.tx(async (t) => {
    const rows = await t.all<{ id: string; attempt_epoch: number }>(`update stage_jobs set status='RECOVERING',error='execution state unknown after lease expiry'
      where id in (select id from stage_jobs where status='RUNNING' and lease_until <= clock_timestamp()
        order by lease_until limit $1 for update skip locked) and status='RUNNING'
      returning id,attempt_epoch`, [limit]);
    for (const row of rows) await t.run("update job_attempts set status='RECOVERING' where job_id=$1 and attempt_epoch=$2", [row.id, row.attempt_epoch]);
    return rows.length;
  });
}

/** An HTTP failure is uncertain even if the lease has not expired yet. */
export async function markStageUncertain(db: DB, claim: StageClaim, reason: string): Promise<boolean> {
  return db.tx(async (t) => {
    const row = await t.get(`update stage_jobs set status='RECOVERING',error=$4
      where id=$1 and attempt_epoch=$2 and owner=$3 and status='RUNNING' returning id`,
    [claim.id, claim.attempt_epoch, claim.owner, reason.slice(0, 2000)]);
    if (!row) return false;
    await t.run("update job_attempts set status='RECOVERING',error=$3 where job_id=$1 and attempt_epoch=$2",
      [claim.id, claim.attempt_epoch, reason.slice(0, 2000)]);
    return true;
  });
}

/** Only after the execution journal supplies a validated DONE reply for THIS epoch.
 * Transfer publication ownership without inventing another ML execution/attempt.
 * The attempt's original owner remains historical; the current stage owner is fenced.
 */
export async function adoptCompletedStage(db: DB, jobId: string, epoch: number, owner: string, seconds = 60): Promise<StageClaim | null> {
  if (!owner || owner.length > 200) throw Error("invalid recovery owner");
  leaseSeconds(seconds);
  return db.tx(async (t) => {
    const job = await t.get<{ run_id: string }>("select run_id from stage_jobs where id=$1", [jobId]);
    if (!job || !await lockCurrentRun(t, job.run_id)) return null;
    const claim = await t.get<StageClaim>(`update stage_jobs set status='RUNNING',owner=$3,
      lease_until=clock_timestamp()+$4*interval '1 second',error=null
      where id=$1 and attempt_epoch=$2 and status='RECOVERING'
      returning id,run_id,stage,request_json,attempt_epoch,owner,lease_until`, [jobId, epoch, owner, seconds]);
    if (!claim) return null;
    await t.run("update job_attempts set status='RUNNING',heartbeat_at=clock_timestamp() where job_id=$1 and attempt_epoch=$2", [jobId, epoch]);
    return claim;
  });
}

/** Called only after the journal seals the old execution and remote GPU work is quiescent.
 * This transition cannot be invoked for mere lease expiry or unavailable ML status.
 * Returns exhausted instead of silently granting unlimited attempts.
 */
export async function retryStoppedStage(db: DB, jobId: string, epoch: number, reason: string, delaySeconds = 5): Promise<"ready" | "exhausted" | "stale"> {
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 300) throw Error("invalid retry delay");
  return db.tx(async (t) => {
    const job = await t.get<{ run_id: string }>("select run_id from stage_jobs where id=$1", [jobId]);
    if (!job || !await lockCurrentRun(t, job.run_id)) return "stale";
    const row = await t.get<{ attempt_epoch: number; max_attempts: number }>(`select attempt_epoch,max_attempts from stage_jobs
      where id=$1 and attempt_epoch=$2 and status='RECOVERING' for update`, [jobId, epoch]);
    if (!row) return "stale";
    // Leave an exhausted job RECOVERING until the caller atomically fails its run and releases pins.
    if (row.attempt_epoch >= row.max_attempts) return "exhausted";
    await t.run(`update stage_jobs set status='READY',owner=null,lease_until=null,error=$3,
      not_before=clock_timestamp()+$4*interval '1 second' where id=$1 and attempt_epoch=$2`,
    [jobId, epoch, reason.slice(0, 2000), delaySeconds]);
    await t.run(`update job_attempts set status='STOPPED',finished_at=clock_timestamp(),error=$3
      where job_id=$1 and attempt_epoch=$2`, [jobId, epoch, reason.slice(0, 2000)]);
    await t.run(`insert into pipeline_outbox(id,job_id,available_at)
      select $1,id,not_before from stage_jobs where id=$2`, [randomUUID(), jobId]);
    return "ready";
  });
}
