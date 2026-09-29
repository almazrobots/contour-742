// The archive bytes use the existing encrypted filesystem/S3 BlobStore.
// A Python artifact digest identifies canonical content; blobSha256 identifies transport bytes.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { BlobStore } from "./blobstore.ts";
import { mlPost, MlError } from "./ml-client.ts";
import { PipelineReply, type PipelineProgress, type PipelineRunContext } from "./pipeline-client.ts";
import type { CommittedArtifact } from "./stage-jobs.ts";

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Reference = z.object({ context: PipelineReply.shape.context, reference: Digest,
  stage: PipelineReply.shape.receipt.shape.stage }).strict();
const Archive = Reference.extend({ artifact: z.object({ context: PipelineReply.shape.context,
  stage: PipelineReply.shape.receipt.shape.stage, region_id: PipelineReply.shape.receipt.shape.region_id,
  inputs: z.array(Digest), payload: z.record(z.string(), z.unknown()),
  receipts: z.array(PipelineReply.shape.receipt) }).strict() }).strict();
type Transport = (path: string, body: unknown) => Promise<unknown>;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export class StageArtifactStore {
  constructor(private readonly blobs: BlobStore, private readonly transport: Transport = mlPost) {}

  private checked(raw: unknown, context: PipelineRunContext, reference: string, stage: string) {
    const archive = Archive.parse(raw);
    if (archive.reference !== reference || archive.stage !== stage || archive.artifact.stage !== stage ||
        !isDeepStrictEqual(archive.context, context) || !isDeepStrictEqual(archive.artifact.context, context)) {
      throw new MlError(409, "Архив не соответствует стадии или зафиксированному запуску");
    }
    return archive;
  }

  /** Only the returned descriptor may be committed to stage_artifacts. No DB mutation here. */
  async persist(reply: PipelineProgress): Promise<CommittedArtifact> {
    const raw = await this.transport("/pipeline/v1/artifacts/export", {
      context: reply.context, reference: reply.artifact, stage: reply.receipt.stage });
    const archive = this.checked(raw, reply.context, reply.artifact, reply.receipt.stage);
    if (archive.artifact.region_id !== reply.receipt.region_id || !isDeepStrictEqual(archive.artifact.inputs, reply.receipt.input_digests)) {
      throw new MlError(409, "Архив не соответствует квитанции стадии");
    }
    const bytes = Buffer.from(JSON.stringify(archive));
    const blobSha256 = sha256(bytes);
    await this.blobs.put(blobSha256, bytes);
    // Includes encryption tag/content hash checks and catches damaged pre-existing objects.
    const stored = await this.blobs.get(blobSha256);
    if (!stored.equals(bytes)) throw new MlError(409, "Сохранённый архив не прошёл проверку");
    return { artifactDigest: reply.artifact, blobSha256, byteLength: bytes.length,
      schemaVersion: "pipeline.v1", configurationFingerprint: reply.context.configuration_fingerprint };
  }

  async restore(record: CommittedArtifact, context: PipelineRunContext, stage: string): Promise<void> {
    if (record.schemaVersion !== context.schema_version || record.configurationFingerprint !== context.configuration_fingerprint) {
      throw new MlError(409, "Версия или настройки сохранённого артефакта изменились");
    }
    const bytes = await this.blobs.get(record.blobSha256);
    if (bytes.length !== record.byteLength || sha256(bytes) !== record.blobSha256) throw new MlError(409, "Checksum архива не совпадает");
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString("utf8")); }
    catch { throw new MlError(409, "Сохранённый архив содержит некорректный JSON"); }
    const archive = this.checked(raw, context, record.artifactDigest, stage);
    // Python revalidates its canonical digest and payload; this never executes OCR.
    const restored = Reference.parse(await this.transport("/pipeline/v1/artifacts/restore", archive));
    if (!isDeepStrictEqual(restored, { context, reference: record.artifactDigest, stage })) {
      throw new MlError(409, "ML не подтвердил восстановление запрошенного архива");
    }
  }
}
