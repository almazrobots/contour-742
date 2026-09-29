import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StageExecutionClient } from "../src/services/stage-execution-client.ts";
import type { StageClaim } from "../src/services/stage-jobs.ts";
import type { PipelineProgress } from "../src/services/pipeline-client.ts";

const h = (n: number) => n.toString(16).padStart(64, "0");
function fixture(stage: PipelineProgress["receipt"]["stage"] = "parse") {
  const run = randomUUID();
  const context: PipelineProgress["context"] = { schema_version: "pipeline.v1", run_id: run, sha256: h(1),
    configuration: { revision: "synthetic" }, configuration_fingerprint: h(2), request_fingerprint: h(3),
    policy: { name: "legacy-compatible-v1", required_ocr_engines: [], require_judge: false, coverage: "whole-page-legacy" } };
  const region = { id: `region:${h(4)}`, page_id: `page:${h(5)}`, page: 1, bbox: [0, 0, 1, 1] as [number, number, number, number], geometry: null };
  const body = stage === "preflight" ? { run_id: run, request: { sha256: h(1), params: [] } }
    : { context, plan: h(6), inputs: stage === "parse" ? [] : [h(7)], region_id: stage === "parse" ? region.id : null };
  const claim: StageClaim = { id: randomUUID(), run_id: run, stage, request_json: JSON.stringify(body),
    attempt_epoch: 1, owner: "synthetic-worker", lease_until: "2099-01-01T00:00:00Z" };
  const reply: PipelineProgress = { context: structuredClone(context), artifact: h(8),
    receipt: { stage, region_id: stage === "parse" ? region.id : null,
      input_digests: stage === "preflight" ? [h(1), h(3)] : stage === "parse" ? [h(6)] : [h(7)],
      output_digest: h(8), status: "complete", reasons: [], cached: false },
    regions: stage === "preflight" ? [region] : [], result: null, trace: null };
  const snapshot = { job_id: claim.id, epoch: claim.attempt_epoch, status: "DONE", request_digest: h(9),
    reply, reason: null, requires_remote_quiescence: false };
  return { body, claim, reply, snapshot };
}

describe("typed execution client does not turn observations into replay permission", () => {
  it.each(["start", "probe", "cancelUnstarted"] as const)("%s sends the identical frozen envelope", async (method) => {
    const f = fixture();
    const transport = vi.fn(async () => f.snapshot);
    const result = await new StageExecutionClient(transport)[method](f.claim);
    expect(result.status).toBe("DONE");
    if (result.status === "DONE") expect(result.reply).toEqual(f.reply);
    expect(transport).toHaveBeenCalledExactlyOnceWith(`/pipeline/v1/executions/${method === "cancelUnstarted" ? "cancel-unstarted" : method}`,
      { job_id: f.claim.id, epoch: 1, stage: "parse", body: f.body });
  });

  it.each(["preflight", "merge", "extract", "aggregate"] as const)("accepts a valid %s dependency receipt", async (stage) => {
    const f = fixture(stage);
    expect((await new StageExecutionClient(async () => f.snapshot).probe(f.claim)).status).toBe("DONE");
  });

  it.each([
    { status: "ABSENT", request_digest: null, reason: null, requires_remote_quiescence: false },
    { status: "RUNNING", request_digest: null, reason: null, requires_remote_quiescence: true },
    { status: "RUNNING", request_digest: h(9), reason: null, requires_remote_quiescence: true },
    ...["call_failed", "result_missing", "result_corrupt", "result_unavailable"].map((reason) =>
      ({ status: "FAILED", request_digest: h(9), reason, requires_remote_quiescence: true })),
    { status: "INTERRUPTED", request_digest: h(9), reason: "owner_disappeared", requires_remote_quiescence: true },
    { status: "CANCELLED", request_digest: h(9), reason: "sealed_unstarted", requires_remote_quiescence: false },
  ])("preserves $status/$reason observation without another request", async (observation) => {
    const f = fixture();
    const value = { ...f.snapshot, ...observation, reply: null };
    const transport = vi.fn(async () => value);
    expect(await new StageExecutionClient(transport).probe(f.claim)).toEqual(value);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "DONE", request_digest: null }, { status: "DONE", reply: null },
    { status: "DONE", reason: "call_failed" }, { status: "DONE", requires_remote_quiescence: true },
    { status: "ABSENT", reply: null, request_digest: h(9) },
    { status: "RUNNING", reply: null, requires_remote_quiescence: false },
    { status: "FAILED", reply: null, reason: "call_failed", requires_remote_quiescence: false },
    { status: "FAILED", reply: null, reason: "sealed_unstarted", requires_remote_quiescence: true },
    { status: "INTERRUPTED", reply: null, reason: null, requires_remote_quiescence: true },
    { status: "CANCELLED", reply: null, reason: "owner_disappeared" },
    { status: "UNKNOWN" }, { epoch: 2 }, { job_id: randomUUID() }, { unexpected: true },
  ])("rejects contradictory or foreign snapshot %j", async (damage) => {
    const f = fixture();
    const transport = vi.fn(async () => ({ ...f.snapshot, ...damage }));
    await expect(new StageExecutionClient(transport).probe(f.claim)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["ABSENT", "RUNNING", "FAILED", "INTERRUPTED", "CANCELLED"])("%s must never carry a reply", async (status) => {
    const f = fixture();
    await expect(new StageExecutionClient(async () => ({ ...f.snapshot, status })).probe(f.claim)).rejects.toThrow();
  });

  it.each(["run", "source", "context", "stage", "artifact", "region", "input", "status-reasons"])(
    "rejects a DONE reply with foreign %s", async (damage) => {
      const f = fixture();
      if (damage === "run") f.reply.context.run_id = randomUUID();
      if (damage === "source") f.reply.context.sha256 = h(90);
      if (damage === "context") f.reply.context.configuration_fingerprint = h(90);
      if (damage === "stage") f.reply.receipt.stage = "merge";
      if (damage === "artifact") f.reply.receipt.output_digest = h(90);
      if (damage === "region") f.reply.receipt.region_id = `region:${h(90)}`;
      if (damage === "input") f.reply.receipt.input_digests = [h(90)];
      if (damage === "status-reasons") f.reply.receipt.reasons = ["missing_reader"];
      await expect(new StageExecutionClient(async () => f.snapshot).start(f.claim)).rejects.toThrow();
    });

  it.each(["source", "request-receipt", "policy", "regions"])("preflight checks frozen %s", async (damage) => {
    const f = fixture("preflight");
    if (damage === "source") f.reply.context.sha256 = h(90);
    if (damage === "request-receipt") f.reply.receipt.input_digests[1] = h(90);
    if (damage === "policy") f.claim.request_json = JSON.stringify({ ...f.body, policy: "foreign-policy" });
    if (damage === "regions") f.reply.regions = [];
    await expect(new StageExecutionClient(async () => f.snapshot).probe(f.claim)).rejects.toThrow();
  });

  it("DONE with a valid incomplete stage remains incomplete for the graph's publication decision", async () => {
    const f = fixture("aggregate");
    f.reply.receipt.status = "incomplete";
    f.reply.receipt.reasons = ["missing_reader"];
    const result = await new StageExecutionClient(async () => f.snapshot).probe(f.claim);
    expect(result.status).toBe("DONE");
    if (result.status === "DONE") expect(result.reply.receipt.status).toBe("incomplete");
  });

  it.each(["source", "trace-context"])("rejects aggregate foreign %s even when its outer context matches", async (damage) => {
    const f = fixture("aggregate");
    f.reply.result = { sha256: damage === "source" ? h(90) : h(1), kind: "pdf", engine: "synthetic",
      ml_revision: null, cached: false, pages: [], extractions: [], facts: [], rooms: [] };
    f.reply.trace = { context: { ...f.reply.context, run_id: damage === "trace-context" ? randomUUID() : f.claim.run_id },
      receipts: [], pages: [], completeness: { coverage_scope: "whole-page-legacy", planned_regions: 1,
        completed_regions: 0, mandatory_stages_complete: false, publishable: false, reasons: ["missing_reader"] } };
    await expect(new StageExecutionClient(async () => f.snapshot).probe(f.claim)).rejects.toThrow();
  });

  it.each(["preflight", "parse"] as const)("refuses a foreign %s input run before executing anything", async (stage) => {
    const f = fixture(stage);
    const body = JSON.parse(f.claim.request_json);
    if (stage === "preflight") body.run_id = randomUUID();
    else body.context.run_id = randomUUID();
    f.claim.request_json = JSON.stringify(body);
    const transport = vi.fn(async () => f.snapshot);
    await expect(new StageExecutionClient(transport).start(f.claim)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["start", "probe", "cancelUnstarted"] as const)("%s propagates transport failure, never synthesizes ABSENT or retries", async (method) => {
    const f = fixture();
    const error = Error("connection lost; ML may still be running");
    const transport = vi.fn(async () => { throw error; });
    await expect(new StageExecutionClient(transport)[method](f.claim)).rejects.toBe(error);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([0, 11, 1.5])("rejects illegal epoch %s before transport", async (epoch) => {
    const f = fixture();
    const transport = vi.fn(async () => f.snapshot);
    await expect(new StageExecutionClient(transport).start({ ...f.claim, attempt_epoch: epoch })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});


it("requires matching attempt identity and a journal for positive external-stop proof", async () => {
  const { claim } = fixture();
  const proof = { job_id: claim.id, epoch: claim.attempt_epoch, quiescent: true, journal_identity: "stand-journal" };
  expect(await new StageExecutionClient(async () => proof).quiescent(claim)).toBe(true);
  expect(await new StageExecutionClient(async () => ({ ...proof, quiescent: false, journal_identity: null })).quiescent(claim)).toBe(false);
  for (const bad of [{ ...proof, epoch: 2 }, { ...proof, job_id: randomUUID() }, { ...proof, journal_identity: null }, { ...proof, quiescent: "true" }]) {
    await expect(new StageExecutionClient(async () => bad).quiescent(claim)).rejects.toThrow();
  }
});
