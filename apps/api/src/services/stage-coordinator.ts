import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import type { DB } from "../db.ts";
import { BlobIntegrityError, BlobNotFound, type BlobStore } from "./blobstore.ts";
import { MlError, type MlResponse } from "./ml-client.ts";
import { PipelineGraphError } from "../domain/pipeline-graph.ts";
import type { PipelineProgress, PipelineRunContext } from "./pipeline-client.ts";
import { StageArtifactStore } from "./stage-artifacts.ts";
import { StageExecutionClient, type StageExecutionSnapshot } from "./stage-execution-client.ts";
import { advanceStageGraph } from "./stage-graph.ts";
import { adoptCompletedStage, claimStage, commitStage, fenceExpiredStages, heartbeatStage,
  markStageUncertain, retryStoppedStage, type StageClaim } from "./stage-jobs.ts";
import { withPipelineSourceLock } from "./pipeline-source-pins.ts";

const decode = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) : value as T;
const invalidArtifact = (error: unknown) => error instanceof PipelineGraphError || error instanceof ZodError ||
  error instanceof BlobIntegrityError || error instanceof BlobNotFound ||
  (error instanceof MlError && [409, 413, 415, 422].includes(error.status));
type Execution = Pick<StageExecutionClient, "start" | "probe" | "cancelUnstarted">;
type Artifacts = Pick<StageArtifactStore, "persist" | "restore">;
type Options = {
  db: DB; blobs: BlobStore; execution: Execution; artifacts: Artifacts;
  publish(t: DB, fileId: string, runId: string, result: MlResponse): Promise<void>;
  settled(inspectionId: string): Promise<void>;
  // Mandatory external evidence; local process death does not prove remote Reader quiescence.
  canRetry(claim: StageClaim, snapshot: StageExecutionSnapshot): Promise<boolean>;
  report(error: unknown): void;
};

export class StageCoordinator {
  private readonly owner = randomUUID();
  constructor(private readonly options: Options) {}

  private async keepLease<T>(claim: StageClaim, fn: () => Promise<T>): Promise<T> {
    let pending: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (!pending) pending = heartbeatStage(this.options.db, claim).then(() => undefined,
        (error) => this.options.report(error)).finally(() => { pending = null; });
    }, 15_000).unref();
    try { return await fn(); }
    finally { clearInterval(timer); await pending; }
  }

  private async hydrate(claim: StageClaim): Promise<void> {
    const { db, blobs, artifacts } = this.options;
    const run = await db.get<{ sha256: string }>("select sha256 from pipeline_runs where id=$1", [claim.run_id]);
    if (!run) throw Error("pipeline run missing");
    const pinned = await db.get("select run_id from pipeline_source_pins where run_id=$1 and sha256=$2 and released_at is null", [claim.run_id, run.sha256]);
    if (!pinned) throw Error("active pipeline source is not pinned");
    await blobs.localPath(run.sha256);
    if (claim.stage === "preflight") return;
    const body = decode<{ context: PipelineRunContext; plan: string; inputs: string[] }>(claim.request_json);
    for (const digest of new Set([body.plan, ...body.inputs])) {
      const row = await db.get<any>(`select a.*,j.stage from stage_artifacts a join stage_jobs j on j.id=a.job_id
        where a.run_id=$1 and a.artifact_digest=$2 and j.status='SUCCEEDED'`, [claim.run_id, digest]);
      if (!row) throw Error("committed dependency missing");
      await artifacts.restore({ artifactDigest: row.artifact_digest, blobSha256: row.blob_sha256,
        byteLength: Number(row.byte_length), schemaVersion: row.schema_version,
        configurationFingerprint: row.configuration_fingerprint }, body.context, row.stage);
    }
  }

  private async finish(claim: StageClaim, reply: PipelineProgress): Promise<void> {
    if (reply.receipt.status !== "complete") {
      const reasons = reply.receipt.reasons.slice(0, 10).map(reason => reason.replace(/[\r\n\t]/g, " ").slice(0, 160));
      await this.fail(claim, `mandatory pipeline stage incomplete${reasons.length ? ": " + reasons.join(", ") : ""}`);
      return;
    }
    const { db, artifacts, publish } = this.options;
    const stored = await artifacts.persist(reply);
    let inspection: string | null = null;
    await withPipelineSourceLock(() => commitStage(db, claim, stored, [], async (t) => {
      const result = await advanceStageGraph(t, claim, reply);
      if (result) {
        const file = await t.get<{ id: string; inspection_id: string }>(`select f.id,f.inspection_id from files f
          join pipeline_runs r on r.file_id=f.id where r.id=$1`, [claim.run_id]);
        if (!file) throw Error("pipeline file missing");
        await publish(t, file.id, claim.run_id, result);
        await t.run("update pipeline_source_pins set released_at=clock_timestamp() where run_id=$1 and released_at is null", [claim.run_id]);
        inspection = file.inspection_id;
      }
    }, reply.context));
    if (inspection) await this.options.settled(inspection);
  }

  private async finishOrFail(claim: StageClaim, reply: PipelineProgress): Promise<void> {
    try { await this.finish(claim, reply); }
    catch (error) {
      if (!invalidArtifact(error)) throw error;
      await this.fail(claim, String(error));
    }
  }

  /** Final diagnostic failure never overwrites the previously published result pointer. */
  private async fail(claim: StageClaim, reason: string): Promise<void> {
    const inspection = await withPipelineSourceLock(() => this.options.db.tx(async (t) => {
      const file = await t.get<any>(`select f.id,f.inspection_id,f.pipeline_run_id from files f
        join pipeline_runs r on r.file_id=f.id where r.id=$1 for update of f,r`, [claim.run_id]);
      const won = await t.get(`update stage_jobs set status='FAILED',owner=null,lease_until=null,error=$4,finished_at=clock_timestamp()
        where id=$1 and attempt_epoch=$2 and owner=$3 and status in ('RUNNING','RECOVERING') returning id`,
      [claim.id, claim.attempt_epoch, claim.owner, reason.slice(0, 2000)]);
      if (!won) return null;
      await t.run("update job_attempts set status='FAILED',error=$3,finished_at=clock_timestamp() where job_id=$1 and attempt_epoch=$2", [claim.id, claim.attempt_epoch, reason.slice(0, 2000)]);
      await t.run("update stage_jobs set status='FAILED',error=$2,finished_at=clock_timestamp() where run_id=$1 and status='READY'", [claim.run_id, "run failed"]);
      await t.run("update pipeline_runs set status='FAILED',error=$2,finished_at=clock_timestamp() where id=$1 and status in ('PENDING','RUNNING')", [claim.run_id, reason.slice(0, 2000)]);
      await t.run(`update pipeline_source_pins set released_at=clock_timestamp() where run_id=$1 and released_at is null
        and not exists (select 1 from stage_jobs where run_id=$1 and status in ('RUNNING','RECOVERING'))`, [claim.run_id]);
      if (file?.pipeline_run_id !== claim.run_id) return null;
      await t.run("update files set parse_status='FAILED',parse_error=$2 where id=$1", [file.id, reason.slice(0, 2000)]);
      return file.inspection_id as string;
    }));
    if (inspection) await this.options.settled(inspection);
  }

  /** Caller controls broker ack. A thrown DB error must leave the message unacknowledged. */
  async handle(jobId: string): Promise<void> {
    const { db, execution } = this.options;
    const claim = await claimStage(db, jobId, this.owner);
    if (!claim) return;
    try {
      await this.keepLease(claim, async () => {
        await db.run(`update files set parse_status='PARSING',parse_attempts=greatest(parse_attempts,$2)
          where pipeline_run_id=$1`, [claim.run_id, claim.attempt_epoch]);
        try { await this.hydrate(claim); }
        catch (error) {
          // No execution was submitted for this newly claimed epoch. Permanent dependency
          // failure can terminate it safely; transport/storage outages remain recoverable.
          if (!invalidArtifact(error)) throw error;
          await this.fail(claim, String(error));
          return;
        }
        const snapshot = await execution.start(claim);
        if (snapshot.status === "DONE") await this.finishOrFail(claim, snapshot.reply);
        else await markStageUncertain(db, claim, `execution ${snapshot.status}`);
      });
    } catch (error) {
      await markStageUncertain(db, claim, String(error));
      this.options.report(error);
    }
  }

  async reconcile(): Promise<void> {
    const { db, execution, canRetry } = this.options;
    await fenceExpiredStages(db);
    const claims = await db.all<StageClaim>(`select id,run_id,stage,request_json,attempt_epoch,owner,lease_until
      from stage_jobs where status='RECOVERING' order by lease_until,id limit 32`);
    for (const claim of claims) {
      try {
        let snapshot = await execution.probe(claim);
        if (snapshot.status === "ABSENT") snapshot = await execution.cancelUnstarted(claim);
        if (snapshot.status === "DONE") {
          const reply = snapshot.reply;
          const adopted = await adoptCompletedStage(db, claim.id, claim.attempt_epoch, `${this.owner}:recovery`);
          if (adopted) {
            try { await this.keepLease(adopted, () => this.finishOrFail(adopted, reply)); }
            catch (error) { await markStageUncertain(db, adopted, String(error)); throw error; }
          } else {
            const active = await db.get(`select r.id from pipeline_runs r join files f on f.pipeline_run_id=r.id
              where r.id=$1 and r.status in ('PENDING','RUNNING')`, [claim.run_id]);
            if (!active) await this.fail(claim, "completed execution belongs to an inactive run");
          }
        } else if (snapshot.status === "CANCELLED" ||
            ((snapshot.status === "FAILED" || snapshot.status === "INTERRUPTED") && snapshot.reason !== "result_unavailable" && await canRetry(claim, snapshot))) {
          const active = await db.get(`select r.id from pipeline_runs r join files f on f.pipeline_run_id=r.id
            where r.id=$1 and r.status in ('PENDING','RUNNING')`, [claim.run_id]);
          if (!active) { await this.fail(claim, "stopped execution belongs to an inactive run"); continue; }
          const outcome = await retryStoppedStage(db, claim.id, claim.attempt_epoch, `previous execution ${snapshot.status}`);
          if (outcome === "exhausted") await this.fail(claim, "pipeline stage attempts exhausted");
        }
      } catch (error) { this.options.report(error); }
    }
  }
}
