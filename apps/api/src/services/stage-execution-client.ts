// Execution observations are not retry admission. Errors/ABSENT must never authorize replay.
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { mlPost, MlError } from "./ml-client.ts";
import { PipelineReply, type PipelineProgress } from "./pipeline-client.ts";
import type { StageClaim } from "./stage-jobs.ts";

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const UUID = z.string().uuid().refine((value) => value === value.toLowerCase(), "canonical UUID required");
const Identity = z.object({ job_id: UUID, epoch: z.number().int().min(1).max(10) });
const Snapshot = z.discriminatedUnion("status", [
  Identity.extend({ status: z.literal("ABSENT"), request_digest: z.null(), reply: z.null(),
    reason: z.null(), requires_remote_quiescence: z.literal(false) }).strict(),
  Identity.extend({ status: z.literal("RUNNING"), request_digest: Digest.nullable(), reply: z.null(),
    reason: z.null(), requires_remote_quiescence: z.literal(true) }).strict(),
  Identity.extend({ status: z.literal("DONE"), request_digest: Digest, reply: PipelineReply,
    reason: z.null(), requires_remote_quiescence: z.literal(false) }).strict(),
  Identity.extend({ status: z.literal("FAILED"), request_digest: Digest, reply: z.null(),
    reason: z.enum(["call_failed", "result_unavailable", "result_missing", "result_corrupt"]),
    requires_remote_quiescence: z.literal(true) }).strict(),
  Identity.extend({ status: z.literal("INTERRUPTED"), request_digest: Digest, reply: z.null(),
    reason: z.literal("owner_disappeared"), requires_remote_quiescence: z.literal(true) }).strict(),
  Identity.extend({ status: z.literal("CANCELLED"), request_digest: Digest, reply: z.null(),
    reason: z.literal("sealed_unstarted"), requires_remote_quiescence: z.literal(false) }).strict(),
]);
const Envelope = Identity.extend({ stage: PipelineReply.shape.receipt.shape.stage,
  body: z.record(z.string(), z.unknown()) }).strict();
export type StageExecutionSnapshot = z.infer<typeof Snapshot>;
export type StageExecutionTransport = (path: string, body: unknown) => Promise<unknown>;

function mismatch(): never { throw new MlError(409, "ML execution does not match the frozen stage attempt"); }

function validateReply(claim: StageClaim, body: Record<string, unknown>, reply: PipelineProgress) {
  const receipt = reply.receipt;
  if (reply.context.run_id !== claim.run_id || receipt.stage !== claim.stage ||
      receipt.output_digest !== reply.artifact || (receipt.status === "complete") !== (receipt.reasons.length === 0)) mismatch();
  if (claim.stage === "preflight") {
    const request = z.object({ sha256: Digest }).passthrough().parse(body.request);
    if (body.run_id !== claim.run_id || request.sha256 !== reply.context.sha256 ||
        reply.context.policy.name !== (body.policy ?? "legacy-compatible-v1") || receipt.region_id !== null ||
        !isDeepStrictEqual(receipt.input_digests, [request.sha256, reply.context.request_fingerprint]) ||
        !reply.regions.length || new Set(reply.regions.map((r) => r.id)).size !== reply.regions.length) mismatch();
  } else {
    const context = PipelineReply.shape.context.parse(body.context);
    const plan = Digest.parse(body.plan);
    const inputs = claim.stage === "parse" ? [plan] : z.array(Digest).parse(body.inputs);
    if (!isDeepStrictEqual(reply.context, context) || receipt.region_id !== (body.region_id ?? null) ||
        !isDeepStrictEqual(receipt.input_digests, inputs) || reply.regions.length) mismatch();
    if (claim.stage === "parse" && typeof body.region_id !== "string") mismatch();
  }
  if (reply.result && reply.result.sha256 !== reply.context.sha256) mismatch();
  if (reply.trace && !isDeepStrictEqual(reply.trace.context, reply.context)) mismatch();
}

export class StageExecutionClient {
  constructor(private readonly transport: StageExecutionTransport = (path, body) =>
    mlPost(path, body, path.endsWith("/start") ? undefined : 5_000)) {}

  start(claim: StageClaim): Promise<StageExecutionSnapshot> { return this.call("start", claim); }
  probe(claim: StageClaim): Promise<StageExecutionSnapshot> { return this.call("probe", claim); }
  cancelUnstarted(claim: StageClaim): Promise<StageExecutionSnapshot> { return this.call("cancel-unstarted", claim); }

  async quiescent(claim: StageClaim): Promise<boolean> {
    const body = typeof claim.request_json === "string" ? JSON.parse(claim.request_json) : claim.request_json;
    const envelope = Envelope.parse({ job_id: claim.id, epoch: claim.attempt_epoch, stage: claim.stage, body });
    const proof = Identity.extend({ quiescent: z.boolean(), journal_identity: z.string().min(1).nullable() }).strict()
      .parse(await this.transport("/pipeline/v1/executions/quiescence", envelope));
    if (proof.job_id !== claim.id || proof.epoch !== claim.attempt_epoch) mismatch();
    if (proof.quiescent && !proof.journal_identity) mismatch();
    return proof.quiescent;
  }

  private async call(operation: "start" | "probe" | "cancel-unstarted", claim: StageClaim): Promise<StageExecutionSnapshot> {
    UUID.parse(claim.run_id);
    const body: unknown = typeof claim.request_json === "string" ? JSON.parse(claim.request_json) : claim.request_json;
    const envelope = Envelope.parse({ job_id: claim.id, epoch: claim.attempt_epoch, stage: claim.stage, body });
    if (claim.stage === "preflight") {
      if (envelope.body.run_id !== claim.run_id) mismatch();
      z.object({ sha256: Digest }).passthrough().parse(envelope.body.request);
    } else {
      if (PipelineReply.shape.context.parse(envelope.body.context).run_id !== claim.run_id) mismatch();
      Digest.parse(envelope.body.plan);
      z.array(Digest).parse(envelope.body.inputs);
      const region = PipelineReply.shape.receipt.shape.region_id.parse(envelope.body.region_id ?? null);
      if ((claim.stage === "parse") !== (region !== null)) mismatch();
    }
    // Python normalizes Pydantic defaults and checks the stored envelope digest on all
    // three routes. Do not duplicate its canonical hashing or infer a safe retry here.
    const snapshot = Snapshot.parse(await this.transport(`/pipeline/v1/executions/${operation}`, envelope));
    if (snapshot.job_id !== claim.id || snapshot.epoch !== claim.attempt_epoch) mismatch();
    if (snapshot.status === "DONE") validateReply(claim, envelope.body, snapshot.reply);
    return snapshot;
  }
}
