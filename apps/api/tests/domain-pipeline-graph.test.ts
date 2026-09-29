import { describe, expect, it } from "vitest";
import { nextPipelineStages, type StageCheckpoint } from "../src/domain/pipeline-graph.ts";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const plan = { runId: "synthetic-run", digest: hash(1), regions: [2, 3, 4].map((n) => `region:${hash(n)}`) };
const parts: StageCheckpoint[] = plan.regions.map((regionId, i) => ({ stage: "parse", regionId, digest: hash(i + 10), inputs: [plan.digest] }));
const merge: StageCheckpoint = { stage: "merge", regionId: null, digest: hash(20), inputs: parts.map((p) => p.digest) };
const extract: StageCheckpoint = { stage: "extract", regionId: null, digest: hash(21), inputs: [merge.digest] };
const aggregate: StageCheckpoint = { stage: "aggregate", regionId: null, digest: hash(22), inputs: [extract.digest] };

describe("T-238: frozen graph continuation", () => {
  it("only missing pages are scheduled after restart; late pages preserve merge order", () => {
    const initial = nextPipelineStages(plan, []);
    const resumed = nextPipelineStages(plan, [parts[2], parts[0]]);
    expect(resumed).toEqual([initial[1]]);
    const jobs = nextPipelineStages(plan, [parts[2], parts[0], parts[1]]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].stage).toBe("merge");
    expect(jobs[0].inputs).toEqual(parts.map((p) => p.digest));
  });
  it("advances one dependency barrier at a time and finishes without repeating committed work", () => {
    expect(nextPipelineStages(plan, [...parts, merge])[0]).toMatchObject({ stage: "extract", inputs: [merge.digest] });
    expect(nextPipelineStages(plan, [...parts, extract, merge])[0]).toMatchObject({ stage: "aggregate", inputs: [extract.digest] });
    expect(nextPipelineStages(plan, [aggregate, ...parts, extract, merge])).toEqual([]);
  });
  it("rejects duplicates, foreign inputs and incomplete downstream checkpoints", () => {
    for (const invalid of [
      [parts[0], parts[0]], [parts[0], merge], [...parts, extract], [...parts, aggregate],
      [...parts, merge, merge], [...parts, { ...merge, inputs: [...merge.inputs].reverse() }],
      [{ ...parts[0], inputs: [hash(99)] }], [{ ...parts[0], regionId: `region:${hash(99)}` }],
    ]) expect(() => nextPipelineStages(plan, invalid)).toThrow();
  });
  it("a different run or plan cannot reuse a job identity", () => {
    const key = nextPipelineStages(plan, [])[0].logicalKey;
    expect(nextPipelineStages({ ...plan, runId: "another-run" }, [])[0].logicalKey).not.toBe(key);
    expect(nextPipelineStages({ ...plan, digest: hash(99) }, [])[0].logicalKey).not.toBe(key);
  });
});
