// Frozen-run graph: only committed artifacts satisfy dependencies.
import { createHash } from "node:crypto";

export type DurableStage = "parse" | "merge" | "extract" | "aggregate";
export type StageCheckpoint = { stage: DurableStage; regionId: string | null; digest: string; inputs: string[] };
export type PlannedStage = { stage: DurableStage; regionId: string | null; inputs: string[]; logicalKey: string };
export type FrozenPlan = { runId: string; digest: string; regions: string[] };
export class PipelineGraphError extends Error {}
const digestPattern = /^[0-9a-f]{64}$/;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, i) => item === b[i]);

/** Completion order is irrelevant; merge inputs always follow the frozen page order.
 * This function never treats READY/RUNNING jobs as completed checkpoints.
 */
export function nextPipelineStages(plan: FrozenPlan, committed: StageCheckpoint[]): PlannedStage[] {
  if (!plan.runId || !digestPattern.test(plan.digest) || !plan.regions.length ||
      new Set(plan.regions).size !== plan.regions.length || plan.regions.some((r) => !/^region:[0-9a-f]{64}$/.test(r))) {
    throw new PipelineGraphError("invalid frozen pipeline plan");
  }
  const parsed = new Map<string, StageCheckpoint>();
  const tail = new Map<DurableStage, StageCheckpoint>();
  for (const checkpoint of committed) {
    if (!digestPattern.test(checkpoint.digest) || checkpoint.inputs.some((d) => !digestPattern.test(d))) throw new PipelineGraphError("invalid checkpoint digest");
    if (checkpoint.stage === "parse") {
      if (!checkpoint.regionId || !plan.regions.includes(checkpoint.regionId) || parsed.has(checkpoint.regionId) ||
          !same(checkpoint.inputs, [plan.digest])) throw new PipelineGraphError("foreign or duplicate committed region");
      parsed.set(checkpoint.regionId, checkpoint);
    } else {
      if (!["merge", "extract", "aggregate"].includes(checkpoint.stage) || checkpoint.regionId !== null || tail.has(checkpoint.stage)) {
        throw new PipelineGraphError("invalid or duplicate committed stage");
      }
      tail.set(checkpoint.stage, checkpoint);
    }
  }
  const spec = (stage: DurableStage, inputs: string[], regionId: string | null = null): PlannedStage => ({
    stage, inputs, regionId,
    // Coordinator identity only; this is not the Python artifact digest algorithm.
    logicalKey: createHash("sha256").update(JSON.stringify([plan.runId, plan.digest, stage, regionId, inputs])).digest("hex"),
  });
  const missing = plan.regions.filter((id) => !parsed.has(id));
  if (missing.length) {
    if (tail.size) throw new PipelineGraphError("committed downstream stage has missing regions");
    return missing.map((id) => spec("parse", [], id));
  }
  let inputs = plan.regions.map((id) => parsed.get(id)!.digest);
  for (const stage of ["merge", "extract", "aggregate"] as const) {
    const checkpoint = tail.get(stage);
    if (!checkpoint) {
      if (tail.size) throw new PipelineGraphError("committed downstream stage has missing dependency");
      return [spec(stage, inputs)];
    }
    if (!same(checkpoint.inputs, inputs)) throw new PipelineGraphError("committed stage inputs differ from frozen dependencies");
    tail.delete(stage);
    inputs = [checkpoint.digest];
  }
  return [];
}
