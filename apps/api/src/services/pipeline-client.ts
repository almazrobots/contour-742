// T-237: validated internal contract. No subject/inspector decisions originate here.
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { MlError, mlPost, type MlRequest, type MlResponse } from "./ml-client.ts";

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Id = z.string().regex(/^[a-z]+:[0-9a-f]{64}$/);
const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Stage = z.enum(["preflight", "parse", "merge", "extract", "aggregate"]);
const Context = z.object({
  schema_version: z.literal("pipeline.v1"), run_id: z.string().uuid(), sha256: Digest,
  configuration: z.record(z.string(), z.unknown()), configuration_fingerprint: Digest, request_fingerprint: Digest,
  policy: z.object({ name: z.enum(["legacy-compatible-v1", "regional-v1"]), required_ocr_engines: z.array(z.string()),
    require_judge: z.boolean(), coverage: z.enum(["whole-page-legacy", "regional-full-coverage"]) }).strict(),
}).strict();
const Receipt = z.object({ stage: Stage, region_id: Id.nullable(), input_digests: z.array(Digest), output_digest: Digest,
  status: z.enum(["complete", "incomplete"]), reasons: z.array(z.string()), cached: z.boolean() }).strict();
const Matrix = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
const Region = z.object({ id: Id, page_id: Id, page: z.number().int().positive(), bbox: Box,
  geometry: z.object({ coordinate_space: z.literal("visible-page-normalized-top-left"), width: z.number().positive(),
    height: z.number().positive(), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    media_box: Box, crop_box: Box, pdf_to_visible: Matrix, visible_to_pdf: Matrix }).strict().nullable(),
}).strict();
const Page = z.object({ region: Region, transcription_digest: Digest, source: z.string(), quality: z.string(),
  engines: z.array(z.string()), agreement: z.number().nullable(), execution_failures: z.array(z.string()),
  lines: z.array(z.object({ id: Id, region_id: Id, text: z.string(), tokens: z.array(z.object({ id: Id, text: z.string(),
    bbox: Box.nullable(), confidence: z.number().nullable(), disputed: z.boolean() }).strict()) }).strict()),
}).strict();
const Extraction = z.object({ code: z.string(), raw: z.string(), value_num: z.number().nullable(), value_text: z.string().nullable(),
  page: z.number().int().positive(), bbox: Box.nullable(), anchor_bbox: Box.nullable(), line_text: z.string(), confidence: z.number(),
  meta: z.record(z.string(), z.unknown()).nullable().optional() }).passthrough();
const Result = z.object({ sha256: Digest, kind: z.string(), engine: z.string(), ml_revision: z.string().nullable(), cached: z.boolean(),
  pages: z.array(z.object({ page: z.number().int().positive(), width: z.number(), height: z.number(), rotation: z.number(),
    source: z.string(), quality: z.string(), ocr_confidence: z.number().nullable(), lines: z.number().int() }).passthrough()),
  extractions: z.array(Extraction), facts: z.array(Extraction), rooms: z.array(z.object({ number: z.string(), name: z.string(),
    page: z.number().int().positive(), bbox: Box.nullable() })),
}).passthrough();
export const PipelineTrace = z.object({ context: Context, receipts: z.array(Receipt), pages: z.array(Page),
  reader_observations: z.array(z.object({ region_id: Id, text: z.string(), status: z.literal("unlocalized"), source: z.literal("vl-reader") }).strict()).optional(),
  word_bindings: z.array(z.object({ page_id: Id, page: z.number().int().positive(), id: Id,
    word: z.object({ text: z.string(), bbox: Box.nullable(), conf: z.number().nullable(), disputed: z.boolean() }).strict(),
    sources: z.array(z.object({ region_id: Id, source: z.enum(["ocr", "native"]), index: z.number().int().nonnegative() }).strict()),
  }).strict()).optional(),
  completeness: z.object({ coverage_scope: z.enum(["whole-page-legacy", "regional-full-coverage"]), planned_regions: z.number().int().positive(),
    completed_regions: z.number().int().nonnegative(), mandatory_stages_complete: z.boolean(), publishable: z.boolean(), reasons: z.array(z.string()) }).strict(),
}).strict();
export const PipelineReply = z.object({ context: Context, artifact: Digest, receipt: Receipt, regions: z.array(Region),
  result: Result.nullable(), trace: PipelineTrace.nullable() }).strict();
export type PipelineProgress = z.infer<typeof PipelineReply>;
export type PipelineRunContext = z.infer<typeof Context>;

export type PipelineTransport = (stage: string, body: unknown) => Promise<unknown>;
let transport: PipelineTransport = (stage, body) => mlPost(`/pipeline/v1/${stage}`, body);
export function setPipelineTransportForTests(next: PipelineTransport): void { transport = next; }

export async function runPipeline(runId: string, request: MlRequest, onProgress: (reply: PipelineProgress) => Promise<void>,
  frozen?: PipelineRunContext | null, policy: PipelineRunContext["policy"]["name"] = "legacy-compatible-v1"): Promise<MlResponse> {
  let plan: PipelineProgress;
  const executed: PipelineProgress["receipt"][] = [];
  async function call(stage: string, body: unknown): Promise<PipelineProgress> {
    const parsed = PipelineReply.safeParse(await transport(stage, body));
    if (!parsed.success) throw new MlError(409, "ML: несовместимая схема pipeline.v1");
    const reply = parsed.data;
    if (reply.context.run_id !== runId || reply.context.sha256 !== request.sha256 || reply.receipt.stage !== stage ||
        reply.receipt.output_digest !== reply.artifact || (frozen && !isDeepStrictEqual(reply.context, frozen))) {
      throw new MlError(409, "ML: результат другого запуска, стадии или конфигурации");
    }
    if ((reply.receipt.status === "complete") !== (reply.receipt.reasons.length === 0)) {
      throw new MlError(409, "ML: противоречивый статус стадии");
    }
    executed.push(reply.receipt);
    await onProgress(reply);
    return reply;
  }
  plan = await call("preflight", { run_id: runId, request, policy: frozen?.policy.name ?? policy });
  frozen = plan.context;
  if (!plan.regions.length || new Set(plan.regions.map((r) => r.id)).size !== plan.regions.length) throw new MlError(409, "ML: неполный план областей");
  // Stage 1 deliberately serializes pages; global resource admission follows in stage 3.
  let inputs: string[] = [];
  for (const region of plan.regions) {
    const reply = await call("parse", { context: frozen, plan: plan.artifact, inputs: [], region_id: region.id });
    if (reply.receipt.region_id !== region.id || reply.receipt.status !== "complete") throw new MlError(409, "ML: область не завершена");
    inputs.push(reply.artifact);
  }
  let output = plan;
  for (const stage of ["merge", "extract", "aggregate"]) {
    output = await call(stage, { context: frozen, plan: plan.artifact, inputs, region_id: null });
    inputs = [output.artifact];
  }
  return validatePipelineResult(plan, output, executed);
}

/** The inline and durable coordinators enforce the same publication contract. */
export function validatePipelineResult(plan: PipelineProgress, output: PipelineProgress,
  executed: PipelineProgress["receipt"][]): MlResponse {
  const frozen = plan.context;
  const status = output.trace?.completeness;
  if (!output.trace || !status?.publishable || !status.mandatory_stages_complete || status.reasons.length ||
      status.completed_regions !== plan.regions.length || status.planned_regions !== plan.regions.length ||
      output.receipt.status !== "complete" || !output.result || output.result.sha256 !== frozen.sha256 ||
      !isDeepStrictEqual(output.trace?.context, frozen)) throw new MlError(409, "ML: обязательные стадии не завершены; результат не публикуется");
  // cached describes this invocation, not artifact identity; all other receipt fields must agree.
  const receipts = (items: PipelineProgress["receipt"][]) => items.map(({ cached: _cached, ...item }) => item);
  if (!isDeepStrictEqual(receipts(output.trace.receipts), receipts(executed))) throw new MlError(409, "ML: трасса не соответствует выполненным стадиям");
  const pages = output.trace.pages;
  if (pages.length !== plan.regions.length || pages.some((p, i) => !isDeepStrictEqual(p.region, plan.regions[i]))) throw new MlError(409, "ML: трасса не покрывает план");
  if (pages.some((p) => p.source === "ocr" && (p.quality === "ABSTAIN" ||
      frozen!.policy.required_ocr_engines.some((engine) => !p.engines.includes(engine) ||
        p.execution_failures.some((failure) => failure.startsWith(`${engine}:`)))))) {
    throw new MlError(409, "ML: обязательное чтение OCR не завершено");
  }
  return output.result as MlResponse;
}
