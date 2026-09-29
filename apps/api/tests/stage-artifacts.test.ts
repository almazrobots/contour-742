import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeKeyring, isEncryptedBlob } from "../src/domain/at-rest.ts";
import { FsBlobStore, LocalAtRest } from "../src/services/blobstore.ts";
import { StageArtifactStore } from "../src/services/stage-artifacts.ts";
import type { PipelineProgress } from "../src/services/pipeline-client.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "stage-artifacts-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const sha = "a".repeat(64), ref = "b".repeat(64);
function sample() {
  const context = { schema_version: "pipeline.v1" as const, run_id: randomUUID(), sha256: sha,
    configuration: { profile: "test" }, configuration_fingerprint: sha, request_fingerprint: sha,
    policy: { name: "legacy-compatible-v1" as const, required_ocr_engines: [], require_judge: false, coverage: "whole-page-legacy" as const } };
  const receipt = { stage: "preflight" as const, region_id: null, input_digests: [sha], output_digest: ref,
    status: "complete" as const, reasons: [], cached: false };
  const reply: PipelineProgress = { context, artifact: ref, receipt, regions: [], result: null, trace: null };
  const archive = { context, reference: ref, stage: receipt.stage,
    artifact: { context, stage: receipt.stage, region_id: null, inputs: [sha], payload: { synthetic: "PRIVATE_TRANSCRIPTION" }, receipts: [] } };
  return { reply, archive };
}

describe("T-238: archives in existing protected BlobStore", () => {
  it("encrypted immutable bytes survive a new store instance and restore the exact reference", async () => {
    const { reply, archive } = sample();
    const calls: string[] = [];
    const ring = makeKeyring(Buffer.alloc(32, 7));
    const blobs = () => new FsBlobStore(dir, undefined, new LocalAtRest({ keyring: ring }));
    const transport = async (path: string, body: unknown) => {
      calls.push(path);
      if (path.endsWith("export")) return archive;
      expect(body).toEqual(archive);
      return { context: archive.context, reference: archive.reference, stage: archive.stage };
    };
    const store = new StageArtifactStore(blobs(), transport);
    const record = await store.persist(reply);
    const encrypted = readFileSync(join(dir, record.blobSha256));
    expect(isEncryptedBlob(encrypted)).toBe(true);
    expect(encrypted.includes(Buffer.from("PRIVATE_TRANSCRIPTION"))).toBe(false);
    expect(await store.persist(reply)).toEqual(record);
    expect(readFileSync(join(dir, record.blobSha256))).toEqual(encrypted);
    await new StageArtifactStore(blobs(), transport).restore(record, reply.context, "preflight");
    expect(calls.filter((p) => p.endsWith("restore"))).toHaveLength(1);
  });

  it.each(["missing", "corrupt", "size", "config"])("refuses %s before contacting ML restore", async (damage) => {
    const { reply, archive } = sample();
    let restores = 0;
    const store = new StageArtifactStore(new FsBlobStore(dir), async (path) => {
      if (path.endsWith("restore")) restores++;
      return archive;
    });
    const record = await store.persist(reply);
    if (damage === "missing") rmSync(join(dir, record.blobSha256));
    if (damage === "corrupt") writeFileSync(join(dir, record.blobSha256), "corrupted");
    if (damage === "size") record.byteLength++;
    if (damage === "config") record.configurationFingerprint = ref;
    await expect(store.restore(record, reply.context, "preflight")).rejects.toThrow();
    expect(restores).toBe(0);
  });

  it("rejects a foreign export and does not treat failed atomic rename as durable", async () => {
    const { reply, archive } = sample();
    const foreign = { ...archive, reference: sha };
    await expect(new StageArtifactStore(new FsBlobStore(dir), async () => foreign).persist(reply)).rejects.toThrow("не соответствует");
    const broken = new FsBlobStore(dir, () => { throw Error("disk write failed"); });
    await expect(new StageArtifactStore(broken, async () => archive).persist(reply)).rejects.toThrow("disk write failed");
  });
});


it("diagnoses invalid archive JSON even when its transport checksum is valid", async () => {
  const { reply } = sample();
  const blobs = new FsBlobStore(dir);
  const bytes = Buffer.from("not JSON");
  const blobSha256 = createHash("sha256").update(bytes).digest("hex");
  await blobs.put(blobSha256, bytes);
  let contacted = false;
  const store = new StageArtifactStore(blobs, async () => { contacted = true; return {}; });
  await expect(store.restore({ artifactDigest: ref, blobSha256, byteLength: bytes.length,
    schemaVersion: "pipeline.v1", configurationFingerprint: reply.context.configuration_fingerprint },
    reply.context, "preflight")).rejects.toMatchObject({ status: 409 });
  expect(contacted).toBe(false);
});
